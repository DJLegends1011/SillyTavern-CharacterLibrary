#!/usr/bin/env node
/**
 * Runs a browser here and publishes its DevTools port, for when the one Character Library starts
 * for itself cannot clear Cloudflare (usually the SillyTavern host has no usable GPU). The browser
 * needs a REAL GPU; software rendering never clears the challenge.
 *
 * A reference implementation, not the only one: Character Library speaks plain CDP, so a bare
 * `chrome --remote-debugging-port`, browserless, or your own container all work.
 *
 *   node run-browser.mjs
 *
 * Paste the URL it prints into Settings > Online > JanitorAI > Browser Endpoint. Node 22+, no deps.
 *
 * Options (env):
 *   PORT=9222          port to publish on
 *   BIND=0.0.0.0       interface to publish on; use 127.0.0.1 to keep it local
 *   PROFILE=<path>     profile dir (default: ./.janitorai-profile next to this script)
 *   BROWSER=<path>     explicit browser binary
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Otherwise the first symptom is a bare "WebSocket is not defined" from deep in the CDP client.
if (Number(process.versions.node.split('.')[0]) < 22) {
    console.error(`Node ${process.versions.node} is too old. This needs Node 22 or newer (it uses the built-in WebSocket).`);
    process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 9222);
const BIND = process.env.BIND || '0.0.0.0';
const CHROME_PORT = PORT + 1;                    // chrome stays on loopback; the relay publishes
const PROFILE = process.env.PROFILE || path.join(HERE, '.janitorai-profile');

// ---------------------------------------------------------------- find a browser
function candidates() {
    const out = [];
    if (process.env.BROWSER) out.push(process.env.BROWSER);
    // Newest build first: several playwright chromiums often coexist and readdir order is not
    // version order.
    const glob = (dir, re, tail) => {
        try {
            fs.readdirSync(dir)
                .filter(d => re.test(d))
                .sort((a, b) => (parseInt(b.match(/\d+/)[0], 10) - parseInt(a.match(/\d+/)[0], 10)))
                .forEach(d => out.push(path.join(dir, d, ...tail)));
        } catch { /* not present */ }
    };
    if (process.platform === 'win32') {
        glob(path.join(os.homedir(), 'AppData/Local/ms-playwright'), /^chromium-\d+$/, ['chrome-win64', 'chrome.exe']);
        out.push('C:/Program Files/Google/Chrome/Application/chrome.exe',
                 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
                 path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
                 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
                 'C:/Program Files/Microsoft/Edge/Application/msedge.exe');
    } else if (process.platform === 'darwin') {
        glob(path.join(os.homedir(), 'Library/Caches/ms-playwright'), /^chromium-\d+$/, ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']);
        out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                 '/Applications/Chromium.app/Contents/MacOS/Chromium');
    } else {
        glob('/ms-playwright', /^chromium-\d+$/, ['chrome-linux', 'chrome']);
        glob(path.join(os.homedir(), '.cache/ms-playwright'), /^chromium-\d+$/, ['chrome-linux', 'chrome']);
        out.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
    }
    return out;
}

const BROWSER = candidates().find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!BROWSER) {
    console.error('No Chrome/Chromium found. Install Chrome, or set BROWSER=/path/to/chrome');
    process.exit(1);
}

// ---------------------------------------------------------------- user agent
// Headless reports "HeadlessChrome/<ver>", which janitorai answers with "Access Restricted", so
// the token is stripped. The version must stay honest, since --user-agent does not touch Sec-CH-UA.
// The probe port is ephemeral: a fixed one can be held by an unrelated Chrome, whose UA we'd wear.
async function reserve(port) {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.once('listening', () => s.close(() => resolve(true)));
        s.listen(port, '127.0.0.1');
    });
}

async function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

async function probeUserAgent() {
    const probePort = await freePort();
    const probeProfile = path.join(os.tmpdir(), `cl-ua-probe-${process.pid}-${probePort}`);
    const proc = spawn(BROWSER, [
        '--headless=new', `--remote-debugging-port=${probePort}`,
        `--user-data-dir=${probeProfile}`, '--no-first-run', 'about:blank',
    ], { stdio: 'ignore' });

    let exited = false;
    proc.once('exit', () => { exited = true; });
    // A failed spawn (missing or non-executable binary) emits 'error', never 'exit'.
    proc.once('error', () => { exited = true; });

    try {
        for (let i = 0; i < 24; i++) {
            await new Promise(r => setTimeout(r, 500));
            if (exited) return null;              // it died; anything on that port is not ours
            try {
                const info = await (await fetch(`http://127.0.0.1:${probePort}/json/version`)).json();
                const ua = String(info['User-Agent'] || '');
                if (ua) return { ua: ua.replace(/Headless/g, ''), browser: String(info.Browser || '') };
            } catch { /* not up yet */ }
        }
    } finally {
        try { proc.kill(); } catch {}
        await new Promise(r => setTimeout(r, 500));
        try { fs.rmSync(probeProfile, { recursive: true, force: true }); } catch {}
    }
    return null;
}

// ---------------------------------------------------------------- relay
// Chrome ignores --remote-debugging-address since M113 and always binds CDP to loopback, so
// nothing off-box reaches it without this. It also rejects a Host header that is neither an IP
// nor localhost, hence the rewrite.
function startRelay() {
    const server = net.createServer((client) => {
        client.on('error', () => client.destroy());
        const upstream = net.connect(CHROME_PORT, '127.0.0.1');
        upstream.on('error', () => client.destroy());
        let buf = Buffer.alloc(0);
        let piped = false;
        const onData = (chunk) => {
            if (piped) return;
            buf = Buffer.concat([buf, chunk]);
            const end = buf.indexOf('\r\n\r\n');
            if (end === -1) {
                if (buf.length > 65536) { piped = true; client.off('data', onData); upstream.write(buf); client.pipe(upstream); }
                return;
            }
            piped = true;
            client.off('data', onData);
            const headRaw = buf.subarray(0, end).toString('latin1');
            // Browsers always send Origin on WebSocket upgrades; CDP clients (cl-helper's Node
            // WebSocket included) never do. Dropping it keeps the published port programmatic-only.
            if (/^Origin:/im.test(headRaw)) { client.destroy(); upstream.destroy(); return; }
            const head = headRaw.replace(/^Host:.*$/im, `Host: 127.0.0.1:${CHROME_PORT}`);
            upstream.write(Buffer.concat([Buffer.from(head, 'latin1'), buf.subarray(end)]));
            client.pipe(upstream);
        };
        client.on('data', onData);
        upstream.pipe(client);
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
    });
    server.on('error', (e) => { console.error(`relay failed: ${e.message}`); process.exit(1); });
    server.listen(PORT, BIND);
    return server;
}

// ---------------------------------------------------------------- launch
fs.mkdirSync(PROFILE, { recursive: true });
for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.rmSync(path.join(PROFILE, f), { force: true }); } catch {}
}

// Refuse to start on an occupied port instead of half-working against someone else's browser.
for (const [port, what] of [[PORT, 'publish port'], [CHROME_PORT, 'internal browser port']]) {
    if (!await reserve(port)) {
        console.error(`Port ${port} (${what}) is already in use. Stop whatever holds it, or set PORT=<other>.`);
        process.exit(1);
    }
}

process.stdout.write('reading the browser user-agent... ');
const probed = await probeUserAgent();
let ua = probed?.ua || null;

// A UA naming a different Chrome than the browser that produced it means the probe hit something
// else; drop it rather than ship the mismatch.
if (probed) {
    const uaMajor = (probed.ua.match(/Chrome\/(\d+)/) || [])[1];
    const realMajor = (probed.browser.match(/(\d+)/) || [])[1];
    if (uaMajor && realMajor && uaMajor !== realMajor) {
        console.log(`MISMATCH (ua says ${uaMajor}, browser is ${realMajor}) - ignoring it`);
        ua = null;
    } else {
        console.log(`ok (Chrome ${realMajor || '?'})`);
    }
} else {
    console.log('FAILED (will run with the default UA)');
}

const flags = [
    '--headless=new',
    `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-networking',
    '--password-store=basic',
    '--use-mock-keychain',
    '--window-size=1280,900',
];
if (ua) flags.push(`--user-agent=${ua}`);

console.log(`browser : ${BROWSER}`);
console.log(`profile : ${PROFILE}`);
console.log(`user-agent: ${ua || '(browser default, the UA probe did not answer)'}`);

const child = spawn(BROWSER, [...flags, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
child.stderr.on('data', (d) => {
    const s = String(d);
    if (/error|fatal/i.test(s) && !/WebGL|gcm|GCM|DEPRECATED_ENDPOINT|stun|dbus|D-Bus|Vulkan|gpu/i.test(s)) process.stderr.write(s);
});
child.on('exit', (code) => { console.error(`\nbrowser exited (${code})`); process.exit(code ?? 1); });
child.once('error', (e) => { console.error(`could not launch ${BROWSER}: ${e.message}`); process.exit(1); });

const relay = startRelay();
const shutdown = () => { try { child.kill(); } catch {} try { relay.close(); } catch {} process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------- confirm + report
await new Promise(r => setTimeout(r, 3000));
let info = null;
for (let i = 0; i < 15 && !info; i++) {
    try { info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); }
    catch { await new Promise(r => setTimeout(r, 1000)); }
}
if (!info) {
    console.error('browser did not come up on the debugging port');
    try { child.kill(); } catch {}
    try { relay.close(); } catch {}
    process.exit(1);
}

const addrs = Object.values(os.networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);

console.log(`\nrunning ${info.Browser}`);
console.log(`reports : ${info['User-Agent']}`);

// Both of these fail silently at janitorai, so say so rather than look like a clean start.
const finalUaMajor = (String(info['User-Agent'] || '').match(/Chrome\/(\d+)/) || [])[1];
const finalRealMajor = (String(info.Browser || '').match(/(\d+)/) || [])[1];
if (/headless/i.test(info['User-Agent'] || '')) {
    console.log('\nWARNING: the user-agent still says HeadlessChrome, and JanitorAI answers that');
    console.log('         with "Access Restricted". The UA probe did not succeed.');
} else if (finalUaMajor && finalRealMajor && finalUaMajor !== finalRealMajor) {
    console.log(`\nWARNING: the user-agent claims Chrome ${finalUaMajor} but this browser is Chrome ${finalRealMajor}.`);
    console.log('         Cloudflare reads the real version from Sec-CH-UA, so this is a mismatch.');
} else {
    console.log(`checks  : user-agent and browser both report Chrome ${finalRealMajor || '?'}`);
}
console.log('\nPaste ONE of these into Character Library (Settings > Online > JanitorAI):');
console.log(`  http://localhost:${PORT}          (SillyTavern on this machine)`);
for (const a of addrs) console.log(`  http://${a}:${PORT}${' '.repeat(Math.max(0, 14 - a.length))} (SillyTavern elsewhere on the LAN)`);

// The CDP port is unauthenticated and is full control of a logged-in browser. Warn only when it
// is reachable off-box, and not when the user already limited it to loopback.
if (BIND !== '127.0.0.1' && BIND !== 'localhost') {
    console.log('\nNote: this endpoint has no password and is bound to every interface, so anyone on');
    console.log('your network can drive this browser and read its JanitorAI session. Fine on a home');
    console.log('network you trust. To keep it to this machine, run with BIND=127.0.0.1 (only works');
    console.log('when SillyTavern is on this machine too).');
}
console.log('\nLeave this running. Ctrl+C to stop.');
