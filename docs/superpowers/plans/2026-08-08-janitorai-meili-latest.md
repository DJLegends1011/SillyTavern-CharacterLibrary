# Experimental JanitorAI Meili Latest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one explicitly experimental `Latest (Meili)` JanitorAI listing source ordered by `createdAtStamp:desc`, while keeping preview, import, linking, updates, and favorites Janitor-native.

**Architecture:** A small DOM-free adapter builds the exact Janny Meili request and normalizes hits into Janitor's existing card shape. `janitorai-browse.js` adds the persisted sort value and extends source selection to `favorites > meili > hampter`; the existing abort controller and load generation prevent results from different sources from mixing.

**Tech Stack:** Browser ES modules, existing `meiliMultiSearch`, Janny MeiliSearch index, JanitorAI browse UI, Node.js 22 built-in test runner.

## Global Constraints

- Start only after the JanitorAI account-favorites commit is complete and the working tree is clean.
- This plan produces the second implementation commit: `feat: add experimental JanitorAI Meili Latest`.
- Add exactly one experimental sort value: persisted value `meili_latest`, label `Latest (Meili)`.
- The only Meili sort is exactly `createdAtStamp:desc`.
- Keep all current Hampter sorts and Hampter Latest unchanged.
- Do not import from DataCat or add a DataCat Freshest option/dependency.
- Meili is listing-only; selected UUIDs must use existing Janitor detail, favorite, import, link, and update paths.
- Missing chat/message fields normalize to zero; never borrow DataCat fields.
- A Meili failure is source-specific and must not silently fall back to Hampter or DataCat.
- Mobile uses the existing sort selector proxy/filter sheet; do not add a second mobile sort control.
- Persisted unknown/retired Janitor sort values fall back to `popular`.
- Reverting this commit must leave Janitor account favorites fully functional.
- Keep the complete branch below the repository's 1,500 hand-written-line review target.

---

### Task 1: Build and test the pure Meili request/normalization adapter

**Files:**
- Create: `modules/providers/janitorai/janitorai-meili-latest.js`
- Create: `tests/janitorai-meili-latest.test.mjs`

**Interfaces:**
- Consumes: raw Janny Meili hits; `resolveTagNames(ids)` and `JANNY_IMAGE_BASE` supplied by the caller.
- Produces: `JANITORAI_MEILI_SORT = 'meili_latest'`; `buildJanitoraiMeiliRequest(opts): MeiliOptions`; `normalizeJanitoraiMeiliHit(hit, deps): JanitorHit`; and `normalizeJanitoraiMeiliPage(response, deps): { characters, page, totalPages, hasMore }`.

- [ ] **Step 1: Write failing tests for the exact request shape**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    JANITORAI_MEILI_SORT,
    buildJanitoraiMeiliRequest,
    normalizeJanitoraiMeiliHit,
    normalizeJanitoraiMeiliPage,
} from '../modules/providers/janitorai/janitorai-meili-latest.js';

test('builds newest-only Meili request with SFW and numeric include tags', () => {
    assert.equal(JANITORAI_MEILI_SORT, 'meili_latest');
    assert.deepEqual(buildJanitoraiMeiliRequest({
        search: 'witch', page: 3, limit: 80, nsfwEnabled: false, includeTagIds: [2, 5],
    }), {
        search: 'witch',
        page: 3,
        limit: 80,
        filters: ['isNsfw = false', 'tagIds = 2 AND tagIds = 5'],
        facets: ['isNsfw', 'tagIds'],
        sort: ['createdAtStamp:desc'],
        highlight: true,
    });
});

test('omits the SFW clause when NSFW is enabled', () => {
    const request = buildJanitoraiMeiliRequest({ nsfwEnabled: true });
    assert.deepEqual(request.sort, ['createdAtStamp:desc']);
    assert.equal(request.filters.includes('isNsfw = false'), false);
});
```

- [ ] **Step 2: Write failing tests for Janitor-shaped normalization and pagination**

```js
const deps = {
    imageBase: 'https://image.jannyai.com/bot-avatars/',
    resolveTagNames: ids => ids.map(id => ({ 2: 'Female', 5: 'OC' })[id] || `Tag ${id}`),
};

test('normalizes a Janny hit for Janitor-native preview and import', () => {
    assert.deepEqual(normalizeJanitoraiMeiliHit({
        id: 'ABC',
        name: 'Mage',
        avatar: 'mage.webp',
        description: 'Notes',
        creatorUsername: 'author',
        creatorId: 'creator-id',
        tagIds: [2, 5],
        createdAtStamp: 1_700_000_000,
        isNsfw: true,
        totalToken: 1234,
    }, deps), {
        character_id: 'ABC',
        name: 'Mage',
        avatar: 'https://image.jannyai.com/bot-avatars/mage.webp',
        description: 'Notes',
        creator_name: 'author',
        creator_id: 'creator-id',
        tags: [{ id: 2, name: 'Female', slug: 'female' }, { id: 5, name: 'OC', slug: 'oc' }],
        created_at: new Date(1_700_000_000 * 1000).toISOString(),
        is_nsfw: true,
        total_tokens: 1234,
        chat_count: 0,
        message_count: 0,
        _listingSource: 'meili',
    });
});

test('uses Meili totalPages and filters excluded numeric tags client-side', () => {
    const response = { results: [{ page: 2, totalPages: 4, hits: [
        { id: 'keep', name: 'Keep', tagIds: [2] },
        { id: 'drop', name: 'Drop', tagIds: [5] },
    ] }] };
    const page = normalizeJanitoraiMeiliPage(response, { ...deps, excludeTagIds: [5] });
    assert.deepEqual(page.characters.map(hit => hit.character_id), ['keep']);
    assert.equal(page.page, 2);
    assert.equal(page.totalPages, 4);
    assert.equal(page.hasMore, true);
});
```

- [ ] **Step 3: Run the tests and verify the module-not-found failure**

```powershell
node --experimental-default-type=module --test tests/janitorai-meili-latest.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement the minimal pure adapter**

```js
export const JANITORAI_MEILI_SORT = 'meili_latest';

function finiteNumber(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function buildJanitoraiMeiliRequest({
    search = '', page = 1, limit = 80, nsfwEnabled = false, includeTagIds = [],
} = {}) {
    const filters = [];
    if (!nsfwEnabled) filters.push('isNsfw = false');
    if (includeTagIds.length) filters.push(includeTagIds.map(id => `tagIds = ${Number(id)}`).join(' AND '));
    return {
        search,
        page,
        limit,
        filters,
        facets: ['isNsfw', 'tagIds'],
        sort: ['createdAtStamp:desc'],
        highlight: true,
    };
}

export function normalizeJanitoraiMeiliHit(hit, { imageBase = '', resolveTagNames = () => [] } = {}) {
    const ids = Array.isArray(hit?.tagIds) ? hit.tagIds.map(Number).filter(Number.isFinite) : [];
    const names = resolveTagNames(ids);
    const created = hit?.createdAt || (hit?.createdAtStamp ? new Date(Number(hit.createdAtStamp) * 1000).toISOString() : '');
    const avatar = hit?.avatar && !/^https?:\/\//i.test(hit.avatar) ? `${imageBase}${hit.avatar}` : (hit?.avatar || '');
    return {
        character_id: hit?.id || '',
        name: hit?.name || 'Unknown',
        avatar,
        description: hit?.description || '',
        creator_name: hit?.creatorUsername || hit?.creatorName || hit?.creatorId || '',
        creator_id: hit?.creatorId || '',
        tags: ids.map((id, index) => {
            const name = names[index] || `Tag ${id}`;
            return { id, name, slug: String(name).toLowerCase().replace(/\s+/g, '-') };
        }),
        created_at: created,
        is_nsfw: !!hit?.isNsfw,
        total_tokens: finiteNumber(hit?.totalToken),
        chat_count: 0,
        message_count: 0,
        _listingSource: 'meili',
    };
}

export function normalizeJanitoraiMeiliPage(response, deps = {}) {
    const result = response?.results?.[0] || {};
    const excluded = new Set((deps.excludeTagIds || []).map(Number));
    const hits = (result.hits || []).filter(hit => !(hit.tagIds || []).some(id => excluded.has(Number(id))));
    const page = Number(result.page) || 1;
    const totalPages = Number(result.totalPages) || 1;
    return {
        characters: hits.map(hit => normalizeJanitoraiMeiliHit(hit, deps)),
        page,
        totalPages,
        hasMore: page < totalPages,
    };
}
```

- [ ] **Step 5: Run focused tests**

```powershell
node --experimental-default-type=module --test tests/janitorai-meili-latest.test.mjs
```

Expected: 4 tests PASS.

---

### Task 2: Add the Meili fetch boundary and three-source selection

**Files:**
- Modify: `modules/providers/janitorai/janitorai-api.js:1-270`
- Modify: `modules/providers/janitorai/janitorai-favorites.js`
- Modify: `tests/janitorai-favorites.test.mjs`
- Modify: `tests/janitorai-meili-latest.test.mjs`

**Interfaces:**
- Consumes: `meiliMultiSearch`, `resolveTagNames`, `JANNY_IMAGE_BASE`, and adapter exports from Task 1.
- Produces: `fetchJanitoraiMeiliLatest(opts): Promise<{ characters, page, totalPages, hasMore }>` and `chooseJanitoraiSource({ favorites, sort }): 'favorites'|'meili'|'hampter'`.

- [ ] **Step 1: Extend the source-priority test before changing implementation**

```js
test('source priority is favorites, then Meili, then Hampter', () => {
    assert.equal(chooseJanitoraiSource({ favorites: true, sort: 'meili_latest' }), 'favorites');
    assert.equal(chooseJanitoraiSource({ favorites: false, sort: 'meili_latest' }), 'meili');
    assert.equal(chooseJanitoraiSource({ favorites: false, sort: 'latest' }), 'hampter');
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
```

Extend the existing favorites-test import with `isJanitoraiLoadCurrent`. Expected: FAIL until `chooseJanitoraiSource` accepts `sort` and recognizes `meili_latest`; the stale-response assertion remains green from the favorites implementation.

- [ ] **Step 2: Implement the exact priority rule**

```js
export function chooseJanitoraiSource({ favorites, sort }) {
    if (favorites) return 'favorites';
    if (sort === 'meili_latest') return 'meili';
    return 'hampter';
}
```

- [ ] **Step 3: Add the Meili API wrapper**

Import the shared Janny helper and pure adapter:

```js
import { JANNY_IMAGE_BASE, meiliMultiSearch, resolveTagNames } from '../janny/janny-api.js';
import {
    buildJanitoraiMeiliRequest,
    normalizeJanitoraiMeiliPage,
} from './janitorai-meili-latest.js';

export async function fetchJanitoraiMeiliLatest(opts = {}) {
    const request = buildJanitoraiMeiliRequest(opts);
    const response = await meiliMultiSearch(request);
    return normalizeJanitoraiMeiliPage(response, {
        imageBase: JANNY_IMAGE_BASE,
        resolveTagNames,
        excludeTagIds: opts.excludeTagIds || [],
    });
}
```

Do not add Janitor access tokens or `hampterFetch` to the Meili listing call. Selected hits remain UUID-compatible with existing Janitor detail/import paths.

- [ ] **Step 4: Verify request and source tests**

```powershell
node --check modules/providers/janitorai/janitorai-api.js
node --experimental-default-type=module --test tests/janitorai-favorites.test.mjs tests/janitorai-meili-latest.test.mjs
```

Expected: syntax exits 0 and all tests PASS.

---

### Task 3: Add the Experimental sort and integrate Meili pagination without source mixing

**Files:**
- Modify: `modules/providers/janitorai/janitorai-browse.js:53-475`
- Modify: `modules/providers/janitorai/janitorai-browse.js:1250-1335`
- Modify: `modules/providers/janitorai/janitorai-browse.js:1500-1625`
- Modify: `modules/providers/janitorai/janitorai-browse.js:1861-1920`
- Modify: `modules/providers/janitorai/janitorai-browse.js:2128-2170`
- Modify: `tests/janitorai-meili-latest.test.mjs`

**Interfaces:**
- Consumes: `fetchJanitoraiMeiliLatest`, `JANITORAI_MEILI_SORT`, favorites-aware `chooseJanitoraiSource`, existing load token/controller, current search/NSFW/tag state.
- Produces: persisted sort value `meili_latest`; source-aware listing load and retry UI; Meili pagination using response `page/totalPages`.

- [ ] **Step 1: Add a failing static UI/persistence test**

```js
import { readFile } from 'node:fs/promises';

test('Janitor sort markup labels the single Meili option Experimental', async () => {
    const source = await readFile(new URL('../modules/providers/janitorai/janitorai-browse.js', import.meta.url), 'utf8');
    assert.match(source, /<optgroup label="Experimental">[\s\S]*meili_latest[\s\S]*Latest \(Meili\)[\s\S]*<\/optgroup>/);
});

test('persisted validation accepts Meili and retains popular fallback', async () => {
    const source = await readFile(new URL('../modules/providers/janitorai/janitorai-browse.js', import.meta.url), 'utf8');
    assert.match(source, /JANITORAI_SORTS/);
    assert.match(source, /'popular'/);
});
```

Expected before implementation: FAIL on both assertions.

- [ ] **Step 2: Separate accepted UI sorts from Hampter wire sorts**

Add:

```js
const JANITORAI_SORTS = [...HAMPTER_SORTS, JANITORAI_MEILI_SORT];
```

Use `JANITORAI_SORTS` for main sort change/default validation. Continue using `HAMPTER_SORTS` for creator-sort validation and any request sent to Hampter. In `applyDefaults`, invalid values explicitly set `jaSortMode = 'popular'` and update the select.

- [ ] **Step 3: Render one Experimental optgroup**

```html
<optgroup label="Experimental">
    ${sortOpt('meili_latest', '🧪 Latest (Meili)')}
</optgroup>
```

Keep the existing Date optgroup and `latest` option unchanged. The mobile settings proxy mirrors this real select automatically, including optgroup/option labels.

- [ ] **Step 4: Fetch by captured source**

At load start:

```js
const source = chooseJanitoraiSource({ favorites: jaFilterFavorites, sort: jaSortMode });
```

Branch exactly:

```js
const data = source === 'favorites'
    ? await fetchJanitoraiFavorites(favoriteOptions)
    : source === 'meili'
        ? await fetchJanitoraiMeiliLatest({
            search: jaCurrentSearch,
            page: jaCurrentPage,
            limit: 80,
            nsfwEnabled: jaNsfwEnabled,
            includeTagIds: [...jaIncludeTags],
            excludeTagIds: [...new Set([...jaExcludeTags, ...persistentExcludeTagIds])],
        })
        : await fetchJanitoraiCharacters(hampterOptions);
```

After each await call `isJanitoraiLoadCurrent` and reject the result unless the load token, active delegate state, and captured source all still match. For Meili set `jaTotalPages = data.totalPages`, `jaHasMore = data.hasMore`; do not divide by `HAMPTER_PAGE_SIZE`.

- [ ] **Step 5: Preserve client filters and auto-fetch behavior**

Run normalized Meili hits through existing Hide Owned, Hide Possible, and unresolved persistent-tag filters. Numeric excludes are already removed by the adapter. If client filters leave fewer than 12 hits, use the existing maximum of three compensating page fetches, passing the exact same source-specific options and checking the captured source after every await.

- [ ] **Step 6: Keep previews Janitor-native**

Card clicks already find normalized entries by `character_id` and call `openPreviewModal(hit)`. Preserve that path. The modal then calls `fetchJanitoraiCharacter(UUID)`; import, favorite, link, and update code must never receive a Janny provider identifier or DataCat row.

- [ ] **Step 7: Add source-specific error UI**

When `source === 'meili'`, render:

```js
renderBrowseError(grid, {
    provider: 'janitorai',
    error: err,
    title: 'Meili Latest failed',
    message: `JannyAI's experimental search source could not load: ${err.message}`,
    view: jaMode,
    flags: { source: 'meili', nsfw: jaNsfwEnabled },
    retry: () => loadCharacters(false),
});
```

Retain the previous source state and never mutate `jaSortMode` or call Hampter as a fallback.

- [ ] **Step 8: Reset source-specific transient state on switching/lifecycle**

Changing sort aborts the active controller through `loadCharacters(false)`, increments `jaLoadToken`, clears rendered/page state, and reloads once. DOM recreation/deactivation clears Meili transient paging just as it clears Hampter paging. Favorites precedence remains intact: choosing Meili while My Favorites is checked does not bypass favorites until the checkbox is disabled.

- [ ] **Step 9: Run syntax and focused tests**

```powershell
node --check modules/providers/janitorai/janitorai-browse.js
node --experimental-default-type=module --test tests/janitorai-favorites.test.mjs tests/janitorai-meili-latest.test.mjs
```

Expected: syntax exits 0 and all tests PASS.

---

### Task 4: Verify Meili Latest on desktop/mobile and create the reversible experiment commit

**Files:**
- Verify: all files changed by Tasks 1-3

**Interfaces:**
- Consumes: completed experimental source.
- Produces: one isolated, reversible Git commit containing Meili Latest and its tests only.

- [ ] **Step 1: Run the complete automated verification set on the final tree**

```powershell
node --check modules/providers/janitor-session.js
node --check modules/providers/janitorai/janitorai-api.js
node --check modules/providers/janitorai/janitorai-browse.js
node --check modules/providers/janitorai/janitorai-favorites.js
node --check modules/providers/janitorai/janitorai-meili-latest.js
node --experimental-default-type=module --test tests/janitorai-favorites.test.mjs tests/janitorai-meili-latest.test.mjs
git diff --check
```

Expected: every command exits 0; all tests PASS; `git diff --check` prints nothing.

- [ ] **Step 2: Inspect commit scope and size**

```powershell
git diff --stat HEAD
git diff --numstat HEAD
git diff HEAD -- modules/providers/janitorai tests/janitorai-meili-latest.test.mjs
rg -n "datacat|DataCat|freshest" modules/providers/janitorai/janitorai-meili-latest.js tests/janitorai-meili-latest.test.mjs
```

Expected: no DataCat import/dependency, no unrelated edits, and the full branch remains below 1,500 hand-written changed lines.

- [ ] **Step 3: Perform desktop manual verification**

Verify the Experimental optgroup, newest-first ordering, search, SFW/NSFW, include/exclude tags, persistent excludes, Hide Owned, Hide Possible, Load More, empty result, source-specific failure/Retry, native Janitor preview, favorite toggle, import, and rapid Hampter/Meili/Favorites switching without mixed results.

- [ ] **Step 4: Perform mobile manual verification**

At a narrow phone viewport open the mobile sort selector, confirm `Experimental → Latest (Meili)`, select it, load more, search, open a result, use the pancake Favorite/Unfavorite action, and import. Confirm no overflow and that switching back to Hampter Latest performs one clean reload.

- [ ] **Step 5: Stage only the experimental source and commit**

```powershell
git add modules/providers/janitorai/janitorai-api.js modules/providers/janitorai/janitorai-browse.js modules/providers/janitorai/janitorai-favorites.js modules/providers/janitorai/janitorai-meili-latest.js tests/janitorai-favorites.test.mjs tests/janitorai-meili-latest.test.mjs
git commit -m "feat: add experimental JanitorAI Meili Latest"
```

- [ ] **Step 6: Prove the commit is independently reversible**

```powershell
git show --stat --oneline HEAD
git diff HEAD^ -- modules/providers/janitor-session.js modules/providers/janitorai/janitorai-browse.css docs/superpowers/evidence/2026-08-08-janitorai-favorites-contract.md
git status --short
```

Expected: the second command prints nothing because the Meili commit does not alter session identity, favorite styling, or favorite contract evidence; the working tree is clean.
