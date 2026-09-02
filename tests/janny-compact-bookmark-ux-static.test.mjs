import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { browseHarness, deferred, failure, flush } from './helpers/janny-browse-harness.mjs';

const browse = await readFile(
    new URL('../modules/providers/janny/janny-browse.js', import.meta.url),
    'utf8',
);
const css = await readFile(
    new URL('../modules/providers/browse-shared.css', import.meta.url),
    'utf8',
);
const mobile = await readFile(
    new URL('../app/library-mobile.js', import.meta.url),
    'utf8',
);

test('Janny account bookmark is a compact metadata action', () => {
    assert.match(
        browse,
        /<p class="browse-char-meta">[\s\S]{0,700}id="jannyBookmarkBtn"[\s\S]{0,250}browse-meta-action[\s\S]{0,250}fa-regular fa-bookmark/,
    );
    assert.doesNotMatch(
        browse,
        /<div class="modal-controls">[\s\S]{0,700}id="jannyBookmarkBtn"/,
    );
    assert.doesNotMatch(browse, /id="jannyBookmarkBtn" class="action-btn/);
});

test('Janny bookmark state remains icon-only and accessible', () => {
    const h = browseHarness(); h.seedAccount();
    const btn = h.el('jannyBookmarkBtn');
    h.run('updateJannyBookmarkButton()');
    assert.equal(btn.classList.contains('favorited'), true);
    assert.match(btn.innerHTML, /fa-solid fa-bookmark/);
    assert.match(btn['aria-label'], /Remove/);
    h.run('jannyBookmarkIds.clear(); jannyBookmarkTotalCount = 0; updateJannyBookmarkButton()');
    assert.equal(btn.classList.contains('favorited'), false);
    assert.match(btn.innerHTML, /fa-regular fa-bookmark/);
    assert.match(btn['aria-label'], /Save/);
    assert.doesNotMatch(btn.innerHTML, />\s*(Bookmark|Bookmarked)/);
});

test('Janny compact bookmark is available through mobile overflow', () => {
    assert.match(css, /\.browse-meta-action\s*{/);
    assert.match(mobile, /querySelectorAll\('\.browse-meta-action'\)/);
    assert.match(mobile, /metaAction\.click\(\)/);
});

test('mobile overflow excludes hidden metadata actions', () => {
    assert.match(mobile, /metaAction\.hidden\s*\|\|\s*metaAction\.style\.display\s*===\s*'none'/);
    assert.match(mobile, /getComputedStyle\(metaAction\)\.display\s*===\s*'none'/);
});

test('Janny account filter follows maintainer Personal and Library grouping', () => {
    assert.match(
        browse,
        /Personal <span[^>]*>\(requires login\)<\/span>:[\s\S]{0,500}id="jannyFilterOnlyBookmarked"[\s\S]{0,180}fa-solid fa-bookmark[\s\S]{0,120}My Bookmarks[\s\S]{0,500}<div class="dropdown-section-title">Library:<\/div>/,
    );
    assert.doesNotMatch(browse, /id="jannyFilterOnlyBookmarked"[^>]*>[\s\S]{0,220}Only Bookmarked<\/label>/);
    assert.doesNotMatch(browse, /<div class="dropdown-section-title">Account:<\/div>/);
});

for (const [code, message] of [['JANNY_CF_BLOCKED', /Cloudflare/i], ['JANNY_PAGE_SHAPE_CHANGED', /page.*changed|unrecognized|incomplete/i]]) {
    test(`${code} prevents preview and programmatic import without listing fallback`, async () => {
        let imports = 0;
        const h = browseHarness({ CoreAPI: { getProvider: () => ({ fetchMetadata: async () => { throw failure(code); }, importCharacter: async () => { imports++; return { success: true }; } }) } });
        h.el('jannyCharDescription'); h.el('jannyCharDescriptionSection'); h.el('jannyImportBtn');
        h.run("jannySelectedChar = { id: 'card', name: 'Listing only' }; jannyDetailFetchToken = 1");
        await h.run('fetchAndPopulateDetails(jannySelectedChar, 1)');
        assert.equal(h.el('jannyImportBtn').disabled, true);
        assert.match(h.el('jannyCharDescription').innerHTML, message);
        await h.run('importCharacter(jannySelectedChar)');
        assert.equal(imports, 0);
        assert.equal(h.el('jannyImportBtn').disabled, true);
    });
}

test('preview disables import while fetching and only enables complete definitions', async () => {
    const d = deferred();
    const h = browseHarness({ CoreAPI: { getProvider: () => ({ fetchMetadata: () => d.promise }) } });
    for (const id of ['jannyCharModal', 'jannyCharAvatar', 'jannyCharName', 'jannyCharCreator', 'jannyOpenInBrowserBtn', 'jannyCharTokens', 'jannyCharDate', 'jannyCharTags', 'jannyCharCreatorNotesSection', 'jannyCharCreatorNotes', 'jannyImportBtn']) h.el(id);
    h.run("view._lookup.byProviderId.add('card'); openPreviewModal({ id: 'card', name: 'Test' });");
    assert.equal(h.el('jannyImportBtn').disabled, true);
    d.resolve({ id: 'card', name: 'Test', personality: 'Complete definition', firstMessage: 'Hello' });
    await h.run('jannyDetailFetchPromise');
    assert.equal(h.el('jannyImportBtn').disabled, false);
});

test('incomplete metadata never enables import', async () => {
    const h = browseHarness({ CoreAPI: { getProvider: () => ({ fetchMetadata: async () => ({ id: 'card', name: 'Listing only', description: 'Teaser' }) }) } });
    h.el('jannyImportBtn'); h.el('jannyCharDescription');
    h.run("jannySelectedChar = { id: 'card' }; jannyDetailFetchToken = 1;");
    await h.run('fetchAndPopulateDetails(jannySelectedChar, 1)');
    assert.equal(h.el('jannyImportBtn').disabled, true);
    assert.equal(h.run('!!jannySelectedChar._fullData'), false);
});

for (const code of ['JANNY_CF_BLOCKED', 'JANNY_TOKEN_REJECTED']) {
    test(`failed bookmark mutation (${code}) never records success`, async () => {
        const h = browseHarness({ removeJannyBookmarks: async () => { throw failure(code); } });
        h.seedAccount(); h.el('jannyBookmarkBtn');
        await h.run('toggleSelectedJannyBookmark()');
        assert.equal(h.toasts.some(([, kind]) => kind === 'success'), false);
        assert.equal(h.run("jannyBookmarkIds.has('old-character')"), code === 'JANNY_CF_BLOCKED');
        assert.equal(h.el('jannyBookmarkBtn').classList.contains('loading'), false);
    });
}

test('bookmark result from an old account cannot change the new account', async () => {
    const d = deferred();
    const h = browseHarness({ removeJannyBookmarks: () => d.promise });
    h.seedAccount();
    const pending = h.run('toggleSelectedJannyBookmark()');
    await flush();
    assert.equal(typeof h.window.jannyInvalidateAccountCache, 'function');
    h.window.jannyInvalidateAccountCache(); h.seedAccount();
    d.resolve([]); await pending;
    assert.equal(h.run("jannyBookmarkIds.has('old-character')"), true);
    assert.equal(h.toasts.some(([, kind]) => kind === 'success'), false);
});

for (const code of ['JANNY_CF_BLOCKED', 'JANNY_PAGE_SHAPE_CHANGED']) {
    test(`import re-fetch failure ${code} removes reusable metadata and keeps import disabled`, async () => {
        const h = browseHarness({ CoreAPI: { getProvider: () => ({ importCharacter: async () => { throw failure(code); } }) } });
        h.el('jannyImportBtn');
        h.run("jannySelectedChar = { id: 'card', _fullData: { id: 'card', personality: 'Definition', firstMessage: 'Hello' } }");
        await h.run('importCharacter(jannySelectedChar)');
        assert.equal(h.el('jannyImportBtn').disabled, true);
        assert.equal(h.run('!!jannySelectedChar._fullData'), false);
    });
}

for (const rejected of [false, true]) {
    test(`account replacement discards pending preview ${rejected ? 'rejection' : 'definition'}`, async () => {
        const d = deferred();
        const h = browseHarness({ CoreAPI: { getProvider: () => ({ fetchMetadata: () => d.promise }) } });
        h.seedAccount(); h.el('jannyImportBtn');
        const selected = h.run('jannySelectedChar');
        const pending = h.run('fetchAndPopulateDetails(jannySelectedChar, jannyDetailFetchToken)');
        await flush(); h.window.jannyInvalidateAccountCache(); h.seedAccount();
        if (rejected) d.reject(failure('JANNY_TOKEN_REJECTED'));
        else d.resolve({ id: 'old-character', personality: 'Old account definition', firstMessage: 'Hello' });
        await pending;
        assert.equal(selected._fullData, undefined);
        assert.equal(h.run('!!jannySelectedChar._fullData'), false);
        assert.equal(h.run('jannyAccountStatus.active'), true);
        assert.equal(h.el('jannyImportBtn').disabled, true);
    });
}

test('account cache reset clears reusable preview definition and visible modal', () => {
    const h = browseHarness(); h.seedAccount();
    h.el('jannyCharModal'); h.el('jannyCharDescription').innerHTML = 'Old private definition';
    h.el('jannyImportBtn');
    const selected = h.run("jannySelectedChar._fullData = { id: 'old-character', personality: 'Private', firstMessage: 'Hello' }; jannySelectedChar");
    h.window.jannyInvalidateAccountCache();
    assert.equal(selected._fullData, undefined);
    assert.equal(h.el('jannyCharModal').classList.contains('hidden'), true);
    assert.equal(h.el('jannyCharDescription').innerHTML, '');
    assert.equal(h.el('jannyImportBtn').disabled, true);
});
