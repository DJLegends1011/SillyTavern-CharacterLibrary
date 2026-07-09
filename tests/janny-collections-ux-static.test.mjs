import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../modules/providers/janny/janny-browse.js', import.meta.url), 'utf8');
const api = readFileSync(new URL('../modules/providers/janny/janny-api.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../modules/providers/browse-shared.css', import.meta.url), 'utf8');

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
test('Janny collection preview grid sizes to the collection card count', () => {
    assert.match(js, /Math\.min\(4, Math\.max\(images\.length, collectionCharacterCount\(collection\)\)\)/);
    assert.match(js, /for \(let i = 0; i < cellCount; i\+\+\)/);
});

test('Janny owned collection cards hydrate preview avatars after list load', () => {
    assert.match(js, /hydrateJannyOwnedCollectionPreviews/);
    assert.match(js, /fetchJannyCollectionCharacters\(collection\.id, jannyAccountOptions\(\)\)/);
    assert.match(js, /renderJannyOwnedCollectionsList\(\);[\s\S]*hydrateJannyOwnedCollectionPreviews\(\)/);
});

test('Janny search token avoids Cloudflare-prone page scraping on normal provider boot', () => {
    assert.match(api, /let _cachedToken = JANNY_FALLBACK_TOKEN;/);
    assert.doesNotMatch(api, /fetchWithProxy\(`\$\{JANNY_SITE_BASE\}\/characters\/search`\)/);
});
