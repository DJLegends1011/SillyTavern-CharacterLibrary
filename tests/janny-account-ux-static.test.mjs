import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browseHarness, deferred, failure, flush, ready } from './helpers/janny-browse-harness.mjs';

const js = readFileSync(new URL('../modules/providers/janny/janny-browse.js', import.meta.url), 'utf8');
const collectionsJs = readFileSync(new URL('../modules/providers/janny/janny-collections.js', import.meta.url), 'utf8');
const api = readFileSync(new URL('../modules/providers/janny/janny-api.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../modules/providers/browse-shared.css', import.meta.url), 'utf8');
const mobileCss = readFileSync(new URL('../app/library-mobile.css', import.meta.url), 'utf8');
const browseViewJs = readFileSync(new URL('../modules/providers/browse-view.js', import.meta.url), 'utf8');

// ── Collections wiring (behaviour lives in janny-collections.test.mjs) ──

test('Janny browse hands every collection surface to janny-collections.js', () => {
    assert.match(js, /import \{ createJannyCollections \} from '\.\/janny-collections\.js'/);
    assert.match(js, /\$\{collections\.renderSection\(\)\}/);
    assert.match(js, /collections\.wire\(\)/);
    assert.match(js, /collections\.wirePicker\(\)/);
    assert.match(js, /return \['jannyGrid', \.\.\.collections\.gridIds\]/);
    // The old in-file implementation is gone
    assert.doesNotMatch(js, /jannyOwnedCollections|jannyCollectionManagePanel|jannyCollectorCollectionsPanel|janny-collection-card\b/);
});

test('Janny collection directory uses the shared collection card on the BrowseView loader', () => {
    assert.match(collectionsJs, /import \{ renderCollectionCard, wireCollectionGrid \} from '\.\.\/browse-collection-card\.js'/);
    assert.match(collectionsJs, /class="browse-collection-grid"/);
    assert.match(collectionsJs, /renderSkeletonGrid\(grid/);
    assert.doesNotMatch(collectionsJs, /fa-spinner fa-spin"><\/i> Loading (public )?collections/);
});

test('preview modal keeps the add-to-collection picker anchor ids', () => {
    assert.match(js, /id="jannyCollectionAction"/);
    assert.match(js, /id="jannyCollectionDropdownBtn"/);
    assert.match(js, /id="jannyCollectionDropdown" class="dropdown-menu janny-collection-picker-menu hidden"/);
    assert.doesNotMatch(js, /id="jannyCollectionSelect"|id="jannyAddToCollectionBtn"/);
});

test('collection CSS: shared cards, scoped .hidden, picker and its mobile bottom sheet', () => {
    assert.match(css, /\.browse-collection-card \{/);
    assert.match(css, /#jannyCollectionsSection \.hidden \{\s*display: none !important;/);
    assert.match(css, /\.janny-collection-picker-menu \{/);
    assert.match(css, /\.janny-collection-remove \{/);
    assert.match(mobileCss, /html\.cl-mobile #jannyCharModal \.janny-collection-picker-menu \{\s*position: fixed;/);
    assert.match(mobileCss, /html\.cl-mobile #jannyCollectionsSection \.janny-collection-banner \{/);
    assert.doesNotMatch(css + mobileCss, /janny-collection-(dropdown|toggle-row|card-grid|segmented|manage)\b|janny-manage-/);
});

test('topbar refresh and infinite scroll follow the collections surface while it is open', () => {
    const h = browseHarness();
    h.el('jannyGrid');
    h.run('initJannyView()');
    h.collections.setOpen(true);
    h.handlers.get('jannyRefreshBtn:click')();
    assert.equal(h.collections.calls.refresh, 1);
    assert.equal(h.run('jannyBrowseView.canLoadMore()'), false);
});

test('Browse / Collections is a mode toggle at the front of the filter bar, like DataCat', () => {
    const bar = js.slice(js.indexOf('renderFilterBar() {'), js.indexOf('renderView() {'));
    assert.ok(bar.indexOf('data-janny-view="collections"') < bar.indexOf('id="jannySortSelect"'), 'mode toggle leads the bar');
    assert.match(bar, /<div class="chub-view-toggle">[\s\S]*data-janny-view="browse"[\s\S]*data-janny-view="collections"/);
    assert.doesNotMatch(js, /jannyCollectionsBtn/);
    assert.match(js, /get hasModeToggle\(\) \{ return true; \}/);
    assert.match(js, /modeBrowseSelector: '\.janny-view-btn\[data-janny-view="browse"\]'/);
    assert.match(js, /extraModes: \[\{\s*selector: '\.janny-view-btn\[data-janny-view="collections"\]'/);
    assert.match(css, /\.janny-view-btn\.active \{/);
});

test('opening collections flips the toggle and hides browse-only sort and tags', () => {
    const h = browseHarness();
    const classes = (initial = []) => {
        const set = new Set(initial);
        return { contains: n => set.has(n), toggle: (n, force = !set.has(n)) => (force ? set.add(n) : set.delete(n), force) };
    };
    const browseBtn = { dataset: { jannyView: 'browse' }, classList: classes(['active']) };
    const collBtn = { dataset: { jannyView: 'collections' }, classList: classes() };
    const tagsBox = { classList: classes() };
    h.context.document.querySelectorAll = sel => (sel === '.janny-view-btn' ? [browseBtn, collBtn] : []);
    h.el('jannySortSelect').classList.remove('browse-filter-hidden');
    h.el('jannyTagsBtn').closest = () => tagsBox;
    h.collections.host.onOpenChange(true);
    assert.equal(collBtn.classList.contains('active'), true);
    assert.equal(browseBtn.classList.contains('active'), false);
    assert.equal(h.el('jannySortSelect').classList.contains('browse-filter-hidden'), true);
    assert.equal(tagsBox.classList.contains('browse-filter-hidden'), true);
    h.collections.host.onOpenChange(false);
    assert.equal(browseBtn.classList.contains('active'), true);
    assert.equal(tagsBox.classList.contains('browse-filter-hidden'), false);
});

test('opening and closing a preview resets and closes the collection picker', () => {
    const h = browseHarness();
    h.el('jannyCharModal');
    for (const id of ['jannyCharAvatar', 'jannyCharName', 'jannyCharCreator', 'jannyOpenInBrowserBtn', 'jannyCharTokens', 'jannyCharDate', 'jannyCharTags']) h.el(id);
    try { h.run("openPreviewModal({ id: 'a', name: 'A' })"); } catch { /* the rest of the modal is out of scope here */ }
    assert.equal(h.collections.calls.resetPicker, 1);
    h.run('closePreviewModal()');
    assert.ok(h.collections.calls.closePicker >= 1);
});

// ── Account ─────────────────────────────────────────────────────────

test('Janny search token avoids Cloudflare-prone page scraping on normal provider boot', () => {
    assert.match(api, /let _cachedToken = JANNY_FALLBACK_TOKEN;/);
    assert.doesNotMatch(api, /fetchWithProxy\(`\$\{JANNY_SITE_BASE\}\/characters\/search`\)/);
});

test('decode-gated browse images stay hidden until their full bitmap has decoded', () => {
    assert.match(browseViewJs, /img\.browse-decode-image\[data-src\]/);
    assert.match(browseViewJs, /const preloader = new Image\(\);[\s\S]*preloader\.decode\(\)\.then\(reveal\)/);
    assert.match(browseViewJs, /img\.src = src;[\s\S]*BrowseView\.adjustPortraitPosition/);
});

test('Janny browse removes obsolete bridge instructions', () => {
    assert.doesNotMatch(js + collectionsJs, /bridge userscript|cl-janny-bridge|cl-janitor-bridge|refresh the userscript|direct Supabase|copy cf_clearance/i);
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

test('cache invalidation removes account state, collections and rendered private surfaces', () => {
    const h = browseHarness();
    h.seedAccount();
    h.el('jannyGrid').innerHTML = 'Old private bookmark';
    h.el('jannyBookmarkBtn');
    h.run("jannyFilterOnlyBookmarked = true; jannyCharacters = [{ id: 'old-character' }];");
    assert.equal(typeof h.window.jannyInvalidateAccountCache, 'function');
    h.window.jannyInvalidateAccountCache();
    assert.equal(h.run('jannyBookmarksLoaded || jannyAccountStatus.active'), false);
    assert.equal(h.run('jannyBookmarkIds.size + jannyCharacters.length'), 0);
    assert.equal(h.run('jannyBookmarkTotalCount'), null);
    assert.equal(h.run('jannyBookmarkLimitToastShown'), false);
    assert.equal(h.collections.calls.invalidate, 1);
    assert.doesNotMatch(h.el('jannyGrid').innerHTML, /Old private/);
    assert.equal(h.el('jannyBookmarkBtn').classList.contains('favorited'), false);
});

test('the collections host reads the live account generation', () => {
    const h = browseHarness();
    const before = h.collections.host.getGeneration();
    h.window.jannyInvalidateAccountCache();
    assert.equal(h.collections.host.getGeneration(), before + 1);
});

test('account replacement discards pending loadJannyBookmarks(true)', async () => {
    const d = deferred();
    const h = browseHarness({ fetchJannyBookmarks: () => d.promise });
    h.seedAccount();
    const pending = h.run('loadJannyBookmarks(true)');
    await flush();
    h.window.jannyInvalidateAccountCache();
    d.resolve(['old-character']);
    await pending;
    assert.equal(h.run('jannyBookmarkIds.size'), 0);
    assert.equal(h.run('jannyBookmarksLoaded'), false);
});

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
