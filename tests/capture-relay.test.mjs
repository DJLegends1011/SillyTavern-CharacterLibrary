// node --test tests/capture-relay.test.mjs
// Offline: a local relay plus cl-helper's capture channel in relay mode, and the bare listener.
// Tunnels (localhost.run, cloudflared) need the internet and are not exercised here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const helper = await import(`file://${join(ROOT, 'extras', 'cl-helper', 'index.js').replace(/\\/g, '/')}`);

const PORT = 18000 + Math.floor(Math.random() * 1000);
const RELAY = `http://127.0.0.1:${PORT}`;
const KEY = 'test-relay-key';
let relay;

before(async () => {
    relay = spawn(process.execPath, [join(ROOT, 'extras', 'capture-relay', 'run-relay.mjs')], {
        env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1', RELAY_KEY: KEY },
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise(r => relay.stdout.once('data', r));
});
after(() => relay?.kill());

const prompt = JSON.stringify({ model: 'cl-capture', stream: true, messages: [{ role: 'system', content: '# Scenario\nrainy ✨' }] });
const send = (url, key, body = prompt) => fetch(`${url}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` }, body,
});

test('relay mode: the site-side POST comes back intact and the reply looks like a model', async () => {
    const ch = await helper.openCaptureChannel({ mode: 'relay', relayUrl: `${RELAY}/`, relayKey: KEY, timeoutMs: 5000 });
    assert.equal(ch.kind, 'relay');
    const models = await fetch(`${ch.baseUrl}/models`).then(r => r.json());
    assert.equal(models.data[0].id, 'cl-capture');
    const r = await send(ch.baseUrl, ch.apiKey);
    assert.match(await r.text(), /CL_CAPTURE_OK/);
    assert.equal((await ch.waitForCapture()).body, prompt);
    await ch.close();
});

test('relay mode: a stranger posting first does not displace the real prompt', async () => {
    const ch = await helper.openCaptureChannel({ mode: 'relay', relayUrl: RELAY, relayKey: KEY, timeoutMs: 5000 });
    await (await send(ch.baseUrl, 'not-the-key', '{"junk":true}')).text();
    await (await send(ch.baseUrl, ch.apiKey)).text();
    assert.equal((await ch.waitForCapture()).body, prompt);
    await ch.close();
});

test('relay mode: a wrong relay key is reported, not waited out', async () => {
    const ch = await helper.openCaptureChannel({ mode: 'relay', relayUrl: RELAY, relayKey: 'wrong', timeoutMs: 5000 });
    await assert.rejects(ch.waitForCapture(), /rejected the relay key/);
    await ch.close();
});

test('relay rejects malformed slots and non-relay URLs are refused', async () => {
    assert.equal((await fetch(`${RELAY}/c/not-hex/v1/models`)).status, 404);
    assert.equal((await fetch(`${RELAY}/api/capture/${'a'.repeat(64)}`)).status, 401);
    await assert.rejects(helper.openCaptureChannel({ mode: 'relay', relayUrl: 'http://127.0.0.1:1', relayKey: KEY }), /No capture relay answered/);
});

test('local listener: wrong API key is refused, the right one is captured', async () => {
    const l = helper.createCaptureListener({ timeoutMs: 5000 });
    const port = await l.ready;
    const base = `http://127.0.0.1:${port}${l.base}`;
    assert.equal((await send(base, 'nope')).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/capture/other/v1/models`)).status, 404);
    await (await send(base, l.apiKey)).text();
    assert.equal((await l.waitForCapture()).body, prompt);
    await l.close();
});
