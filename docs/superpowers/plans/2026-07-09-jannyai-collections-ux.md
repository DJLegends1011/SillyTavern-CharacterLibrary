# JannyAI Collections UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the `codex/jannyai-account-sync` branch's JannyAI collections UX to the approved CL-native/JannyAI-parity design: quick add/remove collection toggles in the character preview modal, public collection browsing, richer owned collection cards, owned collection management, review artifacts, and verified mobile layouts.

**Architecture:** Add narrowly scoped public JannyAI read routes and HTML parsers to `cl-helper`, expose typed client wrappers in `modules/providers/janny/janny-api.js`, then refactor `modules/providers/janny/janny-browse.js` so public collections, owned collections, modal membership state, and manage/edit state are separate. Style the new surfaces with existing CL browse/glass classes plus small Janny-specific additions in shared browse CSS and mobile overrides.

**Tech Stack:** Vanilla JavaScript ES modules, existing cl-helper Express router, Node built-in test runner, Character Library shared CSS, Font Awesome icons, existing in-app Browser/Playwright-style manual verification.

---

## Reference Inputs

- UX notes: `docs/superpowers/notes/2026-07-09-jannyai-account-sync-ux-notes.md`
- Approved spec: `docs/superpowers/specs/2026-07-09-jannyai-collections-ux-design.md`
- Current browse UI: `modules/providers/janny/janny-browse.js`
- Current API wrappers: `modules/providers/janny/janny-api.js`
- Current helper utilities: `extras/cl-helper/janny-account.js`
- Current helper routes: `extras/cl-helper/index.js`
- Shared browse styles: `modules/providers/browse-shared.css`
- Mobile overrides: `app/library-mobile.css`
- Current tests: `tests/janny-account.test.mjs`, `tests/janny-settings-account.test.mjs`

## Implementation Slices

Work in the order below. After each slice, run the listed verification commands and commit only that slice's files if the command output matches the expected result.

## Slice 1: Review Artifacts

- [ ] Create `docs/superpowers/artifacts/jannyai-collections-ux/`.
- [ ] Add `docs/superpowers/artifacts/jannyai-collections-ux/index.html` as a static, self-contained artifact using CL's dark glass/magenta styling.
  - The artifact MUST inline the real CL stylesheets (`app/library.css`, `modules/providers/browse-shared.css`, `app/library-mobile.css`) into a `<style>` block. Do NOT `<link>` them by relative path: a published Claude Artifact strips `<head>`/`<link>` and a strict CSP blocks external CSS, so linked styles render naked (this is exactly what broke the first pass). Add small wrapper neutralizers (`html,body{height:auto;overflow:auto}`, `.app-container{min-height:0}` for nested phone frames, etc.).
- [ ] The artifact must show these named sections with `data-state` attributes so reviewers can inspect every target state:
  - `data-state="desktop-modal-closed"`
  - `data-state="desktop-modal-open"`
  - `data-state="desktop-modal-error"`
  - `data-state="mobile-modal-open"` — the 3-dot (kebab) menu open, with "Add to collection" listed alongside Open / Bookmark / Import (NOT inline action buttons; see Slice 8 mobile note)
  - `data-state="mobile-collections-sheet"` — after tapping "Add to collection", the full-width `.mobile-sheet` collections picker
  - `data-state="mobile-quick-import"` — quick-import setting on: the import square keeps the `⋮` kebab beside it, so collections stays reachable
  - `data-state="desktop-public-list"`
  - `data-state="mobile-public-list"`
  - `data-state="desktop-owned-list"`
  - `data-state="mobile-owned-list"`
  - `data-state="desktop-manage"`
  - `data-state="mobile-manage"`
- [ ] Use generated sample collection data only. Do not embed live JannyAI images; use gradient thumbnail blocks and initials so the artifact is deterministic.
- [ ] Keep card radius at or below the app's existing browse-card feel. Avoid marketing-page hero copy.
- [ ] Verify the artifact contains every state marker:

```powershell
rg -n "data-state=\"(desktop-modal-closed|desktop-modal-open|desktop-modal-error|mobile-modal-open|mobile-collections-sheet|mobile-quick-import|desktop-public-list|mobile-public-list|desktop-owned-list|mobile-owned-list|desktop-manage|mobile-manage)\"" docs/superpowers/artifacts/jannyai-collections-ux/index.html
```

Expected output: twelve matching lines, one for each state marker.

- [ ] Commit this slice:

```powershell
git add docs/superpowers/artifacts/jannyai-collections-ux/index.html
git commit -m "Add Janny collections UX artifacts"
```

## Slice 2: Public Parser Tests First

- [ ] Edit `tests/janny-account.test.mjs`.
- [ ] Extend the import list from `../extras/cl-helper/janny-account.js` with:

```js
    parseJannyPublicCollectionsPage,
    parseJannyPublicCollectionDetailPage,
    validateJannyPublicCollectionPath,
    validateJannyPublicCharacterIds,
```

- [ ] Add this test after `parseJannyBookmarkPage extracts count and unique character links`:

```js
test('parseJannyPublicCollectionsPage extracts public collection cards', () => {
    const html = `
        <main>
            <a class="collection-card" href="/collections/11111111-1111-4111-8111-111111111111_daily-finds">
                <img src="https://image.jannyai.com/bot-avatars/a.webp" alt="">
                <img src="https://image.jannyai.com/bot-avatars/b.webp" alt="">
                <h2>Daily Finds</h2>
                <p>A public list worth browsing.</p>
                <span>12 characters</span>
                <span>by Yuuri</span>
                <span>1.2K views</span>
                <time datetime="2026-07-08">Jul 8, 2026</time>
            </a>
            <a class="collection-card" href="https://jannyai.com/collections/22222222-2222-4222-8222-222222222222_lore-box">
                <h3>Lore Box</h3>
                <p>Plot-heavy cards.</p>
                <span>3 cards</span>
                <span>by Archivist</span>
                <span>48 views</span>
            </a>
        </main>
    `;

    const parsed = parseJannyPublicCollectionsPage(html);
    assert.equal(parsed.collections.length, 2);
    assert.deepEqual(parsed.collections[0], {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Daily Finds',
        path: '/collections/11111111-1111-4111-8111-111111111111_daily-finds',
        url: 'https://jannyai.com/collections/11111111-1111-4111-8111-111111111111_daily-finds',
        description: 'A public list worth browsing.',
        characterCount: 12,
        ownerName: 'Yuuri',
        viewCount: 1200,
        updatedAt: '2026-07-08',
        images: [
            'https://image.jannyai.com/bot-avatars/a.webp',
            'https://image.jannyai.com/bot-avatars/b.webp',
        ],
    });
    assert.equal(parsed.collections[1].characterCount, 3);
    assert.equal(parsed.collections[1].ownerName, 'Archivist');
    assert.equal(parsed.hasMore, false);
});
```

- [ ] Add this test below it:

```js
test('parseJannyPublicCollectionDetailPage extracts metadata and unique character ids', () => {
    const html = `
        <article>
            <h1>Daily Finds</h1>
            <p>Collected cards with strong intros.</p>
            <span>by Yuuri</span>
            <span>12 characters</span>
            <span>1,234 views</span>
            <time datetime="2026-07-08">Jul 8, 2026</time>
            <a href="/characters/33333333-3333-4333-8333-333333333333_character-one">One</a>
            <a href="https://jannyai.com/characters/44444444-4444-4444-8444-444444444444_character-two">Two</a>
            <a href="/characters/33333333-3333-4333-8333-333333333333_character-one">Duplicate</a>
        </article>
    `;

    const parsed = parseJannyPublicCollectionDetailPage(html, '/collections/11111111-1111-4111-8111-111111111111_daily-finds');
    assert.equal(parsed.collection.id, '11111111-1111-4111-8111-111111111111');
    assert.equal(parsed.collection.name, 'Daily Finds');
    assert.equal(parsed.collection.description, 'Collected cards with strong intros.');
    assert.equal(parsed.collection.ownerName, 'Yuuri');
    assert.equal(parsed.collection.characterCount, 12);
    assert.equal(parsed.collection.viewCount, 1234);
    assert.equal(parsed.collection.updatedAt, '2026-07-08');
    assert.deepEqual(parsed.characterIds, [
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
    ]);
});
```

- [ ] Add this validator test below the detail parser test:

```js
test('Janny public collection validators accept only narrow read inputs', () => {
    assert.equal(validateJannyPublicCollectionPath('/collections/11111111-1111-4111-8111-111111111111_daily-finds').ok, true);
    assert.equal(validateJannyPublicCollectionPath('/collections/11111111-1111-4111-8111-111111111111_daily-finds/edit').ok, false);
    assert.equal(validateJannyPublicCollectionPath('https://evil.example/collections/11111111-1111-4111-8111-111111111111_x').ok, false);

    assert.equal(validateJannyPublicCharacterIds('33333333-3333-4333-8333-333333333333,44444444-4444-4444-8444-444444444444').ok, true);
    assert.equal(validateJannyPublicCharacterIds('../../../etc/passwd').ok, false);
});
```

- [ ] Run the test and confirm it fails only because the new exports do not exist yet:

```powershell
node --test tests/janny-account.test.mjs
```

Expected failure: a `SyntaxError` or import error naming the missing public parser/validator exports.

## Slice 3: Public Parser Implementation

- [ ] Edit `extras/cl-helper/janny-account.js`.
- [ ] Add these constants near the existing path regex constants:

```js
const COLLECTION_PATH_RE = /^\/collections\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:_[^/?#]+)?$/i;
const CHARACTER_LINK_RE = /href=["'](https:\/\/jannyai\.com)?(\/characters\/[0-9a-f-]+(?:_[^"'?#\s<>]+)?)/ig;
```

- [ ] Keep `CHARACTER_PATH_RE` as the strict final ID validator.
- [ ] Add these helper functions after `parseJannyBookmarkPage`:

```js
function decodeJannyHtml(text) {
    return String(text || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x2F;/g, '/');
}

function stripJannyTags(text) {
    return decodeJannyHtml(String(text || '').replace(/<[^>]*>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

function parseJannyCompactNumber(value) {
    const raw = String(value || '').replace(/,/g, '').trim();
    const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)(k|m)?$/i);
    if (!match) return null;
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return null;
    const suffix = (match[2] || '').toLowerCase();
    if (suffix === 'm') return Math.round(base * 1_000_000);
    if (suffix === 'k') return Math.round(base * 1_000);
    return Math.round(base);
}
```

- [ ] Add exported validators:

```js
export function validateJannyPublicCollectionPath(path) {
    const parsed = parseAccountPath(path);
    if (!parsed) return { ok: false, error: 'collection path is required' };
    if (parsed.searchParams.size !== 0) return { ok: false, error: 'collection path cannot include query parameters' };
    if (!COLLECTION_PATH_RE.test(parsed.pathname)) return { ok: false, error: 'collection path is not public-readable' };
    return { ok: true, path: parsed.pathname };
}

export function validateJannyPublicCharacterIds(ids) {
    const value = String(ids || '').trim();
    if (!csvIdsAreSafe(value)) return { ok: false, error: 'character ids are invalid' };
    return { ok: true, ids: value.split(',').map(id => id.trim()) };
}
```

- [ ] Add exported parser `parseJannyPublicCollectionsPage(html)` that:
  - scans each `<a>` block whose `href` is a valid `COLLECTION_PATH_RE`
  - deduplicates by collection ID
  - extracts name from first `<h1>`, `<h2>`, `<h3>`, `aria-label`, or `title`
  - extracts description from first `<p>`
  - extracts character count with `/([0-9,]+)\s*(?:characters|cards)/i`
  - extracts owner with `/\bby\s+([^<]+?)(?:\s{2,}|$)/i` from stripped block text
  - extracts views with `/([0-9,.]+[km]?)\s*views/i`
  - extracts `updatedAt` from `datetime="..."`
  - extracts up to four image sources from `<img src="...">`
  - returns `{ collections, hasMore }`, where `hasMore` is true when a link containing `rel="next"` or visible text `Next` exists.
- [ ] Add exported parser `parseJannyPublicCollectionDetailPage(html, path = '')` that:
  - uses `validateJannyPublicCollectionPath(path)` to seed `collection.id`, `path`, and `url` when a path is provided
  - extracts name, description, ownerName, characterCount, viewCount, updatedAt, and up to four images with the same helpers as the list parser
  - scans unique character links with `CHARACTER_LINK_RE` and validates them with `CHARACTER_PATH_RE`
  - returns `{ collection, characterIds, characterUrls }`
- [ ] Update `parseJannyBookmarkPage` to reuse `CHARACTER_LINK_RE` if doing so does not change existing test results.
- [ ] Run:

```powershell
node --test tests/janny-account.test.mjs
node --check extras/cl-helper/janny-account.js
```

Expected output: all `janny-account` tests pass and `node --check` prints no output.

- [ ] Commit this slice:

```powershell
git add extras/cl-helper/janny-account.js tests/janny-account.test.mjs
git commit -m "Parse Janny public collection pages"
```

## Slice 4: Public Helper Routes

- [ ] Edit `extras/cl-helper/index.js`.
- [ ] Extend the existing import from `./janny-account.js` with:

```js
    parseJannyPublicCollectionsPage,
    parseJannyPublicCollectionDetailPage,
    validateJannyPublicCollectionPath,
    validateJannyPublicCharacterIds,
```

- [ ] Add a helper near `fetchJannyAccountDirect`:

```js
function buildJannyPublicCollectionsPath({ sort = 'latest', page = 1 } = {}) {
    const normalizedSort = sort === 'popular' ? 'popular' : 'latest';
    const normalizedPage = Math.max(1, Math.min(500, Number.parseInt(String(page || 1), 10) || 1));
    const params = new URLSearchParams();
    params.set('page', String(normalizedPage));
    params.set('sort', normalizedSort);
    return `/collections?${params.toString()}`;
}
```

- [ ] Add `fetchJannyPublicOnce({ path, dispatcher })` beside `fetchJannyAccountOnce`. It must use:
  - `buildJannyAccountUrl(path)` for URL construction
  - `GET` only
  - no `Cookie` header
  - `User-Agent`, `Accept`, `Accept-Language`, and `Referer` headers matching the account fetch
  - the same Cloudflare detection pattern as `fetchJannyAccountOnce`
- [ ] Add `fetchJannyPublicDirect({ path })` beside `fetchJannyAccountDirect`. It must use the same IPv6/IPv4 family loop and remember `jannyPreferredFamily` on the first non-Cloudflare result.
- [ ] Inside `registerJannyAccountRoutes(router)`, before `router.post('/janny-proxy'...)`, add:

```js
    router.get('/janny-public-collections', async (req, res) => {
        const path = buildJannyPublicCollectionsPath({
            sort: typeof req.query?.sort === 'string' ? req.query.sort : 'latest',
            page: typeof req.query?.page === 'string' ? req.query.page : '1',
        });
        try {
            const result = await fetchJannyPublicDirect({ path });
            if (result.cloudflare) return res.status(403).json({ error: 'Cloudflare challenge', cloudflare: true });
            if (!result.ok) return res.status(result.status || 502).json({ error: `HTTP ${result.status}` });
            res.json({ ok: true, status: result.status, ...parseJannyPublicCollectionsPage(result.body) });
        } catch (err) {
            console.error('[cl-helper] JannyAI public collections error:', err.message);
            res.status(502).json({ error: `Failed to reach JannyAI: ${err.message}` });
        }
    });
```

- [ ] Add `router.get('/janny-public-collection', ...)` that:
  - reads `req.query.path`
  - validates with `validateJannyPublicCollectionPath`
  - fetches the validated path using `fetchJannyPublicDirect`
  - returns `{ ok: true, status, ...parseJannyPublicCollectionDetailPage(result.body, validation.path) }`
  - returns `400` for invalid path, `403` for Cloudflare, upstream status for non-OK, and `502` for fetch errors.
- [ ] Add `router.get('/janny-public-characters', ...)` that:
  - reads `req.query.ids`
  - validates with `validateJannyPublicCharacterIds`
  - fetches `/api/get-characters?ids=<encoded csv>` using `fetchJannyPublicDirect`
  - summarizes JSON with `summarizeJannyResponseForClient`
  - returns `{ ok: true, status, characters: summary.json?.characters || [] }`
  - returns `400`, `403`, upstream status, or `502` using the same rules as above.
- [ ] Run:

```powershell
node --check extras/cl-helper/index.js
node --test tests/janny-account.test.mjs
```

Expected output: syntax check prints no output and tests pass.

- [ ] Commit this slice:

```powershell
git add extras/cl-helper/index.js
git commit -m "Add Janny public collection helper routes"
```

## Slice 5: Client API Wrappers

- [ ] Edit `modules/providers/janny/janny-api.js`.
- [ ] Add this helper below `helperRequest`:

```js
async function helperJsonGet(path, params = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && String(value) !== '') query.set(key, String(value));
    }
    const suffix = query.toString();
    const resp = await helperRequest(`${path}${suffix ? `?${suffix}` : ''}`);
    const data = await resp.json().catch(() => null);
    if (!resp.ok || data?.cloudflare) {
        const err = new Error(data?.error || (data?.cloudflare ? 'Cloudflare challenge' : `HTTP ${resp.status}`));
        err.status = resp.status;
        err.cloudflare = !!data?.cloudflare;
        err.payload = data;
        throw err;
    }
    return data || {};
}
```

- [ ] Add these exported functions after `fetchJannyCollections`:

```js
export async function fetchJannyPublicCollections({ sort = 'latest', page = 1 } = {}) {
    return helperJsonGet(`${CL_HELPER_PLUGIN_BASE}/janny-public-collections`, { sort, page });
}

export async function fetchJannyPublicCollection(path) {
    return helperJsonGet(`${CL_HELPER_PLUGIN_BASE}/janny-public-collection`, { path });
}

export async function fetchJannyPublicCharactersByIds(ids) {
    const characterIDs = toIdArray(ids);
    if (!characterIDs.length) return [];
    const out = [];
    for (let i = 0; i < characterIDs.length; i += JANNY_GET_CHARACTERS_CHUNK) {
        const chunk = characterIDs.slice(i, i + JANNY_GET_CHARACTERS_CHUNK);
        const data = await helperJsonGet(`${CL_HELPER_PLUGIN_BASE}/janny-public-characters`, { ids: chunk.join(',') });
        if (Array.isArray(data.characters)) out.push(...data.characters);
    }
    return out;
}
```

- [ ] Add these exported functions after `createJannyCollection`:

```js
export async function updateJannyCollection({ id, name, description = '', isPrivate = true } = {}, options = {}) {
    const body = { id, name, description, isPrivate: isPrivate ? 'yes' : 'no' };
    const data = await jannyAccountProxy('POST', '/collections/form/edit-collection', body, options);
    return { success: true, location: data.location || '' };
}

export async function deleteJannyCollection(id, options = {}) {
    const data = await jannyAccountProxy('POST', '/collections/form/delete-collection', { id }, options);
    return { success: true, location: data.location || '' };
}
```

- [ ] Run:

```powershell
node --check modules/providers/janny/janny-api.js
```

Expected output: no syntax errors.

- [ ] Commit this slice:

```powershell
git add modules/providers/janny/janny-api.js
git commit -m "Expose Janny collection API wrappers"
```

## Slice 6: Static UX Guard Tests

- [ ] Add `tests/janny-collections-ux-static.test.mjs`.
- [ ] The test file should read `modules/providers/janny/janny-browse.js` and `modules/providers/browse-shared.css`.
- [ ] Add assertions for the final UI contract:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../modules/providers/janny/janny-browse.js', import.meta.url), 'utf8');
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
```

- [ ] Run the new test and confirm it fails because the UI code has not been refactored yet:

```powershell
node --test tests/janny-collections-ux-static.test.mjs
```

Expected failure: assertions naming missing IDs/classes.

## Slice 7: Browse State Refactor

- [ ] Edit `modules/providers/janny/janny-browse.js`.
- [ ] Extend the import from `./janny-api.js` with:

```js
    fetchJannyPublicCollections,
    fetchJannyPublicCollection,
    fetchJannyPublicCharactersByIds,
    updateJannyCollection,
    deleteJannyCollection,
    removeJannyCharacterFromCollection,
```

- [ ] Replace the account collection state block with separated state:

```js
let jannyOwnedCollections = [];
let jannyOwnedCollectionsLoaded = false;
let jannyModalCollectionIds = new Set();
let jannyModalCollectionChecksLoadedFor = '';
let jannyCollectionDropdownOpen = false;
let jannyCollectionRowMutations = new Set();
let jannyCollectionsMode = 'public';
let jannyPublicCollections = [];
let jannyPublicCollectionsPage = 1;
let jannyPublicCollectionsHasMore = true;
let jannyPublicCollectionsLoading = false;
let jannyPublicCollectionsSort = 'latest';
let jannyCollectionCharacters = [];
let jannyActiveCollection = null;
let jannyManageCollection = null;
```

- [ ] Rename usages of `jannyCollections` to `jannyOwnedCollections` and `jannyCollectionsLoaded` to `jannyOwnedCollectionsLoaded`.
- [ ] Keep `jannyCollectionCharacters` and `jannyActiveCollection`, but store `jannyActiveCollection.kind` as `'public'` or `'owned'` whenever opening a collection.
- [ ] Rename `loadJannyCollections(force)` to `loadJannyOwnedCollections(force)`.
- [ ] Rename `renderJannyCollectionsList()` to `renderJannyOwnedCollectionsList()`.
- [ ] Update `refreshJannyAccountControlsForSelection()` to call `loadJannyOwnedCollections(false)` only when the account is active and owned collections are not loaded.
- [ ] Run:

```powershell
node --check modules/providers/janny/janny-browse.js
node --test tests/janny-account.test.mjs
```

Expected output: syntax check prints no output and account tests pass.

## Slice 8: Preview Modal Dropdown

- [ ] In `renderModals()` inside `modules/providers/janny/janny-browse.js`, replace the persistent `jannyCharAccountSection` markup with a modal-header action wrapper placed after the Bookmark button:

```html
<div class="janny-collection-action" id="jannyCollectionAction">
    <button id="jannyCollectionDropdownBtn" class="action-btn secondary" title="Add to Janny collection" aria-haspopup="menu" aria-expanded="false">
        <i class="fa-solid fa-layer-group"></i> <span>Add to collection</span> <i class="fa-solid fa-chevron-down janny-collection-caret"></i>
    </button>
    <div id="jannyCollectionDropdown" class="dropdown-menu janny-collection-dropdown hidden" role="menu"></div>
</div>
```

- [ ] Remove the old `<div class="browse-char-section" id="jannyCharAccountSection">...</div>`.
- [ ] Add `renderJannyCollectionDropdown()` that renders:
  - loading row when owned collections are loading
  - missing account row when `ensureJannyAccountReady()` fails
  - empty row with a button that switches to My Collections when there are no owned collections
  - one button row per collection with checkmark, truncated name, count, privacy icon, and row spinner when mutating
- [ ] Add `async function openJannyCollectionDropdown()` that:
  - opens the dropdown
  - sets `aria-expanded="true"`
  - calls `ensureJannyAccountReady()`
  - calls `loadJannyOwnedCollections(false)`
  - calls `refreshSelectedJannyCollectionMemberships()` for the current character
  - renders after each state change
- [ ] Add `function closeJannyCollectionDropdown()` that closes the dropdown and sets `aria-expanded="false"`.
- [ ] Add `async function refreshSelectedJannyCollectionMemberships()` that:
  - clears `jannyModalCollectionIds`
  - reads embedded `collectionCharacters` or `characters` arrays when present
  - for collections without embedded members and with `collectionCharacterCount(collection) > 0`, fetches `fetchJannyCollectionCharacters(collection.id, jannyAccountOptions())`
  - marks any collection containing `jannySelectedChar.id`
  - sets `jannyModalCollectionChecksLoadedFor` to the selected character ID
- [ ] Replace `addSelectedJannyToCollection(collectionId)` with `toggleSelectedJannyCollectionMembership(collectionId)`:
  - if current character is already in the collection, call `removeJannyCharacterFromCollection`
  - otherwise call `addJannyCharacterToCollection`
  - update `jannyModalCollectionIds` immediately after the request succeeds
  - update the collection count locally by `-1` or `+1`
  - keep the dropdown open
  - toast `Added <name> to <collection>.` or `Removed <name> from <collection>.`
  - refresh the active owned collection grid when it is currently open
- [ ] Update delegated events in `initJannyView()`:
  - remove `jannyAddToCollectionBtn` handling
  - add click handling for `jannyCollectionDropdownBtn`
  - add delegated click handling for `.janny-collection-toggle-row`
  - close on outside click and Escape key
- [ ] Ensure `openPreviewModal()` resets:

```js
jannyCollectionDropdownOpen = false;
jannyModalCollectionIds = new Set();
jannyModalCollectionChecksLoadedFor = '';
```

### Mobile behavior (verified against `app/library-mobile.js` / `app/library-mobile.css`)

On mobile, CL owns the online-card control row — we do NOT build a mobile button UI, but the design must account for how CL rewrites it:

- Under `@media (max-width:768px)`, `library-mobile.css:999` hides **every** inline `.action-btn` in `.browse-char-modal .modal-controls` (including our `jannyCollectionDropdownBtn`) and `library-mobile.js` injects one of two controls, chosen by the `cl-browse-quick-import` `<html>` class:
  - **kebab off (default):** a `⋮` `.mobile-more-actions-btn`. Tapping it opens `.mobile-more-actions-menu`, which mirrors each surviving `.action-btn` (clones `innerHTML`, proxies taps via `orig.click()`). Because `jannyCollectionDropdownBtn` is a normal `.action-btn`, "Add to collection" appears there automatically — no extra work.
  - **quick-import on:** by default CL shows only the import square and hides the kebab, which would strand Add to collection. **Decision (consistency):** keep the kebab in quick-import mode too, so the collections action — and every other action — always lives in the same `⋮` menu regardless of mode. **Scope this to the JannyAI modal only** — only JannyAI has collections in this branch, and other providers should keep CL's default quick-import behavior. The JannyAI overlay is `#jannyCharModal`, so the override is:

```css
/* JannyAI only: keep the kebab beside the import square so collections stays reachable */
html.cl-browse-quick-import #jannyCharModal .mobile-more-actions-btn { display: inline-flex; }
```

    The import square stays as the one-tap primary; the kebab carries the rest. Do NOT touch the global `.mobile-more-actions-btn` rule — that would change every provider's control row.
- **No stacked menus (answers the open question):** the kebab menu item handler is `closeMenu(); orig.click();` ([`library-mobile.js:3835`](../../app/library-mobile.js)). The kebab popover is removed *before* our button's click fires, so opening the collections sheet never leaves the kebab menu underneath it. A capture-phase document listener also closes the kebab on any outside tap. Our `openJannyCollectionDropdown()` therefore just needs to run on the (proxied) button click as normal.
- **The dropdown must present as a bottom sheet on mobile, not an anchored popover.** Its anchor button is `display:none` on mobile, so an absolutely-positioned `.janny-collection-dropdown` would land at a collapsed origin. Slice 13 pins it to a `position:fixed` bottom sheet (mirroring CL's own `.mobile-sheet`) so it is independent of the hidden anchor.
- Mirrored menu rows clone the button's `innerHTML`, so keep the desktop-only caret (`.janny-collection-caret`) hidden on mobile (or it shows a stray chevron inside the kebab row).

- [ ] Run:

```powershell
node --check modules/providers/janny/janny-browse.js
node --test tests/janny-collections-ux-static.test.mjs
```

Expected output after this slice: syntax check passes. Static test still fails only for Collections tab/CSS classes that are scheduled in later slices.

## Slice 9: Collections Tab Shell

- [ ] In `renderView()` in `modules/providers/janny/janny-browse.js`, replace the current `jannyCollectionsSection` contents with:
  - top banner with title `Janny Collections`
  - segmented controls `jannyCollectionsPublicBtn` and `jannyCollectionsMineBtn`
  - public toolbar with `jannyPublicCollectionsSort`, `jannyReloadCollectionsBtn`, and `jannyBackToBrowseBtn`
  - `jannyPublicCollectionsList`
  - `jannyOwnedCreatePanel`
  - `jannyOwnedCollectionsList`
  - `jannyCollectionDetailPanel`
  - `jannyCollectionManagePanel`
- [ ] Keep the existing `jannyBackToBrowseBtn` and `jannyReloadCollectionsBtn` IDs so existing event wiring has a stable migration path.
- [ ] Add `setJannyCollectionsMode(mode)`:
  - accepts only `'public'` or `'owned'`
  - toggles segmented active classes
  - hides/shows public list, owned list, create panel, detail panel, and manage panel
  - loads public collections on first public view
  - loads owned collections on first owned view after `ensureJannyAccountReady()`
- [ ] Update `switchJannyCollectionsPanel(show)`:
  - when showing, call `setJannyCollectionsMode(jannyCollectionsMode || 'public')`
  - do not require an account before public mode loads
- [ ] Update mobile filter metadata so the Collections button still opens the tab.
- [ ] Run:

```powershell
node --check modules/providers/janny/janny-browse.js
```

Expected output: no syntax errors.

## Slice 10: Public Collections Browse

- [ ] In `modules/providers/janny/janny-browse.js`, add:

```js
async function loadJannyPublicCollections({ reset = false } = {}) { /* uses fetchJannyPublicCollections */ }
function renderJannyPublicCollectionsList() { /* renders cards into #jannyPublicCollectionsList */ }
function createJannyCollectionCard(collection, { owned = false } = {}) { /* shared public/owned card markup */ }
async function openJannyPublicCollection(path) { /* detail fetch + public character fetch */ }
function renderJannyCollectionDetail() { /* metadata banner + existing Janny cards grid */ }
```

- [ ] `loadJannyPublicCollections` must:
  - honor `jannyPublicCollectionsLoading`
  - reset page/list when `reset` is true
  - call `fetchJannyPublicCollections({ sort: jannyPublicCollectionsSort, page: jannyPublicCollectionsPage })`
  - append new collections without duplicating IDs
  - set `jannyPublicCollectionsHasMore` from response `hasMore`
  - render loading, empty, error, and load-more states inside `jannyPublicCollectionsList`
- [ ] `createJannyCollectionCard` must show:
  - four-cell preview collage
  - name
  - description clamped in CSS
  - character count
  - owner when available
  - views when available
  - updated date when available
  - public cards get `Open`; owned cards get `Open`, `Edit`, and `Delete`
- [ ] `openJannyPublicCollection(path)` must:
  - call `fetchJannyPublicCollection(path)`
  - call `fetchJannyPublicCharactersByIds(response.characterIds)`
  - normalize fetched characters with `normalizeJannyCollectionCharacter`
  - set `jannyActiveCollection = { kind: 'public', ...response.collection }`
  - set `jannyCollectionCharacters`
  - render the detail panel
- [ ] Add delegated event handlers:
  - `.janny-public-collection-open`
  - `jannyPublicCollectionsLoadMoreBtn`
  - `jannyPublicCollectionsSort` change
  - `jannyCollectionDetailBackBtn`
- [ ] Run:

```powershell
node --check modules/providers/janny/janny-browse.js
node --test tests/janny-collections-ux-static.test.mjs
```

Expected output: syntax passes. Static test still fails only for CSS classes until Slice 13.

## Slice 11: My Collections Cards

- [ ] Update `renderJannyOwnedCollectionsList()` to render cards through `createJannyCollectionCard(collection, { owned: true })`.
- [ ] Add `getJannyCollectionPreviewImages(collection)` that returns up to four images from embedded character/member entries using `avatar`, `image`, `imageUrl`, or nested `character.avatar`.
- [ ] Add `openJannyOwnedCollection(collectionId)` by adapting the current `openJannyCollection(collectionId)`:
  - ensure account readiness
  - fetch `fetchJannyCollectionCharacters(collectionId, jannyAccountOptions())`
  - fill missing details with `fetchJannyCharactersByIds`
  - set `jannyActiveCollection = { kind: 'owned', ...collection }`
  - render the shared detail panel
- [ ] Keep create collection behavior, but render the create panel below the segmented controls and above owned cards only in owned mode.
- [ ] Add owned card buttons:
  - `.janny-owned-collection-open`
  - `.janny-owned-collection-edit`
  - `.janny-owned-collection-delete`
- [ ] Wire `.janny-owned-collection-open` to `openJannyOwnedCollection(collectionId)`.
- [ ] Wire `.janny-owned-collection-edit` to `openJannyCollectionManage(collectionId)`.
- [ ] Do not wire delete until Slice 12 confirmation UI is in place.
- [ ] Run:

```powershell
node --check modules/providers/janny/janny-browse.js
```

Expected output: no syntax errors.

## Slice 12: Owned Manage View

- [ ] Add `openJannyCollectionManage(collectionId)`:
  - ensure account readiness
  - find the collection in `jannyOwnedCollections`
  - fetch members with `fetchJannyCollectionCharacters`
  - normalize member rows
  - set `jannyManageCollection = { collection, characters, saving: false, error: '' }`
  - render `#jannyCollectionManagePanel`
- [ ] Add `renderJannyCollectionManage()` that renders:
  - back button to My Collections
  - name input `jannyManageCollectionName`
  - public/private segmented radio or two-button group `jannyManagePublicBtn` / `jannyManagePrivateBtn`
  - textarea `jannyManageCollectionDescription`
  - save button `jannyManageSaveBtn`
  - delete button `jannyManageDeleteBtn`
  - membership header `Characters (<count>)`
  - paste/add input `jannyManageAddCharacterInput`
  - add button `jannyManageAddCharacterBtn`
  - auto-save hint text
  - rows with `.janny-manage-character-remove`
- [ ] Add `saveJannyManagedCollection()`:
  - reads fields
  - calls `updateJannyCollection({ id, name, description, isPrivate }, jannyAccountOptions())`
  - updates the matching item in `jannyOwnedCollections`
  - rerenders owned list and manage header
  - toasts `Collection saved.`
- [ ] Add `parseJannyCharacterIdFromInput(value)` in `janny-browse.js`:

```js
function parseJannyCharacterIdFromInput(value) {
    const text = String(value || '').trim();
    const match = text.match(/\/characters\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:_[^/?#\s]+)?/i)
        || text.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    return match ? match[1] : '';
}
```

- [ ] Add `addCharacterToManagedCollection()`:
  - parse the input
  - call `addJannyCharacterToCollection(jannyManageCollection.collection.id, id, jannyAccountOptions())`
  - fetch public character details with `fetchJannyPublicCharactersByIds([id])`
  - append normalized row if it is not already present
  - clear the input
  - toast `Character added to collection.`
- [ ] Add `removeCharacterFromManagedCollection(characterId)`:
  - call `removeJannyCharacterFromCollection`
  - remove row from `jannyManageCollection.characters`
  - update counts in `jannyOwnedCollections`
  - toast `Character removed from collection.`
- [ ] Add `confirmAndDeleteJannyCollection(collectionId)`:
  - use the app's existing confirmation helper if one exists in `CoreAPI`; otherwise use `window.confirm('Delete this Janny collection? This cannot be undone from Character Library.')`
  - call `deleteJannyCollection(collectionId, jannyAccountOptions())`
  - remove from `jannyOwnedCollections`
  - return to owned list
  - toast `Collection deleted.`
- [ ] Wire manage events:
  - `jannyManageBackBtn`
  - `jannyManageSaveBtn`
  - `jannyManagePublicBtn`
  - `jannyManagePrivateBtn`
  - `jannyManageAddCharacterBtn`
  - `.janny-manage-character-remove`
  - `jannyManageDeleteBtn`
- [ ] Run:

```powershell
node --check modules/providers/janny/janny-browse.js
```

Expected output: no syntax errors.

## Slice 13: Desktop and Mobile CSS

- [ ] Edit `modules/providers/browse-shared.css`.
- [ ] Add a `JannyAI Collections UX` section near the browse card styles with classes:
  - `.janny-collection-action`
  - `.janny-collection-dropdown`
  - `.janny-collection-toggle-row`
  - `.janny-collection-toggle-row.is-member`
  - `.janny-collection-card-grid`
  - `.janny-collection-card`
  - `.janny-collection-preview`
  - `.janny-collection-preview-cell`
  - `.janny-collection-meta`
  - `.janny-collection-description`
  - `.janny-collection-toolbar`
  - `.janny-collection-segmented`
  - `.janny-collection-detail`
  - `.janny-collection-manage`
  - `.janny-manage-character-row`
- [ ] Use existing CSS variables: `--accent`, `--accent-rgb`, `--glass-border`, `--card-bg`, `--text-primary`, `--text-secondary`, `--radius-xl`, and `--touch-target-min`.
- [ ] Cap the preview collection list so many collections scroll instead of overflowing the modal:
  - Desktop: `.janny-collection-dropdown { max-height: min(320px, 60vh); overflow-y: auto; }` with a sticky `.janny-collection-dropdown-title` so the header stays put while rows scroll.
  - Mobile bottom sheet: `max-height` (CL's `.mobile-sheet` uses `88vh`) + `overflow-y: auto; overscroll-behavior: contain;` so the sheet scrolls internally and does not push the modal off-screen.
- [ ] Use line clamping for `.janny-collection-description`:

```css
.janny-collection-description {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
```

- [ ] Edit `app/library-mobile.css`.
- [ ] Replace the old `#jannyCharAccountSection` mobile rules with mobile dropdown rules:
  - `.janny-collection-dropdown` becomes a `position:fixed` bottom sheet below 480px (independent of its `display:none` anchor button — see Slice 8 mobile note), styled to match CL's own `.mobile-sheet` (rounded top, handle optional, `--cl-glass-bg`, safe-area bottom padding)
  - hide the desktop caret on mobile: `.janny-collection-caret { display: none; }` so the mirrored kebab-menu row doesn't show a stray chevron
  - keep the kebab in quick-import mode, scoped to JannyAI only: `html.cl-browse-quick-import #jannyCharModal .mobile-more-actions-btn { display: inline-flex; }` (do not alter the global rule — other providers keep CL's default)
  - rows have `min-height: var(--touch-target-min)`
  - `.janny-collection-card-grid` becomes one column
  - `.janny-collection-toolbar` wraps
  - `.janny-collection-manage` stacks fields and rows
- [ ] Run:

```powershell
node --test tests/janny-collections-ux-static.test.mjs
```

Expected output: all static UX guard tests pass.

- [ ] Commit Slices 7 through 13 together:

```powershell
git add modules/providers/janny/janny-browse.js modules/providers/browse-shared.css app/library-mobile.css tests/janny-collections-ux-static.test.mjs
git commit -m "Upgrade Janny collections UX"
```

## Slice 14: Full Verification

- [ ] Run syntax checks:

```powershell
node --check extras/cl-helper/janny-account.js
node --check extras/cl-helper/index.js
node --check modules/providers/janny/janny-api.js
node --check modules/providers/janny/janny-browse.js
```

Expected output: no syntax output from any command.

- [ ] Run all existing Node tests:

```powershell
node --test tests/*.mjs
```

Expected output: all tests pass.

- [ ] Use the in-app browser or local running SillyTavern instance for desktop verification:
  - Open the JannyAI provider browse view.
  - Open character `https://jannyai.com/characters/f207e6d4-205e-48c4-86a0-27b327bc651d_character-ruler-of-grain`.
  - Open the collection dropdown.
  - Add to `extra bookmarks`.
  - Confirm checked state appears without closing the dropdown.
  - Remove from `extra bookmarks`.
  - Confirm checked state clears without closing the dropdown.
  - Confirm the old persistent Collections section is absent.
- [ ] Desktop Collections tab verification:
  - Open Collections tab.
  - Confirm default is Public Collections.
  - Switch sort between Latest and Most popular.
  - Open a public collection and confirm metadata, description, and cards render.
  - Switch to My Collections.
  - Confirm owned cards show description, privacy, counts, preview cells, Open, Edit, and Delete.
  - Open an owned collection and import-preview a card.
  - Open Edit and verify metadata/membership layout.
- [ ] Mobile verification at 390 x 844 (test BOTH `cl-browse-quick-import` off and on):
  - Kebab off: open the preview modal, tap the `⋮` kebab, confirm the menu lists Open / Bookmark / Add to collection / Import. Tap "Add to collection"; confirm the kebab menu closes and the collections bottom sheet opens (no two menus stacked).
  - Kebab on (quick-import), JannyAI modal: confirm BOTH the import square and the `⋮` kebab show, and the kebab still lists Add to collection (Janny-scoped override working). Tapping the import square still does one-tap import.
  - Kebab on (quick-import), a non-Janny provider (e.g. Chub): confirm CL's default is unchanged — only the import square shows, no kebab. The override must not leak to other providers.
  - Preview modal collection picker opens as a viewport-safe bottom sheet.
  - With many owned collections (10+), the picker scrolls internally (desktop dropdown and mobile sheet both cap height + scroll) rather than growing past the modal/viewport.
  - Rows are tappable and do not clip behind modal edges.
  - Public collection cards are one column and descriptions clamp.
  - Public detail keeps Back visible above the grid.
  - My Collections cards do not horizontally scroll.
  - Manage fields stack, keyboard does not hide the member list controls, and remove buttons remain reachable.
- [ ] If manual verification exposes an upstream public sort query mismatch, change only `buildJannyPublicCollectionsPath` in `extras/cl-helper/index.js`, then rerun Slice 14 verification.
- [ ] Check git status:

```powershell
git status --short
git status --branch --short
```

Expected status after all commits: clean working tree, branch ahead of remote by the new local commits unless pushed separately.

## Self-Review Checklist

- [ ] Public browsing does not require `jannyAccountStatus.active`.
- [ ] Owned actions still require `ensureJannyAccountReady()`.
- [ ] The preview modal has no native `<select>` for collections.
- [ ] Dropdown add/remove uses row-level loading, not whole-modal disabling.
- [ ] Public, owned, detail, and manage state are separate from each other.
- [ ] Delete collection requires confirmation.
- [ ] Mobile CSS covers the dropdown, collection cards, detail view, and manage view.
- [ ] Mobile collections action is reached via CL's kebab menu, opens as a bottom sheet, and does not stack under the kebab popover. The kebab stays visible in quick-import mode too, scoped to `#jannyCharModal` only, so collections is reachable in both modes without changing any other provider's control row.
- [ ] Tests cover parser behavior, narrow public validators, and static UI contract.
- [ ] Final response reports whether work is uncommitted, committed, or pushed.
