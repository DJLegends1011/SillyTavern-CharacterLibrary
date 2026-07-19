import test from 'node:test';
import assert from 'node:assert/strict';

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

// Warm up the shared provider module graph via its real entry point (core-api.js) first.
// Importing janny-api.js as the very first module in the graph hits a pre-existing
// circular-import TDZ (provider-utils.js -> core-api.js -> provider-registry.js ->
// browse-view.js -> botbooru-api.js -> provider-utils.js) that only manifests when the
// entry point isn't core-api.js; this bug predates this branch and is out of scope here.
await import('../modules/core-api.js');

const { initJannyBridge } = await import('../modules/providers/janny/janny-bridge.js');
const api = await import('../modules/providers/janny/janny-api.js');

// Fake userscript: routes each allowed fetch through `routes`, a map of
// `${METHOD} ${pathname}` -> (url, msg) => partial result.
const routes = new Map();
window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.source !== 'character-library-janny') return;
    if (msg.type === 'ping') {
        window.postMessage({ source: 'cl-janny-bridge', type: 'ready' }, window.location.origin);
        return;
    }
    if (msg.type !== 'fetch') return;
    const url = new URL(msg.url);
    const handler = routes.get(`${msg.method.toUpperCase()} ${url.pathname}`);
    const result = handler
        ? handler(url, msg)
        : { ok: false, status: 404, body: 'no route' };
    window.postMessage({ source: 'cl-janny-bridge', type: 'result', id: msg.id, finalUrl: msg.url, ...result }, window.location.origin);
});
initJannyBridge();
await new Promise(r => setTimeout(r, 0));

test('fetchJannyBookmarks maps entry objects to ids', async () => {
    routes.set('GET /api/bookmark', () => ({
        ok: true, status: 200,
        body: JSON.stringify({ bookmarks: [{ characterId: 'aaaaaaaa-1111-4111-8111-111111111111' }, 'bbbbbbbb-2222-4222-8222-222222222222'] }),
    }));
    assert.deepEqual(await api.fetchJannyBookmarks(), [
        'aaaaaaaa-1111-4111-8111-111111111111',
        'bbbbbbbb-2222-4222-8222-222222222222',
    ]);
});

test('addJannyBookmarks POSTs a JSON characterIDs body', async () => {
    let seen = null;
    routes.set('POST /api/bookmark', (_url, msg) => {
        seen = msg;
        return { ok: true, status: 200, body: '{"bookmarks":[]}' };
    });
    await api.addJannyBookmarks(['aaaaaaaa-1111-4111-8111-111111111111']);
    assert.equal(seen.contentType, 'application/json');
    assert.deepEqual(JSON.parse(seen.body), { characterIDs: ['aaaaaaaa-1111-4111-8111-111111111111'] });
});

test('removeJannyBookmarks DELETEs with an ids query', async () => {
    let seenUrl = null;
    routes.set('DELETE /api/bookmark', (url) => {
        seenUrl = url;
        return { ok: true, status: 200, body: '{"bookmarks":[]}' };
    });
    await api.removeJannyBookmarks(['aaaaaaaa-1111-4111-8111-111111111111']);
    assert.equal(seenUrl.searchParams.get('ids'), 'aaaaaaaa-1111-4111-8111-111111111111');
});

test('createJannyCollection form-POSTs and extracts the new id from finalUrl', async () => {
    let seen = null;
    routes.set('POST /collections/form/add-collection', (_url, msg) => {
        seen = msg;
        return {
            ok: true, status: 200, body: '<html>edit page</html>',
            finalUrl: 'https://jannyai.com/collections/cccccccc-3333-4333-8333-333333333333_my-set/edit',
        };
    });
    const result = await api.createJannyCollection({ name: 'My Set', description: 'd', isPrivate: true });
    assert.equal(seen.contentType, 'application/x-www-form-urlencoded');
    assert.equal(new URLSearchParams(seen.body).get('isPrivate'), 'yes');
    assert.equal(result.id, 'cccccccc-3333-4333-8333-333333333333');
    assert.equal(result.success, true);
});

test('a 401 surfaces JANNY_LOGIN_REQUIRED', async () => {
    routes.set('GET /api/collections/mine', () => ({ ok: false, status: 401, body: '{"error":"unauthorized"}' }));
    await assert.rejects(api.fetchJannyCollections(), (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.code, 'JANNY_LOGIN_REQUIRED');
        return true;
    });
});

test('probeJannyAccount distinguishes logged-in from logged-out', async () => {
    routes.set('GET /api/bookmark', () => ({ ok: true, status: 200, body: '{"bookmarks":[]}' }));
    assert.deepEqual(await api.probeJannyAccount(), { bridge: true, active: true, cloudflare: false, reason: '' });

    routes.set('GET /api/bookmark', () => ({ ok: false, status: 401, body: '{}' }));
    const out = await api.probeJannyAccount();
    assert.equal(out.bridge, true);
    assert.equal(out.active, false);
});

test('fetchJannyPublicCollections parses the HTML page client-side', async () => {
    routes.set('GET /collections', (url) => {
        assert.equal(url.searchParams.get('sort'), 'latest');
        assert.equal(url.searchParams.get('page'), '2');
        return {
            ok: true, status: 200,
            body: '<a href="/collections/dddddddd-4444-4444-8444-444444444444_cool"><h3>Cool (12 characters)</h3></a>',
        };
    });
    const data = await api.fetchJannyPublicCollections({ sort: 'latest', page: 2 });
    assert.equal(data.ok, true);
    assert.equal(data.collections.length, 1);
    assert.equal(data.collections[0].id, 'dddddddd-4444-4444-8444-444444444444');
});
