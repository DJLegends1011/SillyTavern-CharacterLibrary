import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browseHarness, deferred, failure, flush, ready } from './helpers/janny-browse-harness.mjs';

const js = readFileSync(new URL('../modules/providers/janny/janny-browse.js', import.meta.url), 'utf8');
const api = readFileSync(new URL('../modules/providers/janny/janny-api.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../modules/providers/browse-shared.css', import.meta.url), 'utf8');
const mobileCss = readFileSync(new URL('../app/library-mobile.css', import.meta.url), 'utf8');
const browseViewJs = readFileSync(new URL('../modules/providers/browse-view.js', import.meta.url), 'utf8');

test('Janny preview modal uses dropdown collection membership controls', () => {
    assert.match(js, /jannyCollectionDropdownBtn/);
    assert.match(js, /jannyCollectionDropdown/);
    assert.match(js, /toggleSelectedJannyCollectionMembership/);
    assert.doesNotMatch(js, /id="jannyCollectionSelect"/);
    assert.doesNotMatch(js, /id="jannyAddToCollectionBtn"/);
});

test('Janny collections tab has public, owned, detail, and manage surfaces', () => {
    assert.match(js, /jannyCollectionsPublicBtn/);
    assert.match(js, /jannyCollectionsMineBtn/);
    assert.match(js, /jannyPublicCollectionsList/);
    assert.match(js, /jannyOwnedCollectionsList/);
    assert.match(js, /jannyCollectionManagePanel/);
});

test('Janny collection CSS contains dropdown and card classes', () => {
    assert.match(css, /\.janny-collection-dropdown/);
    assert.match(css, /\.janny-collection-card/);
    assert.match(css, /\.janny-collection-manage/);
});

test('membership lookup for a previous selection cannot mark the current character', async () => {
    const d = deferred();
    const h = browseHarness({ fetchJannyCollectionCharacters: () => d.promise });
    h.seedAccount(); h.run('jannyModalCollectionIds.clear()');
    const pending = h.run('refreshSelectedJannyCollectionMemberships()');
    h.run("jannySelectedChar = { id: 'different-character' }; jannyModalCollectionChecksLoadedFor = '';");
    d.resolve([{ characterId: 'old-character' }]); await pending;
    assert.equal(h.run('jannyModalCollectionIds.size'), 0);
    assert.equal(h.run('jannyModalCollectionChecksLoadedFor'), '');
});
test('Janny collections chrome: topbar refresh replaces banner Reload, sort uses CL dropdown, surfaces hide cleanly', () => {
    // Banner "Reload" was redundant with the topbar refresh button.
    assert.doesNotMatch(js, /jannyReloadCollectionsBtn/);
    assert.match(js, /function reloadJannyCollections\(/);
    assert.match(js, /on\('jannyRefreshBtn', 'click'[\s\S]*?reloadJannyCollections\(\)/);
    // Public collections sort gets the same styled dropdown as the browse sort.
    assert.match(js, /initCustomSelect\?\.\(publicCollectionsSortEl\)/);
    // browse-shared.css loads after library.css, so its display rules need
    // explicit .hidden overrides or toggled panels leak into other surfaces.
    assert.match(css, /\.browse-search-bar\.hidden/);
    assert.match(css, /\.janny-collection-toolbar\.hidden/);
    assert.match(mobileCss, /#onlineView #jannyCollectionsSection \.browse-search-bar:not\(\.hidden\)/);
});

test('Janny collection detail shows updated line, description, meta chips, and clickable owner', () => {
    assert.match(js, /janny-collection-detail-updated/);
    assert.match(js, /janny-collection-meta-box/);
    assert.match(js, /renderJannyCollectionOwnerLink/);
    assert.match(css, /\.janny-collection-detail-updated/);
    assert.match(css, /\.janny-collection-detail-meta \.janny-collection-meta-box/);
});

test('Janny collection owner links open the collector collections surface', () => {
    assert.match(js, /openJannyCollectorCollections\(author\)/);
    assert.match(js, /fetchJannyCollectorCollections/);
    assert.match(js, /jannyCollectorCollectionsPanel/);
    assert.match(js, /surface !== 'collector'/);
    // Collection owners must not fall back to character keyword search.
    assert.doesNotMatch(js, /janny-collection-owner-link[\s\S]{0,400}filterByAuthor/);
    assert.match(api, /\/collectors\/\$\{encodeURIComponent/);
});

test('Janny collection preview grid sizes to the collection card count', () => {
    assert.match(js, /Math\.min\(4, Math\.max\(images\.length, collectionCharacterCount\(collection\)\)\)/);
    assert.match(js, /for \(let i = 0; i < cellCount; i\+\+\)/);
});

test('owned collections render loading, empty, and Cloudflare error states', async () => {
    const d = deferred();
    let reads = 0;
    const h = browseHarness({ fetchJannyCollections: () => { reads++; return d.promise; } });
    const list = h.el('jannyOwnedCollectionsList');
    const pending = h.run('loadJannyOwnedCollections()');
    assert.match(list.innerHTML, /Loading your collections/);
    await h.run('loadJannyOwnedCollections()');
    await flush();
    assert.equal(reads, 1);
    d.resolve([]); await pending;
    assert.match(list.innerHTML, /No Janny collections/);
    h.context.fetchJannyCollections = async () => { throw failure('JANNY_CF_BLOCKED'); };
    await h.run('loadJannyOwnedCollections(true)');
    assert.match(list.innerHTML, /Cloudflare/);
    assert.equal(h.run('jannyOwnedCollectionsLoading'), false);
});

test('owned collection preview hydration saves avatars to the loaded collection', async () => {
    const h = browseHarness({ fetchJannyCollectionCharacters: async () => [{ id: 'old-character', avatar: '/avatar.png', name: 'Character' }] });
    h.seedAccount();
    await h.run('hydrateJannyOwnedCollectionPreviews()');
    assert.equal(h.run('jannyOwnedCollections[0].previewCharacters[0].avatar'), '/avatar.png');
});

test('Janny search token avoids Cloudflare-prone page scraping on normal provider boot', () => {
    assert.match(api, /let _cachedToken = JANNY_FALLBACK_TOKEN;/);
    assert.doesNotMatch(api, /fetchWithProxy\(`\$\{JANNY_SITE_BASE\}\/characters\/search`\)/);
});

test('Janny collection images stay hidden until their full bitmap has decoded', () => {
    assert.match(js, /class="browse-decode-image" data-src=/);
    assert.match(js, /jannyBrowseView\.observeImages\(list\)/);
    assert.match(js, /jannyBrowseView\.observeImages\(panel\)/);
    assert.match(browseViewJs, /img\.browse-decode-image\[data-src\]/);
    assert.match(browseViewJs, /const preloader = new Image\(\);[\s\S]*preloader\.decode\(\)\.then\(reveal\)/);
    assert.match(browseViewJs, /img\.src = src;[\s\S]*BrowseView\.adjustPortraitPosition/);
});

test('Janny browse removes obsolete bridge instructions', () => {
    assert.doesNotMatch(js, /bridge userscript|cl-janny-bridge|cl-janitor-bridge|refresh the userscript|direct Supabase|copy cf_clearance/i);
});

for (const [code, pattern] of [
    ['JANNY_HELPER_UNAVAILABLE', /install|update/i],
    ['JANNY_BROWSER_UNAVAILABLE', /endpoint|start.*browser/i],
    ['JANNY_CF_BLOCKED', /Cloudflare/i],
    ['JANNY_LOGIN_REQUIRED', /login.*required|install.*login/i],
    ['JANNY_TOKEN_EXPIRED', /expired/i],
    ['JANNY_TOKEN_REJECTED', /rejected/i],
]) {
    test(`account readiness explains ${code} and opens the Janny settings section`, async () => {
        const h = browseHarness({ probeJannyAccount: async () => ({ ...ready, browser: !['JANNY_HELPER_UNAVAILABLE', 'JANNY_BROWSER_UNAVAILABLE'].includes(code), active: false, cloudflare: code === 'JANNY_CF_BLOCKED', code }) });
        h.el('settingsJannySection');
        assert.equal(await h.run('ensureJannyAccountReady()'), false);
        assert.match(h.toasts[0][0], pattern);
        assert.deepEqual(h.settingsOpened, ['online']);
        assert.equal(h.el('settingsJannySection').open, true);
    });
}

test('browser-shaped active account enables account controls', async () => {
    const h = browseHarness();
    assert.equal(await h.run('ensureJannyAccountReady()'), true);
    assert.equal(h.settingsOpened.length, 0);
});

test('anonymous activation and search do not probe or warm a browser', async () => {
    let browserCalls = 0;
    const h = browseHarness({
        probeJannyAccount: async () => { browserCalls++; return ready; },
        warmJanitorClearance: async () => { browserCalls++; },
        meiliMultiSearch: async () => ({ results: [{ hits: [], totalPages: 1 }] }),
    });
    h.el('jannyGrid');
    h.run('jannyBrowseView.init(); jannyBrowseView.activate(null);');
    await flush();
    assert.equal(browserCalls, 0);
    assert.match(h.el('jannyGrid').innerHTML, /No matches/);
});

test('cache invalidation removes account state and rendered private surfaces', () => {
    const h = browseHarness();
    h.seedAccount();
    for (const id of ['jannyOwnedCollectionsList', 'jannyCollectionDropdown', 'jannyCollectionDetailPanel', 'jannyCollectionManagePanel', 'jannyGrid']) h.el(id).innerHTML = 'Old private collection';
    h.el('jannyBookmarkBtn');
    h.run(`jannyCollectionDropdownOpen = true; jannyActiveCollection = { kind: 'owned' };
        jannyManageCollection = { collection: { id: 'old-collection' } };
        jannyFilterOnlyBookmarked = true; jannyCharacters = [{ id: 'old-character' }];`);
    assert.equal(typeof h.window.jannyInvalidateAccountCache, 'function');
    h.window.jannyInvalidateAccountCache();
    assert.equal(h.run('jannyBookmarksLoaded || jannyOwnedCollectionsLoaded || jannyAccountStatus.active'), false);
    assert.equal(h.run('jannyBookmarkIds.size + jannyOwnedCollections.length + jannyModalCollectionIds.size + jannyCharacters.length'), 0);
    assert.equal(h.run('jannyModalCollectionChecksLoadedFor'), '');
    assert.equal(h.run('jannyBookmarkTotalCount'), null);
    assert.equal(h.run('jannyBookmarkLimitToastShown'), false);
    assert.equal(h.run('jannyManageCollection'), null);
    for (const id of ['jannyOwnedCollectionsList', 'jannyCollectionDropdown', 'jannyCollectionDetailPanel', 'jannyCollectionManagePanel', 'jannyGrid']) assert.doesNotMatch(h.el(id).innerHTML, /Old private/);
    assert.equal(h.el('jannyBookmarkBtn').classList.contains('favorited'), false);
});

for (const operation of ['loadJannyBookmarks(true)', 'loadJannyOwnedCollections(true)', 'refreshSelectedJannyCollectionMemberships()']) {
    test(`account replacement discards pending ${operation}`, async () => {
        const d = deferred();
        const h = browseHarness({ fetchJannyBookmarks: () => d.promise, fetchJannyCollections: () => d.promise, fetchJannyCollectionCharacters: () => d.promise });
        h.seedAccount();
        const pending = h.run(operation);
        await flush();
        assert.equal(typeof h.window.jannyInvalidateAccountCache, 'function');
        h.window.jannyInvalidateAccountCache();
        d.resolve([{ id: 'old-collection', characterId: 'old-character' }]);
        await pending;
        assert.equal(h.run('jannyBookmarkIds.size + jannyOwnedCollections.length + jannyModalCollectionIds.size'), 0);
        assert.equal(h.run('jannyBookmarksLoaded || jannyOwnedCollectionsLoaded'), false);
    });
}

test('definitive collection rejection clears old account caches without duplicate-add reconciliation', async () => {
    let reads = 0;
    const h = browseHarness({
        addJannyCharacterToCollection: async () => { throw Object.assign(failure('JANNY_LOGIN_REQUIRED'), { status: 401 }); },
        fetchJannyCollectionCharacters: async () => { reads++; return [{ characterId: 'old-character' }]; },
    });
    h.seedAccount(); h.run('jannyModalCollectionIds.clear()');
    await h.run("toggleSelectedJannyCollectionMembership('old-collection')");
    assert.equal(h.run('jannyOwnedCollections.length + jannyBookmarkIds.size + jannyModalCollectionIds.size'), 0);
    assert.equal(reads, 0);
    assert.equal(h.toasts.some(([, kind]) => kind === 'success' || kind === 'info'), false);
});

test('a duplicate add on a still-active session reports membership instead of a login failure', async () => {
    let reads = 0;
    const h = browseHarness({
        addJannyCharacterToCollection: async () => { throw Object.assign(failure('JANNY_LOGIN_REQUIRED'), { status: 401 }); },
        jannySessionStatus: async () => ({ active: true, email: '', expMs: 0, hasRefresh: true, refreshable: true }),
        fetchJannyCollectionCharacters: async () => { reads++; return [{ characterId: 'old-character' }]; },
    });
    h.seedAccount(); h.run('jannyModalCollectionIds.clear()');
    h.el('jannyCharModal');
    await h.run("toggleSelectedJannyCollectionMembership('old-collection')");
    assert.equal(reads, 1, 'membership was not re-fetched');
    // Caches survive: the account was never invalidated.
    assert.equal(h.run('jannyOwnedCollections.length'), 1);
    assert.equal(h.run('jannyBookmarkIds.size'), 1);
    assert.equal(h.run('jannyBookmarksLoaded && jannyOwnedCollectionsLoaded'), true);
    assert.equal(h.run('jannyAccountStatus.active'), true);
    assert.equal(h.run("jannyModalCollectionIds.has('old-collection')"), true);
    // The preview modal stays open and the count is not double-counted.
    assert.equal(h.el('jannyCharModal').classList.contains('hidden'), false);
    assert.equal(h.run('jannySelectedChar?.id'), 'old-character');
    assert.equal(h.run('jannyOwnedCollections[0].characterCount'), 1);
    assert.equal(h.toasts.some(([message, kind]) => kind === 'info' && /already in Old private collection/.test(message)), true);
    assert.equal(h.toasts.some(([, kind]) => kind === 'error'), false);
});

test('a duplicate-add reconciliation is refused once the browser session is gone', async () => {
    let reads = 0;
    const h = browseHarness({
        addJannyCharacterToCollection: async () => { throw Object.assign(failure('JANNY_LOGIN_REQUIRED'), { status: 401 }); },
        jannySessionStatus: async () => ({ active: false, hasRefresh: false, refreshable: false }),
        fetchJannyCollectionCharacters: async () => { reads++; return [{ characterId: 'old-character' }]; },
    });
    h.seedAccount(); h.run('jannyModalCollectionIds.clear()');
    await h.run("toggleSelectedJannyCollectionMembership('old-collection')");
    assert.equal(reads, 0, 'an inactive session must not be reconciled against collection contents');
    assert.equal(h.run('jannyOwnedCollections.length + jannyBookmarkIds.size + jannyModalCollectionIds.size'), 0);
});

test('failed collection mutation leaves membership and count unchanged', async () => {
    const h = browseHarness({ removeJannyCharacterFromCollection: async () => { throw failure('JANNY_CF_BLOCKED'); } });
    h.seedAccount();
    await h.run("toggleSelectedJannyCollectionMembership('old-collection')");
    assert.equal(h.run("jannyModalCollectionIds.has('old-collection')"), true);
    assert.equal(h.run('jannyOwnedCollections[0].characterCount'), 1);
    assert.equal(h.toasts.some(([, kind]) => kind === 'success'), false);
});

test('in-flight successful collection mutation cannot alter a replacement account', async () => {
    const d = deferred();
    const h = browseHarness({ removeJannyCharacterFromCollection: () => d.promise });
    h.seedAccount();
    const pending = h.run("toggleSelectedJannyCollectionMembership('old-collection')");
    await flush();
    assert.equal(typeof h.window.jannyInvalidateAccountCache, 'function');
    h.window.jannyInvalidateAccountCache();
    h.seedAccount();
    d.resolve({}); await pending;
    assert.equal(h.run('jannyOwnedCollections[0].characterCount'), 1);
    assert.equal(h.run("jannyModalCollectionIds.has('old-collection')"), true);
    assert.equal(h.toasts.some(([, kind]) => kind === 'success'), false);
});

for (const [operation, boundary] of [
    ['hydrateJannyOwnedCollectionPreviews()', 'fetchJannyCollectionCharacters'],
    ["openJannyOwnedCollection('old-collection')", 'fetchJannyCollectionCharacters'],
    ["openJannyCollectionManage('old-collection')", 'fetchJannyCollectionCharacters'],
    ['saveJannyManagedCollection()', 'updateJannyCollection'],
    ['createCollectionFromPanel()', 'createJannyCollection'],
    ["removeCharacterFromManagedCollection('old-character')", 'removeJannyCharacterFromCollection'],
    ["confirmAndDeleteJannyCollection('old-collection')", 'deleteJannyCollection'],
]) {
    test(`definitive rejection in ${operation} invalidates all account data`, async () => {
        const h = browseHarness({ [boundary]: async () => { throw failure('JANNY_TOKEN_REJECTED'); } });
        h.seedAccount();
        h.el('jannyManageCollectionName').value = 'New name';
        h.el('jannyNewCollectionName').value = 'New name';
        h.run("jannyManageCollection = { collection: { ...jannyOwnedCollections[0] }, characters: [{ id: 'old-character' }] }");
        await h.run(operation);
        assert.equal(h.run('jannyBookmarkIds.size + jannyOwnedCollections.length + jannyModalCollectionIds.size'), 0);
        assert.equal(h.run('jannyManageCollection'), null);
    });
}

for (const [operation, boundary] of [
    ['saveJannyManagedCollection()', 'updateJannyCollection'],
    ["removeCharacterFromManagedCollection('old-character')", 'removeJannyCharacterFromCollection'],
    ["confirmAndDeleteJannyCollection('old-collection')", 'deleteJannyCollection'],
    ['addCharacterToManagedCollection()', 'addJannyCharacterToCollection'],
    ['createCollectionFromPanel()', 'createJannyCollection'],
]) {
    test(`pending ${operation} cannot mutate a replacement account`, async () => {
        const d = deferred();
        const h = browseHarness({ [boundary]: () => d.promise, fetchJannyCharactersByIds: async () => [{ id: 'new-character' }] });
        h.seedAccount();
        h.el('jannyManageCollectionName').value = 'New name';
        h.el('jannyNewCollectionName').value = 'New name';
        h.el('jannyManageAddCharacterInput').value = '11111111-1111-4111-8111-111111111111';
        h.run("jannyManageCollection = { collection: { ...jannyOwnedCollections[0] }, characters: [{ id: 'old-character' }] }");
        const pending = h.run(operation);
        await flush(); h.window.jannyInvalidateAccountCache(); h.seedAccount();
        h.run("jannyManageCollection = { collection: { ...jannyOwnedCollections[0] }, characters: [{ id: 'old-character' }] }");
        d.resolve({}); await pending;
        assert.equal(h.run('jannyOwnedCollections.length'), 1);
        assert.equal(h.run('jannyOwnedCollections[0].name'), 'Old private collection');
        assert.equal(h.run('jannyManageCollection.characters.length'), 1);
        assert.equal(h.toasts.some(([, kind]) => kind === 'success'), false);
    });
}

test('old bookmark rejection does not invalidate replacement-account data', async () => {
    const d = deferred();
    const h = browseHarness({ fetchJannyBookmarks: () => d.promise });
    h.seedAccount();
    const pending = h.run('loadJannyBookmarks(true)');
    await flush(); h.window.jannyInvalidateAccountCache(); h.seedAccount();
    d.reject(failure('JANNY_TOKEN_REJECTED'));
    await assert.rejects(pending);
    assert.equal(h.run('jannyBookmarkIds.size'), 1);
    assert.equal(h.run('jannyAccountStatus.active'), true);
});
