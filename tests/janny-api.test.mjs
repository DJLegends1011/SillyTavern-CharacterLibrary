import assert from 'node:assert/strict';
import test from 'node:test';

function installBrowserStubs(overrides = {}) {
    global.document = {};
    global.window = {
        matchMedia: () => ({
            matches: false,
            addEventListener() {},
            removeEventListener() {},
        }),
        ...overrides,
    };
}

async function importJannyApi() {
    return import(`../modules/providers/janny/janny-api.js?test=${Date.now()}-${Math.random()}`);
}

test('addJannyBookmarks normalizes bookmark IDs from helper POST responses', async () => {
    const calls = [];
    installBrowserStubs({
        apiRequest: async (...args) => {
            calls.push(args);
            return new Response(JSON.stringify({
                bookmarks: [
                    { characterID: 'char-1' },
                    { character: { id: 'char-2' } },
                    { characterID: 'char-1' },
                ],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        },
    });
    global.fetch = async () => {
        throw new Error('raw fetch should not be used for cl-helper POSTs');
    };

    const { addJannyBookmarks } = await importJannyApi();
    const result = await addJannyBookmarks(['char-1']);

    assert.deepEqual(result, ['char-1', 'char-2']);
    assert.deepEqual(calls[0], [
        '/plugins/cl-helper/janny-bookmarks',
        'POST',
        { characterIDs: ['char-1'] },
    ]);
});

test('removeJannyBookmarks normalizes bookmark IDs from helper DELETE responses', async () => {
    const calls = [];
    installBrowserStubs({
        apiRequest: async (...args) => {
            calls.push(args);
            return new Response(JSON.stringify({
                bookmarks: [
                    { character_id: 'char-3' },
                    { bot: { id: 'char-4' } },
                ],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        },
    });
    global.fetch = async () => {
        throw new Error('raw fetch should not be used for cl-helper DELETEs');
    };

    const { removeJannyBookmarks } = await importJannyApi();
    const result = await removeJannyBookmarks(['char-3', 'char-4']);

    assert.deepEqual(result, ['char-3', 'char-4']);
    assert.deepEqual(calls[0], [
        '/plugins/cl-helper/janny-bookmarks?ids=char-3%2Cchar-4',
        'DELETE',
        null,
    ]);
});

test('fetchJannyBookmarkCharacters loads and normalizes bookmark character metadata', async () => {
    const calls = [];
    installBrowserStubs({
        apiRequest: async (...args) => {
            calls.push(args);
            return new Response(JSON.stringify({
                characters: [{
                    id: 'abc',
                    name: 'Ash Sunset',
                    avatar: 'ash.webp',
                    tagIds: [1, 5],
                    totalToken: 4200,
                    creatorUsername: 'DJ',
                    createdAt: '2026-06-26T12:00:00.000Z',
                }],
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        },
    });
    global.fetch = async () => {
        throw new Error('raw fetch should not be used when app apiRequest is available');
    };

    const api = await importJannyApi();
    assert.equal(typeof api.fetchJannyBookmarkCharacters, 'function');

    const chars = await api.fetchJannyBookmarkCharacters(['abc', 'def']);

    assert.deepEqual(calls[0], [
        '/plugins/cl-helper/janny-bookmark-chars?ids=abc%2Cdef',
        'GET',
        null,
    ]);
    assert.deepEqual(chars, [{
        id: 'abc',
        name: 'Ash Sunset',
        avatar: 'ash.webp',
        avatarUrl: '',
        description: '',
        tagIds: [1, 5],
        totalToken: 4200,
        creatorUsername: 'DJ',
        createdAt: '2026-06-26T12:00:00.000Z',
        createdAtStamp: 1782475200,
    }]);
});

test('fetchJannyBookmarks normalizes IDs from Janny bookmark records', async () => {
    installBrowserStubs({
        apiRequest: async () => new Response(JSON.stringify({
            bookmarks: [
                'plain-id',
                { characterID: 'upper-id' },
                { characterId: 'camel-id' },
                { character_id: 'snake-id' },
                { character: { id: 'nested-id' } },
                { id: 'fallback-id' },
                { id: '' },
                null,
            ],
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }),
    });
    global.fetch = async () => {
        throw new Error('raw fetch should not be used when app apiRequest is available');
    };

    const { fetchJannyBookmarks } = await importJannyApi();
    const ids = await fetchJannyBookmarks();

    assert.deepEqual(ids, [
        'plain-id',
        'upper-id',
        'camel-id',
        'snake-id',
        'nested-id',
        'fallback-id',
    ]);
});
