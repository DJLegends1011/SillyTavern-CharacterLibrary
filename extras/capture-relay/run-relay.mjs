#!/usr/bin/env node
/**
 * Capture relay for Character Library: a public address a site's SERVER can send its chat
 * prompt to, when the machine running SillyTavern has no public address of its own.
 *
 * Some sites (Harpy, Saucepan) build the prompt on their server and POST it to the custom
 * OpenAI-compatible endpoint you configure there. Character Library points that endpoint at
 * this relay, which answers like a model ("CL_CAPTURE_OK"), keeps the request briefly, and
 * hands it back to cl-helper, which polls for it with the relay key. Nothing else is stored.
 *
 * A reference implementation, not the only one: the protocol is four plain HTTP routes (see
 * README.md), so a Cloudflare Worker or anything else that speaks them works just as well.
 *
 *   node run-relay.mjs
 *
 * Paste the URL and relay key it prints into Settings > Online > Harpy > Capture receiver
 * (mode "Relay"). Node 22+, no deps. Put it behind HTTPS: sites may refuse a plain-http endpoint.
 *
 * Options (env):
 *   PORT=8787            port to listen on
 *   BIND=0.0.0.0         interface; 127.0.0.1 when a reverse proxy on this host terminates TLS
 *   RELAY_KEY=<secret>   key cl-helper must present to read captures (default: random, printed)
 *   PUBLIC_URL=<url>     the address to print as the one to paste (your HTTPS hostname)
 *   TTL_SECONDS=300      how long an unread capture is kept
 *   MAX_SLOTS=64         captures held at once; the oldest is dropped past this
 */

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

if (Number(process.versions.node.split('.')[0]) < 22) {
    console.error(`Node ${process.versions.node} is too old. This needs Node 22 or newer.`);
    process.exit(1);
}

const PORT = Number(process.env.PORT || 8787);
const BIND = process.env.BIND || '0.0.0.0';
const RELAY_KEY = (process.env.RELAY_KEY || '').trim() || randomBytes(24).toString('base64url');
const TTL_MS = Number(process.env.TTL_SECONDS || 300) * 1000;
const MAX_SLOTS = Number(process.env.MAX_SLOTS || 64);
const MAX_BODY = 4 * 1024 * 1024;
const REPLY = 'CL_CAPTURE_OK';
const VERSION = '1.0.0';

// Slots are cl-helper's 32-byte random hex; anything else is a stranger probing paths
const SLOT_RE = /^[0-9a-f]{64}$/;

// A few requests per slot: anyone can POST to a slot, so a stray request must not crowd out
// the site's. cl-helper reads them in order and keeps the one carrying its own API key.
const PER_SLOT = 4;

/** @type {Map<string, Array<{body: string, apiKey: string|null, receivedAt: number}>>} */
const captures = new Map();

function sweep() {
    const cutoff = Date.now() - TTL_MS;
    for (const [slot, list] of captures) if (list[0].receivedAt < cutoff) captures.delete(slot);
}
setInterval(sweep, 30000).unref();

function keyOk(header) {
    const want = Buffer.from(`Bearer ${RELAY_KEY}`);
    const got = Buffer.from(String(header || ''));
    return got.length === want.length && timingSafeEqual(got, want);
}

function json(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
}

function reply(res, body) {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch {}
    const id = `chatcmpl-${randomBytes(6).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    const model = typeof parsed.model === 'string' ? parsed.model.slice(0, 64) : 'cl-capture';
    if (parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.write(chunk({ role: 'assistant', content: REPLY }));
        res.write(chunk({}, 'stop'));
        res.end('data: [DONE]\n\n');
        return;
    }
    json(res, 200, {
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
    });
}

const server = createServer((req, res) => {
    const path = String(req.url || '').split('?')[0];

    if (req.method === 'GET' && path === '/health') {
        json(res, 200, { ok: true, relay: 'cl-capture-relay', version: VERSION });
        return;
    }

    // Site side: /c/<slot>/v1/models and /c/<slot>/v1/chat/completions
    const site = path.match(/^\/c\/([^/]+)\/v1\/(models|chat\/completions)$/);
    if (site) {
        const [, slot, route] = site;
        if (!SLOT_RE.test(slot)) { res.writeHead(404).end(); return; }
        if (route === 'models' && req.method === 'GET') {
            json(res, 200, { object: 'list', data: [{ id: 'cl-capture', object: 'model', owned_by: 'character-library' }] });
            return;
        }
        if (route !== 'chat/completions' || req.method !== 'POST') { res.writeHead(405).end(); return; }
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) { req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            reply(res, body);
            sweep();
            const list = captures.get(slot) || [];
            if (list.length >= PER_SLOT) return;
            if (!list.length) {
                while (captures.size >= MAX_SLOTS) captures.delete(captures.keys().next().value);
                captures.set(slot, list);
            }
            const auth = String(req.headers.authorization || '');
            list.push({ body, apiKey: auth.startsWith('Bearer ') ? auth.slice(7) : null, receivedAt: Date.now() });
        });
        return;
    }

    // cl-helper side: /api/capture/<slot>, relay key required
    const api = path.match(/^\/api\/capture\/([^/]+)$/);
    if (api) {
        if (!keyOk(req.headers.authorization)) { json(res, 401, { error: 'bad relay key' }); return; }
        const slot = api[1];
        if (!SLOT_RE.test(slot)) { json(res, 404, { error: 'unknown slot' }); return; }
        if (req.method === 'DELETE') { captures.delete(slot); res.writeHead(204).end(); return; }
        if (req.method !== 'GET') { res.writeHead(405).end(); return; }
        const list = captures.get(slot);
        if (!list?.length) { res.writeHead(204, { 'cache-control': 'no-store' }).end(); return; }
        const c = list.shift(); // each request is read once, oldest first
        if (!list.length) captures.delete(slot);
        json(res, 200, c);
        return;
    }

    res.writeHead(404).end();
});

server.on('error', (e) => { console.error(`relay failed: ${e.message}`); process.exit(1); });
server.listen(PORT, BIND, () => {
    const shown = (process.env.PUBLIC_URL || '').trim() || `http://<this host>:${PORT}`;
    console.log(`Character Library capture relay ${VERSION} listening on ${BIND}:${PORT}`);
    console.log('');
    console.log(`  Relay URL:  ${shown}`);
    console.log(`  Relay key:  ${RELAY_KEY}`);
    console.log('');
    console.log('Paste both into Settings > Online > Harpy > Capture receiver (mode "Relay"), then press Test.');
    if (!process.env.RELAY_KEY) console.log('The key is random each start; set RELAY_KEY to keep it stable.');
    if (!/^https:/i.test(shown)) console.log('Serve it over HTTPS (a reverse proxy or a named tunnel): sites may refuse plain http.');
});

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
