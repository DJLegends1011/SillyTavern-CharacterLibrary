import test from 'node:test';
import assert from 'node:assert/strict';

function installNoBridgeWindow() {
    globalThis.window = {
        location: { origin: 'http://127.0.0.1:8001' },
        addEventListener() {},
        postMessage() {},
    };
    globalThis.document = {};
}

async function loadJannyApi() {
    const tag = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await import(`../modules/core-api.js?public_no_bridge=${tag}`);
    return import(`../modules/providers/janny/janny-api.js?public_no_bridge=${tag}`);
}

test('fetchJannyPublicCollections falls back to direct page fetch when the bridge is absent', async () => {
    installNoBridgeWindow();
    let seenUrl = '';
    globalThis.fetch = async (url, options = {}) => {
        seenUrl = String(url);
        assert.equal(options.headers.Accept, 'text/html,application/xhtml+xml');
        return {
            ok: true,
            status: 200,
            url: String(url),
            text: async () => '<a href="/collections/dddddddd-4444-4444-8444-444444444444_cool"><h3>Cool (12 characters)</h3></a>',
        };
    };

    const api = await loadJannyApi();
    const data = await api.fetchJannyPublicCollections({ sort: 'latest', page: 2 });

    assert.equal(seenUrl, 'https://jannyai.com/collections?sort=latest&page=2');
    assert.equal(data.ok, true);
    assert.equal(data.status, 200);
    assert.equal(data.collections.length, 1);
    assert.equal(data.collections[0].id, 'dddddddd-4444-4444-8444-444444444444');
});
