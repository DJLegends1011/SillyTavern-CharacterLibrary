import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    JanitoraiFavoriteCache,
    buildJanitoraiFavoritesPath,
    chooseJanitoraiSource,
    emptyJanitoraiFavoriteBrowseState,
    extractFavoriteSeed,
    isJanitoraiLoadCurrent,
    isJanitoraiSelectionCurrent,
    isJanitoraiFavoriteAuthError,
    normalizeFavoritePageMeta,
    normalizeFavoriteState,
    normalizeJanitoraiId,
    matchesJanitoraiFavoriteCreator,
    shouldRetainJanitoraiFavoriteResults,
} from '../modules/providers/janitorai/janitorai-favorites.js';

globalThis.window ??= {};
const {
    decodeJanitoraiClaims,
    janitoraiForceRefresh,
    janitoraiSessionStatus,
    janitoraiSetSession,
} = await import('../modules/providers/janitor-session.js');
const {
    fetchJanitoraiFavoriteState,
    fetchJanitoraiFavorites,
    setJanitoraiFavorite,
} = await import('../modules/providers/janitorai/janitorai-api.js');

function syntheticJwt(claims) {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `eyJhbGciOiJub25lIn0.${payload}.`;
}

function parseableSyntheticJwt(claims) {
    return `${syntheticJwt(claims)}signature`;
}

function deferred() {
    let resolve;
    const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
    return { promise, resolve };
}

function jsonResponse(status, body) {
    return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

async function withHampterResponses(responses, run) {
    const previousFetch = globalThis.fetch;
    const previousGetSetting = window.getSetting;
    const token = syntheticJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const calls = [];
    window.getSetting = (key) => ({
        janitoraiToken: token,
        janitoraiBrowserMode: 'external',
        janitoraiBrowserEndpoint: '',
    })[key];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        const next = responses.shift();
        if (!next) throw new Error('Unexpected Hampter request');
        if (next.throw) throw next.throw;
        return jsonResponse(next.status, next.body);
    };
    try {
        return await run(calls);
    } finally {
        globalThis.fetch = previousFetch;
        window.getSetting = previousGetSetting;
    }
}

test('decodes only the approved Janitor session identity fields', () => {
    const claims = decodeJanitoraiClaims(syntheticJwt({
        email: 'account@example.com',
        exp: 123,
        sub: 'account-a',
        user_metadata: { favorite_ids: ['A'] },
    }));
    assert.deepEqual(claims, {
        email: 'account@example.com',
        expMs: 123000,
        subject: 'account-a',
        favoriteIds: [],
    });
    assert.deepEqual(decodeJanitoraiClaims('not-a-token'), {
        email: '',
        expMs: 0,
        subject: '',
        favoriteIds: [],
    });
});

test('session source never logs decoded favorite or identity values', async () => {
    const source = await readFile(new URL('../modules/providers/janitor-session.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /console\.(?:log|info|debug)\([^\n]*(?:favoriteIds|subject|identity)/);
});

test('extractFavoriteSeed ignores unrelated account fields', () => {
    const payload = {
        sub: 'account-a',
        user_metadata: { theme: 'dark', favorite_ids: ['A'] },
        app_metadata: { provider: 'email' },
    };
    assert.deepEqual(extractFavoriteSeed(payload, [['user_metadata', 'favorite_ids']]), ['a']);
    assert.deepEqual(extractFavoriteSeed(payload, [['app_metadata', 'favorites']]), []);
});

test('a stale dead refresh cannot clear a newly saved Janitor session', async (t) => {
    const previousFetch = globalThis.fetch;
    const previousGetSetting = window.getSetting;
    const previousSetSetting = window.setSetting;
    const previousDispatchEvent = window.dispatchEvent;
    t.after(() => {
        globalThis.fetch = previousFetch;
        window.getSetting = previousGetSetting;
        window.setSetting = previousSetSetting;
        window.dispatchEvent = previousDispatchEvent;
    });

    const settings = new Map([
        ['janitoraiToken', parseableSyntheticJwt({ exp: 1, sub: 'old-account' })],
        ['janitoraiRefreshToken', 'old-refresh'],
    ]);
    const refreshResponse = deferred();
    const events = [];
    window.getSetting = key => settings.get(key);
    window.setSetting = (key, value) => settings.set(key, value);
    window.dispatchEvent = event => events.push(event.detail);
    globalThis.fetch = async (url) => {
        if (String(url).includes('grant_type=refresh_token')) return refreshResponse.promise;
        return jsonResponse(200, {});
    };

    const staleRefresh = janitoraiForceRefresh();
    const freshToken = parseableSyntheticJwt({
        email: 'fresh@example.test',
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: 'fresh-account',
    });
    assert.deepEqual(await janitoraiSetSession(freshToken), {
        ok: true,
        email: 'fresh@example.test',
        hasRefresh: false,
    });
    refreshResponse.resolve(jsonResponse(401, {}));
    await staleRefresh;

    assert.equal(settings.get('janitoraiToken'), freshToken);
    assert.deepEqual(janitoraiSessionStatus(), {
        loggedIn: true,
        email: 'fresh@example.test',
        expMs: decodeJanitoraiClaims(freshToken).expMs,
        hasRefresh: false,
        identity: 'fresh-account',
        favoriteIds: [],
    });
    assert.deepEqual(events.at(-1), { identity: 'fresh-account', favoriteIds: [] });
});

test('normalizes IDs and keeps unknown membership distinct from false', () => {
    const cache = new JanitoraiFavoriteCache();
    cache.syncIdentity('account-a');
    assert.equal(normalizeJanitoraiId('  ABC  '), 'abc');
    assert.equal(cache.get('abc'), undefined);
    cache.seed(['ABC']);
    assert.equal(cache.get('abc'), true);
    assert.equal(cache.get('missing'), undefined);
    cache.replace(['def']);
    assert.equal(cache.get('abc'), false);
    assert.equal(cache.get('def'), true);
});

test('account change clears membership and successful writes update it', () => {
    const cache = new JanitoraiFavoriteCache();
    cache.syncIdentity('account-a');
    cache.replace(['abc']);
    cache.set('def', true);
    assert.deepEqual([...cache.ids].sort(), ['abc', 'def']);
    assert.equal(cache.syncIdentity('account-b'), true);
    assert.equal(cache.complete, false);
    assert.equal(cache.get('abc'), undefined);
});

test('records an explicit unfavorite before the membership feed is complete', () => {
    const cache = new JanitoraiFavoriteCache();
    cache.syncIdentity('account-a');
    cache.seed(['abc']);
    cache.set('abc', false);
    assert.equal(cache.get('abc'), false);
    cache.set('abc', true);
    assert.equal(cache.get('abc'), true);
});

test('clears stale negative membership on authoritative replacement and identity changes', () => {
    const cache = new JanitoraiFavoriteCache();
    cache.syncIdentity('account-a');
    cache.set('abc', false);
    cache.seed(['abc']);
    assert.equal(cache.get('abc'), true);
    cache.set('abc', false);
    cache.replace(['def']);
    assert.deepEqual([...cache.negativeIds], []);
    cache.set('abc', false);
    cache.syncIdentity('account-b');
    assert.deepEqual([...cache.negativeIds], []);
});

test('extracts only IDs from verified account paths', () => {
    const payload = { user_metadata: { favorite_ids: ['A', 'B', null] } };
    assert.deepEqual(extractFavoriteSeed(payload, [['user_metadata', 'favorite_ids']]), ['a', 'b']);
    assert.deepEqual(extractFavoriteSeed(payload, []), []);
});

test('normalizes authoritative state and optional count', () => {
    const shape = { statePath: ['favorited'], countPath: ['count'] };
    assert.deepEqual(normalizeFavoriteState({ favorited: true, count: 12 }, shape), { favorited: true, count: 12 });
    assert.deepEqual(normalizeFavoriteState({ favorited: false }, shape), { favorited: false, count: null });
    assert.equal(normalizeFavoriteState({}, shape), null);
});

test('composes observed bare membership with a separate favorite count response', () => {
    assert.deepEqual(
        normalizeFavoriteState(
            { favorited: true, favoritesCount: 7 },
            { statePath: ['favorited'], countPath: ['favoritesCount'] },
        ),
        { favorited: true, count: 7 },
    );
    assert.deepEqual(
        normalizeFavoriteState(false, { statePath: [] }),
        { favorited: false, count: null },
    );
});

test('builds authenticated favorites pages without following mode', () => {
    assert.equal(
        buildJanitoraiFavoritesPath({ page: 2, mode: 'sfw', sort: 'latest', search: 'witch', tagIds: [2, 5] }),
        '/characters?page=2&favorites=true&mode=sfw&sort=latest&search=witch&tag_id%5B%5D=2&tag_id%5B%5D=5',
    );
});

test('computes favorite pagination from server metadata', () => {
    assert.deepEqual(normalizeFavoritePageMeta({ total: 69, page: 2, size: 34 }, 2, 34), {
        total: 69,
        page: 2,
        pageSize: 34,
        hasMore: true,
    });
    assert.equal(normalizeFavoritePageMeta({ data: Array(12) }, 3, 34).hasMore, false);
});

test('fetches authenticated favorite pages and normalizes their listing metadata', async () => {
    await withHampterResponses([{
        status: 200,
        body: {
            data: [{ id: 'character-1', chat_name: 'Witch', stats: { chat: 4 } }],
            total: 35,
            page: 1,
            size: 34,
        },
    }], async (calls) => {
        const page = await fetchJanitoraiFavorites({ page: 1, mode: 'sfw', sort: 'latest', search: 'witch', tagIds: [2] });
        assert.deepEqual(page, {
            characters: [{
                character_id: 'character-1',
                name: 'Witch',
                avatar: '',
                raw_avatar: '',
                description: '',
                tags: [],
                creator_name: '',
                creator_id: '',
                created_at: '',
                is_nsfw: false,
                chat_count: 4,
                message_count: 0,
                total_tokens: 0,
            }],
            total: 35,
            page: 1,
            pageSize: 34,
            hasMore: true,
        });
        assert.equal(calls[0].url, 'https://janitorai.com/hampter/characters?page=1&favorites=true&mode=sfw&sort=latest&search=witch&tag_id%5B%5D=2');
        assert.equal(calls[0].init.method, 'GET');
        assert.match(calls[0].init.headers.Authorization, /^Bearer /);
    });
});

test('combines authoritative membership and count reads without inferring membership', async () => {
    await withHampterResponses([
        { status: 200, body: true },
        { status: 200, body: { characterId: 'character-1', favoritesCount: 7 } },
    ], async (calls) => {
        assert.deepEqual(await fetchJanitoraiFavoriteState('character-1'), { favorited: true, count: 7 });
        assert.deepEqual(calls.map(call => call.url), [
            'https://janitorai.com/hampter/favorites/myfavorites/character-1',
            'https://janitorai.com/hampter/favorites/character/character-1/count',
        ]);
        assert.equal(calls[0].init.method, 'GET');
        assert.equal(calls[1].init.method, 'GET');
    });
});

test('keeps confirmed membership when its optional count request fails', async () => {
    await withHampterResponses([
        { status: 200, body: false },
        { status: 503, body: { error: 'unavailable' } },
    ], async () => {
        assert.deepEqual(await fetchJanitoraiFavoriteState('character-1'), { favorited: false, count: null });
    });
});

test('re-reads authoritative state after an empty favorite mutation response', async () => {
    await withHampterResponses([
        { status: 201, body: {} },
        { status: 200, body: true },
        { status: 200, body: { characterId: 'character-1', favoritesCount: 8 } },
    ], async (calls) => {
        assert.deepEqual(await setJanitoraiFavorite('character-1', true), { favorited: true, count: 8 });
        assert.deepEqual(calls.map(call => ({
            url: call.url,
            method: call.init.method,
            body: call.init.body,
        })), [
            {
                url: 'https://janitorai.com/hampter/favorites/favorite',
                method: 'POST',
                body: '{"characterId":"character-1"}',
            },
            {
                url: 'https://janitorai.com/hampter/favorites/myfavorites/character-1',
                method: 'GET',
                body: undefined,
            },
            {
                url: 'https://janitorai.com/hampter/favorites/character/character-1/count',
                method: 'GET',
                body: undefined,
            },
        ]);
    });
});

test('re-reads authoritative state after an empty unfavorite mutation response', async () => {
    await withHampterResponses([
        { status: 201, body: {} },
        { status: 200, body: false },
        { status: 200, body: { characterId: 'character-1', favoritesCount: 7 } },
    ], async (calls) => {
        assert.deepEqual(await setJanitoraiFavorite('character-1', false), { favorited: false, count: 7 });
        assert.deepEqual(calls.map(call => ({
            url: call.url,
            method: call.init.method,
            body: call.init.body,
        })), [
            {
                url: 'https://janitorai.com/hampter/favorites/unfavorite',
                method: 'POST',
                body: '{"characterId":"character-1"}',
            },
            {
                url: 'https://janitorai.com/hampter/favorites/myfavorites/character-1',
                method: 'GET',
                body: undefined,
            },
            {
                url: 'https://janitorai.com/hampter/favorites/character/character-1/count',
                method: 'GET',
                body: undefined,
            },
        ]);
    });
});

test('propagates count-read cancellation instead of returning an unknown count', async () => {
    await withHampterResponses([
        { status: 200, body: true },
        { throw: new DOMException('Aborted', 'AbortError') },
    ], async () => {
        await assert.rejects(fetchJanitoraiFavoriteState('character-1'), { name: 'AbortError' });
    });
});

test('rejects stale browse loads and stale preview selections', () => {
    assert.equal(isJanitoraiLoadCurrent({
        capturedToken: 2,
        currentToken: 2,
        capturedSource: 'favorites',
        currentSource: 'favorites',
        active: true,
    }), true);
    assert.equal(isJanitoraiLoadCurrent({
        capturedToken: 2,
        currentToken: 3,
        capturedSource: 'favorites',
        currentSource: 'favorites',
        active: true,
    }), false);
    assert.equal(isJanitoraiSelectionCurrent({
        capturedToken: 4,
        currentToken: 4,
        capturedId: ' ABC ',
        selectedId: 'abc',
    }), true);
    assert.equal(isJanitoraiSelectionCurrent({
        capturedToken: 4,
        currentToken: 5,
        capturedId: 'abc',
        selectedId: 'abc',
    }), false);
});

test('source priority is favorites, then Meili, then Hampter', () => {
    assert.equal(chooseJanitoraiSource({ favorites: true, sort: 'meili_latest' }), 'favorites');
    assert.equal(chooseJanitoraiSource({ favorites: false, sort: 'meili_latest' }), 'meili');
    assert.equal(chooseJanitoraiSource({ favorites: false, sort: 'latest' }), 'hampter');
});

test('Following stays on Hampter when the browse sort is Meili Latest', () => {
    assert.equal(chooseJanitoraiSource({
        mode: 'following',
        favorites: false,
        sort: 'meili_latest',
    }), 'hampter');
});

test('a Meili response is stale immediately after switching to Hampter', () => {
    assert.equal(isJanitoraiLoadCurrent({
        capturedToken: 8,
        currentToken: 9,
        capturedSource: 'meili',
        currentSource: 'hampter',
        active: true,
    }), false);
});

test('favorites retain their grid for Cloudflare and waiting-room failures', () => {
    assert.equal(shouldRetainJanitoraiFavoriteResults({ source: 'favorites', code: 'HAMPTER_BLOCKED' }), true);
    assert.equal(shouldRetainJanitoraiFavoriteResults({ source: 'favorites', waitingRoom: true }), true);
    assert.equal(shouldRetainJanitoraiFavoriteResults({ source: 'hampter', code: 'HAMPTER_BLOCKED' }), false);
});

test('favorites compose an active creator filter client-side', () => {
    assert.equal(matchesJanitoraiFavoriteCreator({ creator_id: 'Creator-A' }, { id: 'creator-a' }), true);
    assert.equal(matchesJanitoraiFavoriteCreator({ creator_id: 'creator-b' }, { id: 'creator-a' }), false);
    assert.equal(matchesJanitoraiFavoriteCreator({ creator_id: 'creator-b' }, null), true);
});

test('recognizes only definitive favorite authentication failures', () => {
    assert.equal(isJanitoraiFavoriteAuthError('HAMPTER_LOGIN_REQUIRED'), true);
    assert.equal(isJanitoraiFavoriteAuthError('HAMPTER_TOKEN_EXPIRED'), true);
    assert.equal(isJanitoraiFavoriteAuthError('HAMPTER_RATE_LIMITED'), false);
});

test('terminal favorite auth cleanup drops account-backed browse rows and resets paging', () => {
    assert.deepEqual(emptyJanitoraiFavoriteBrowseState(), {
        characters: [],
        favoritesPage: 1,
        favoritesHasMore: true,
        hasMore: true,
        totalPages: 0,
        rendered: 0,
    });
});

test('Janitor preview exposes the shared mobile favorite hook and compact inline control', async () => {
    const browse = await readFile(new URL('../modules/providers/janitorai/janitorai-browse.js', import.meta.url), 'utf8');
    const mobile = await readFile(new URL('../app/library-mobile.js', import.meta.url), 'utf8');
    const css = await readFile(new URL('../modules/providers/janitorai/janitorai-browse.css', import.meta.url), 'utf8');

    assert.match(browse, /id="janitoraiCharFavoriteBtn"[^>]*browse-fav-toggle/);
    assert.match(browse, /function resolveJanitoraiFavoriteState\(hit, token, identity\)/);
    assert.match(browse, /function toggleJanitoraiFavorite\(\)/);
    assert.match(browse, /on\('janitoraiCharFavoriteBtn', 'click', toggleJanitoraiFavorite\)/);
    assert.match(browse, /if \(status\?\.loggedIn\) void resolveJanitoraiFavoriteState\(hit, token, favoriteIdentity\)/);
    assert.match(mobile, /querySelector\('\.browse-fav-toggle'\)/);
    assert.match(mobile, /Unfavorite/);
    assert.match(css, /\.janitorai-fav-btn-inline/);
    assert.match(css, /html\.cl-mobile \.janitorai-fav-btn-inline/);
});

test('Janitor preview keeps an unknown favorite count distinct from authoritative zero', async () => {
    const { currentFavoriteCount } = await import('../modules/providers/janitorai/janitorai-browse.js');
    assert.equal(currentFavoriteCount({ favorite_count: null }), null);
    assert.equal(currentFavoriteCount({ favorite_count: undefined }), null);
    assert.equal(currentFavoriteCount({ favorite_count: '' }), null);
    assert.equal(currentFavoriteCount({ favorite_count: 0 }), 0);
});

test('Janitor favorite mutations reject a response from a different account', async () => {
    const { isJanitoraiFavoriteOperationCurrent } = await import('../modules/providers/janitorai/janitorai-browse.js');
    assert.equal(isJanitoraiFavoriteOperationCurrent({
        capturedToken: 4,
        currentToken: 4,
        capturedId: 'character-a',
        selectedId: 'character-a',
        capturedIdentity: 'account-a',
        currentIdentity: 'account-a',
        cacheIdentity: 'account-a',
    }), true);
    assert.equal(isJanitoraiFavoriteOperationCurrent({
        capturedToken: 4,
        currentToken: 4,
        capturedId: 'character-a',
        selectedId: 'character-a',
        capturedIdentity: 'account-a',
        currentIdentity: 'account-b',
        cacheIdentity: 'account-b',
    }), false);
    assert.equal(isJanitoraiFavoriteOperationCurrent({
        capturedToken: 4,
        currentToken: 4,
        capturedId: 'character-a',
        selectedId: 'character-a',
        capturedIdentity: 'account-a',
        currentIdentity: 'account-a',
        cacheIdentity: 'account-b',
    }), false);
});

test('mobile quick-import mode keeps the favorite pancake menu reachable', async () => {
    const mobile = await readFile(new URL('../app/library-mobile.js', import.meta.url), 'utf8');
    const mobileCss = await readFile(new URL('../app/library-mobile.css', import.meta.url), 'utf8');

    assert.match(mobile, /controls\.classList\.toggle\('has-browse-favorite-actions', !!modal\.querySelector\('\.browse-fav-toggle'\)\)/);
    assert.match(mobile, /\.action-btn:not\(\.mobile-more-actions-btn\)/);
    assert.match(mobile, /faved \? 'Unfavorite' : 'Favorite'/);
    assert.match(mobileCss, /\.modal-controls\.has-browse-favorite-actions \.mobile-more-actions-btn[^{]*\{\s*display: inline-flex;/s);
    assert.match(mobileCss, /\.modal-controls\.has-browse-favorite-actions \.mobile-quick-import-btn[^{]*\{\s*display: none;/s);
});

test('Janitor mobile favorite assets use the bumped cache-buster references', async () => {
    const libraryHtml = await readFile(new URL('../app/library.html', import.meta.url), 'utf8');
    assert.match(libraryHtml, /library-mobile\.css\?v=38/);
    assert.match(libraryHtml, /library-mobile\.js\?v=26/);
});
