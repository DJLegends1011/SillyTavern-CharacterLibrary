import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal same-origin window shim: postMessage loops back to listeners asynchronously,
// exactly like the real page<->userscript channel.
function makeFakeWindow() {
    const listeners = [];
    const win = {
        location: { origin: 'http://127.0.0.1:8001' },
        addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
        postMessage(data, _origin) {
            queueMicrotask(() => { for (const fn of [...listeners]) fn({ data, origin: win.location.origin }); });
        },
    };
    return win;
}

globalThis.window = makeFakeWindow();
const { initJannyBridge, isJannyBridgeAvailable, refreshJannyBridgeAvailability, jannyBridgeFetch } =
    await import('../modules/providers/janny/janny-bridge.js');

// Acts as the userscript side. One listener, one swappable fetch handler — repeated
// installs must NOT stack listeners or earlier tests' handlers would also fire (and an
// assert inside a stacked handler would throw as an unhandled microtask rejection).
let fetchHandler = null;
let listenerInstalled = false;
let pingCount = 0;
function installFakeUserscript(handler) {
    fetchHandler = handler;
    if (listenerInstalled) return;
    listenerInstalled = true;
    window.addEventListener('message', (e) => {
        const msg = e.data;
        if (!msg || msg.source !== 'character-library-janny') return;
        if (msg.type === 'ping') {
            pingCount++;
            window.postMessage({ source: 'cl-janny-bridge', type: 'ready' }, window.location.origin);
            return;
        }
        if (msg.type === 'fetch' && fetchHandler) fetchHandler(msg);
    });
    // The real userscript announces on load; do the same so the bridge (which already
    // pinged before this listener existed) learns we are here.
    window.postMessage({ source: 'cl-janny-bridge', type: 'ready' }, window.location.origin);
}

test('bridge reports unavailable before handshake and rejects fetches', async () => {
    initJannyBridge();
    assert.equal(await refreshJannyBridgeAvailability(), false);
    assert.equal(isJannyBridgeAvailable(), false);
    await assert.rejects(
        jannyBridgeFetch('GET', 'https://jannyai.com/api/bookmark'),
        /not available/,
    );
});

test('handshake marks the bridge available and round-trips a fetch', async () => {
    let seen = null;
    installFakeUserscript((msg) => {
        seen = msg;
        window.postMessage({
            source: 'cl-janny-bridge', type: 'result', id: msg.id,
            ok: true, status: 200, body: '{"bookmarks":[]}', finalUrl: msg.url,
        }, window.location.origin);
    });
    await new Promise(r => setTimeout(r, 0)); // let the fake userscript's ready land
    assert.equal(isJannyBridgeAvailable(), true);

    const res = await jannyBridgeFetch('GET', 'https://jannyai.com/api/bookmark');
    assert.equal(seen.method, 'GET');
    assert.equal(seen.url, 'https://jannyai.com/api/bookmark');
    assert.deepEqual(res, { ok: true, status: 200, body: '{"bookmarks":[]}', finalUrl: 'https://jannyai.com/api/bookmark' });
});

test('fetch forwards body and contentType for writes', async () => {
    let seen = null;
    installFakeUserscript((msg) => {
        seen = msg;
        window.postMessage({ source: 'cl-janny-bridge', type: 'result', id: msg.id, ok: true, status: 200, body: '{}', finalUrl: '' }, window.location.origin);
    });
    await jannyBridgeFetch('POST', 'https://jannyai.com/api/bookmark', {
        body: '{"characterIDs":["x"]}', contentType: 'application/json', authToken: 'saved-token',
    });
    assert.equal(seen.body, '{"characterIDs":["x"]}');
    assert.equal(seen.contentType, 'application/json');
    assert.equal(seen.authToken, 'saved-token');
});

test('replies from unknown sources are ignored', async () => {
    installFakeUserscript((msg) => {
        // Wrong source first (must be ignored), then the real reply.
        window.postMessage({ source: 'cl-janitor-bridge', type: 'result', id: msg.id, ok: false, status: 500, body: 'wrong' }, window.location.origin);
        window.postMessage({ source: 'cl-janny-bridge', type: 'result', id: msg.id, ok: true, status: 200, body: 'right', finalUrl: '' }, window.location.origin);
    });
    const res = await jannyBridgeFetch('GET', 'https://jannyai.com/api/collections/mine');
    assert.equal(res.body, 'right');
});

test('initJannyBridge exposes window.clJannyBridge for the settings UI', () => {
    assert.equal(typeof window.clJannyBridge?.isAvailable, 'function');
    assert.equal(typeof window.clJannyBridge?.refresh, 'function');
    assert.equal(typeof window.clJannyBridge?.request, 'function');
    assert.equal(window.clJannyBridge.isAvailable(), true);
});

test('refresh re-pings the userscript and reports a fresh handshake', async () => {
    const before = pingCount;
    assert.equal(await refreshJannyBridgeAvailability(), true);
    assert.equal(pingCount, before + 1);
});
