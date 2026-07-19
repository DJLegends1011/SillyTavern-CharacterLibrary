import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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

test('Janny collections async state has guards for sort and stale responses', () => {
    assert.match(js, /let jannyPublicCollectionsSort = 'latest';/);
    assert.match(js, /let jannyCollectionDetailLoadToken = 0;/);
    assert.match(js, /let jannyCollectionManageLoadToken = 0;/);
    assert.match(js, /const characterName = jannySelectedChar\?\.name \|\| 'character';/);
    assert.match(js, /String\(jannySelectedChar\?\.id \|\| ''\) !== characterId/);
    assert.match(js, /function openPreviewModal[\s\S]*jannyCollectionRowMutations = new Set\(\);/);
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

test('Janny owned collections list mirrors the public loading/error states', () => {
    assert.match(js, /let jannyOwnedCollectionsLoading = false;/);
    assert.match(js, /let jannyOwnedCollectionsError = '';/);
    assert.match(js, /fa-spinner fa-spin"><\/i> Loading your collections\.\.\./);
    assert.match(js, /if \(jannyOwnedCollectionsLoading\) return jannyOwnedCollections;/);
});

test('Janny owned collection cards hydrate preview avatars after list load', () => {
    assert.match(js, /hydrateJannyOwnedCollectionPreviews/);
    assert.match(js, /fetchJannyCollectionCharacters\(collection\.id\)/);
    assert.match(js, /renderJannyOwnedCollectionsList\(\);[\s\S]*hydrateJannyOwnedCollectionPreviews\(\)/);
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
