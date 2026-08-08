# JanitorAI Account Favorites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complete, account-backed JanitorAI favorites feed and server-authoritative Favorite/Unfavorite controls on desktop and through the existing mobile pancake menu.

**Architecture:** Keep transport and response normalization in `janitorai-api.js`, put the small testable membership cache and response-shape helpers in a new DOM-free `janitorai-favorites.js`, and keep UI/source state in `janitorai-browse.js`. The verified favorites feed reuses `/hampter/characters` with `favorites=true`; the mutation is implemented only after Task 1 captures Janitor's current first-party request contract from a signed-in session.

**Tech Stack:** Browser ES modules, JanitorAI Hampter/Supabase APIs, existing `hampterFetch` browser transport, Font Awesome, CSS, Node.js 22 built-in test runner.

## Global Constraints

- Work on `codex/janitorai-favorites-meili-latest`, based on `main` at `v7.0.4` design time.
- This plan produces the first implementation commit: `feat: add JanitorAI account favorites`.
- Use `hampterFetch` for every Janitor favorite read/write; do not add another auth, proxy, or browser layer.
- Never log or commit tokens, JWT/account values, personal favorite IDs, email addresses, or response bodies containing account data.
- Only route names, methods, request-key names, response-key names, and value types may enter the evidence note.
- Treat JWT or `/auth/v1/user` favorite data as a cache seed only; verified Hampter responses remain authoritative.
- Do not fabricate a favorite count when Janitor exposes none.
- No DataCat dependency, local SillyTavern favorite sync, grid-card hearts, bulk actions, background polling, or generic provider-auth refactor.
- Mobile favorite actions must reuse `.browse-fav-toggle` and the existing `app/library-mobile.js` pancake-menu bridge; do not add a second mobile handler.
- Preserve all existing Hampter sorts, Following behavior, hidden-definition recovery, imports, and provider defaults.
- Keep the complete branch below the repository's 1,500 hand-written-line review target.

---

### Task 1: Freeze the live Janitor favorite contract without exposing account data

**Files:**
- Create: `docs/superpowers/evidence/2026-08-08-janitorai-favorites-contract.md`
- Inspect: `modules/providers/janitor-session.js`
- Inspect: `modules/providers/janitorai/janitorai-api.js`
- Inspect: `extras/cl-helper/index.js:3041`

**Interfaces:**
- Consumes: a signed-in JanitorAI browser session already owned by the user.
- Produces: an evidence table naming the exact list, state (if present), favorite, and unfavorite route contracts; `favoriteClaimPaths: string[][]`; `favoriteAccountPaths: string[][]`; and whether the response provides `{ favorited, count }`.

- [ ] **Step 1: Confirm the favorites feed contract in the live Network panel**

Open JanitorAI's Favorites search while signed in, filter Network requests to `/hampter/characters`, and confirm that the request contains `favorites=true`, `page`, `mode`, and `sort`. Record only the relative path template, method, query-key names, top-level response-key names, and the types of `data`, `total`, `page`, and `size`.

The expected feed template, already corroborated by the first-party UI behavior, is:

```text
GET /hampter/characters?page=<number>&favorites=true&mode=<all|sfw>&sort=<HAMPTER_SORT>
```

If the live request differs, the live first-party request wins and the design evidence note must explain the difference before code changes begin.

- [ ] **Step 2: Capture favorite and unfavorite request shapes**

Choose one non-sensitive test character, clear the Network panel, click its Janitor heart once, wait for completion, and click it again to restore the starting state. For each write record only:

```text
operation | relative /hampter path template | method | JSON request key names/types | status | JSON response key names/types or "empty"
```

Do not copy headers, request values, IDs, tokens, cookies, or full response bodies. Restore the character to its original favorite state before leaving the page.

- [ ] **Step 3: Determine whether a per-character state route exists**

Reload the character page with Network recording enabled. If a request returns current-account membership, record its route/method and only the response shape. If no such request exists, record `state route: absent`; the implementation will use the complete paginated favorites membership set.

- [ ] **Step 4: Inspect JWT and `/auth/v1/user` shapes with a keys-and-types-only extractor**

Run this only in the signed-in page console. It prints key paths and primitive types, never primitive values:

```js
function shapeOnly(value, path = [], out = []) {
    if (Array.isArray(value)) {
        out.push({ path: path.join('.'), type: 'array' });
        if (value.length) shapeOnly(value[0], [...path, '[]'], out);
        return out;
    }
    if (value && typeof value === 'object') {
        out.push({ path: path.join('.'), type: 'object' });
        for (const [key, child] of Object.entries(value)) shapeOnly(child, [...path, key], out);
        return out;
    }
    out.push({ path: path.join('.'), type: value === null ? 'null' : typeof value });
    return out;
}

const raw = localStorage.getItem('sb-mcmzxtzommpnxkynddbo-auth-token');
const session = raw ? JSON.parse(raw) : null;
const payload = session?.access_token
    ? JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    : null;
console.table(shapeOnly(payload).filter(row => /fav|character|user_metadata|app_metadata/i.test(row.path)));
```

Inspect the `/auth/v1/user` Network response with the same `shapeOnly` function applied to the parsed object. Record matching favorite-related paths only. If none exist, record `favorite fields: absent` for that source.

- [ ] **Step 5: Write the sanitized evidence note**

Use this exact document structure, filling the cells solely from Steps 1-4:

```markdown
# JanitorAI Favorites Contract Evidence

Date observed: 2026-08-08
Environment: first-party JanitorAI web client, authenticated user session

| Operation | Relative path template | Method | Request keys/types | Response keys/types | Notes |
| --- | --- | --- | --- | --- | --- |
| List favorites | Copy the observed relative template | Copy the observed method | Copy key names and types | Copy key names and types | Paginated |
| Read membership | Copy the observed template or write `absent` | Copy the observed method or write `n/a` | Copy key names/types or write `n/a` | Copy key names/types or write `n/a` | State source decision |
| Favorite | Copy the observed relative template | Copy the observed method | Copy key names and types | Copy key names/types or write `empty` | Original state restored |
| Unfavorite | Copy the observed relative template | Copy the observed method | Copy key names and types | Copy key names/types or write `empty` | Original state restored |

JWT favorite-related paths: absent or a key-path/type list
`/auth/v1/user` favorite-related paths: absent or a key-path/type list
Count source: listing, detail, state, mutation, or absent
Browser transport method widening required: yes/no and the exact method
```

- [ ] **Step 6: Apply the discovery gate**

Proceed only if both write operations have stable `/hampter/` contracts and restoring the original state succeeded. If either write cannot be identified or verified, stop this plan before editing production code and report that Janitor's current mutation contract is unavailable.

Do not commit this task separately; the evidence note is included in the single favorites implementation commit.

---

### Task 2: Add the testable favorite cache and response normalizers

**Files:**
- Create: `modules/providers/janitorai/janitorai-favorites.js`
- Create: `tests/janitorai-favorites.test.mjs`

**Interfaces:**
- Consumes: sanitized field paths and response-key shapes from Task 1.
- Produces: `normalizeJanitoraiId(value): string`; `readPath(root, path): unknown`; `extractFavoriteSeed(root, paths): string[]`; `normalizeFavoriteState(payload, shape): { favorited: boolean, count: number|null }|null`; and `JanitoraiFavoriteCache` with `syncIdentity`, `clear`, `seed`, `replace`, `get`, and `set`.

- [ ] **Step 1: Write failing unit tests for identity normalization, cache semantics, and shape-only seed extraction**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    JanitoraiFavoriteCache,
    extractFavoriteSeed,
    normalizeFavoriteState,
    normalizeJanitoraiId,
} from '../modules/providers/janitorai/janitorai-favorites.js';

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
```

- [ ] **Step 2: Run the tests and verify they fail because the module does not exist**

Run:

```powershell
node --experimental-default-type=module --test tests/janitorai-favorites.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `janitorai-favorites.js`.

- [ ] **Step 3: Implement the minimal DOM-free helper module**

```js
export function normalizeJanitoraiId(value) {
    return value == null ? '' : String(value).trim().toLowerCase();
}

export function readPath(root, path) {
    return (path || []).reduce((value, key) => value == null ? undefined : value[key], root);
}

export function extractFavoriteSeed(root, paths) {
    const out = new Set();
    for (const path of paths || []) {
        const value = readPath(root, path);
        const rows = Array.isArray(value) ? value : [];
        for (const row of rows) {
            const id = normalizeJanitoraiId(typeof row === 'object' ? (row?.id ?? row?.character_id) : row);
            if (id) out.add(id);
        }
    }
    return [...out];
}

export function normalizeFavoriteState(payload, { statePath, countPath } = {}) {
    const favorited = readPath(payload, statePath || []);
    if (typeof favorited !== 'boolean') return null;
    const rawCount = countPath?.length ? readPath(payload, countPath) : null;
    const count = rawCount === null || rawCount === undefined || rawCount === ''
        ? null
        : (Number.isFinite(Number(rawCount)) ? Math.max(0, Number(rawCount)) : null);
    return { favorited, count };
}

export function isJanitoraiLoadCurrent({ capturedToken, currentToken, capturedSource, currentSource, active }) {
    return !!active && capturedToken === currentToken && capturedSource === currentSource;
}

export function isJanitoraiSelectionCurrent({ capturedToken, currentToken, capturedId, selectedId }) {
    return capturedToken === currentToken && normalizeJanitoraiId(capturedId) === normalizeJanitoraiId(selectedId);
}

export class JanitoraiFavoriteCache {
    constructor() { this.clear(); }
    clear(identity = '') {
        this.identity = String(identity || '');
        this.ids = new Set();
        this.complete = false;
        this.loadedAt = 0;
    }
    syncIdentity(identity) {
        const next = String(identity || '');
        if (next === this.identity) return false;
        this.clear(next);
        return true;
    }
    seed(ids) {
        for (const value of ids || []) {
            const id = normalizeJanitoraiId(value);
            if (id) this.ids.add(id);
        }
    }
    replace(ids, loadedAt = Date.now()) {
        this.ids.clear();
        this.seed(ids);
        this.complete = true;
        this.loadedAt = loadedAt;
    }
    get(value) {
        const id = normalizeJanitoraiId(value);
        if (!id) return undefined;
        if (this.ids.has(id)) return true;
        return this.complete ? false : undefined;
    }
    set(value, favorited) {
        const id = normalizeJanitoraiId(value);
        if (!id) return;
        if (favorited) this.ids.add(id);
        else this.ids.delete(id);
    }
}
```

Use the exact `statePath` and `countPath` arrays established in Task 1. If no state/count response exists, callers do not invoke `normalizeFavoriteState` for that source.

- [ ] **Step 4: Run the focused tests**

Run:

```powershell
node --experimental-default-type=module --test tests/janitorai-favorites.test.mjs
```

Expected: 4 tests PASS.

---

### Task 3: Expose account identity and safe optional favorite seeds from the Janitor session

**Files:**
- Modify: `modules/providers/janitor-session.js:15-208`
- Modify: `tests/janitorai-favorites.test.mjs`

**Interfaces:**
- Consumes: `extractFavoriteSeed(payload, favoriteClaimPaths)` from Task 2 and the exact paths found in Task 1.
- Produces: `decodeJanitoraiClaims(jwt): { email, expMs, subject, favoriteIds }`; `janitoraiSessionStatus(): { loggedIn, email?, expMs?, hasRefresh?, identity?, favoriteIds? }`; and the browser event `janitorai:session-changed` with `{ identity, favoriteIds }` only.

- [ ] **Step 1: Add failing tests for safe claim decoding inputs**

Add a pure exported helper to the test import and test only a synthetic payload:

```js
test('extractFavoriteSeed ignores unrelated account fields', () => {
    const payload = {
        sub: 'account-a',
        user_metadata: { theme: 'dark', favorite_ids: ['A'] },
        app_metadata: { provider: 'email' },
    };
    assert.deepEqual(extractFavoriteSeed(payload, [['user_metadata', 'favorite_ids']]), ['a']);
    assert.deepEqual(extractFavoriteSeed(payload, [['app_metadata', 'favorites']]), []);
});

test('session source never logs decoded favorite or identity values', async () => {
    const source = await readFile(new URL('../modules/providers/janitor-session.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /console\.(?:log|info|debug)\([^\n]*(?:favoriteIds|subject|identity)/);
});
```

Add `readFile` from `node:fs/promises` to the test imports. Run the focused test command and expect both new tests to PASS; they protect extraction and logging rules before session wiring.

- [ ] **Step 2: Extend decoded claims without logging account values**

Import `extractFavoriteSeed` and define the discovered paths as immutable arrays. When Task 1 found no JWT favorite field, the exact value is an empty array:

```js
const JANITORAI_JWT_FAVORITE_PATHS = Object.freeze([]);

export function decodeJanitoraiClaims(jwt) {
    try {
        const p = JSON.parse(atob(String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return {
            email: p.email || '',
            expMs: (p.exp || 0) * 1000,
            subject: String(p.sub || ''),
            favoriteIds: extractFavoriteSeed(p, JANITORAI_JWT_FAVORITE_PATHS),
        };
    } catch {
        return { email: '', expMs: 0, subject: '', favoriteIds: [] };
    }
}
```

If Task 1 found a JWT field, replace the empty array with the exact sanitized key path. Do not add console output.

- [ ] **Step 3: Emit identity changes on session set, dead refresh, and logout**

```js
function notifyJanitoraiSessionChanged(token = '') {
    const { subject, favoriteIds } = decodeJanitoraiClaims(token);
    window.dispatchEvent(new CustomEvent('janitorai:session-changed', {
        detail: { identity: subject, favoriteIds },
    }));
}
```

Call this after a successful `janitoraiSetSession`, after `doRefresh` stores a rotated access token, after a definitively dead refresh clears settings, and after `janitoraiLogout`. Update `janitoraiSessionStatus` to include `identity: subject` and `favoriteIds` without changing its existing fields.

If Task 1 found favorite IDs only in `/auth/v1/user`, extend `janitoraiVerifyToken` to parse that response into `{ valid, identity, favoriteIds }` using the recorded account paths, return no raw payload, and pass that seed into the same event after successful session verification.

- [ ] **Step 4: Run syntax and unit checks**

Run:

```powershell
node --check modules/providers/janitor-session.js
node --experimental-default-type=module --test tests/janitorai-favorites.test.mjs
```

Expected: syntax check exits 0 and all tests PASS.

---

### Task 4: Add normalized favorites feed and mutation API functions

**Files:**
- Modify: `modules/providers/janitorai/janitorai-api.js:12-270`
- Modify only if Task 1 requires a method other than GET/POST: `extras/cl-helper/index.js:3041-3097`
- Modify: `tests/janitorai-favorites.test.mjs`

**Interfaces:**
- Consumes: Task 1's exact write/state contracts; `normalizeFavoriteState`; existing `normalizeHampterHit`; existing `hampterFetch(path, { signal, method, jsonBody })`.
- Produces: `fetchJanitoraiFavorites(opts): Promise<{ characters, total, page, pageSize, hasMore }>`; optional `fetchJanitoraiFavoriteState(id, opts): Promise<{ favorited, count }|null>`; and `setJanitoraiFavorite(id, favorited, opts): Promise<{ favorited, count }|null>`.

- [ ] **Step 1: Add failing pure tests for favorite feed path construction and pagination**

Extend `janitorai-favorites.js` with a planned `buildJanitoraiFavoritesPath` export, then write the tests first:

```js
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
```

Expected before implementation: FAIL because both exports are missing.

- [ ] **Step 2: Implement the pure request/meta helpers**

```js
export function buildJanitoraiFavoritesPath({ page = 1, mode = 'all', sort = 'latest', search = '', tagIds = [] } = {}) {
    const params = new URLSearchParams({ page: String(page), favorites: 'true', mode, sort });
    if (search) params.set('search', search);
    for (const id of tagIds) params.append('tag_id[]', String(id));
    return `/characters?${params}`;
}

export function normalizeFavoritePageMeta(payload, requestedPage, fallbackSize) {
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const page = Number(payload?.page) || requestedPage;
    const pageSize = Number(payload?.size) || fallbackSize;
    const total = Number(payload?.total) || 0;
    return {
        total,
        page,
        pageSize,
        hasMore: total > 0 ? page * pageSize < total : rows.length === pageSize,
    };
}
```

- [ ] **Step 3: Implement the authenticated favorites feed wrapper**

```js
export async function fetchJanitoraiFavorites(opts = {}) {
    const path = buildJanitoraiFavoritesPath(opts);
    const data = await hampterFetch(path, { signal: opts.signal });
    const meta = normalizeFavoritePageMeta(data, opts.page || 1, HAMPTER_PAGE_SIZE);
    return {
        characters: (data?.data || []).map(normalizeHampterHit),
        ...meta,
    };
}
```

The call must not set `anon: true`. Preserve all filtering keys that Task 1 proved the favorites feed accepts; unsupported exclusions remain client-side.

- [ ] **Step 4: Implement state and mutation wrappers from the frozen evidence contract**

Use the exact path, method, body, and response paths recorded in Task 1. The public API boundary must retain these signatures regardless of Janitor's raw envelope:

```js
export async function fetchJanitoraiFavoriteState(id, { signal } = {}) {
    if (!id || !FAVORITE_STATE_ROUTE) return null;
    const data = await hampterFetch(FAVORITE_STATE_ROUTE(String(id)), { signal });
    return normalizeFavoriteState(data, FAVORITE_STATE_RESPONSE_SHAPE);
}

export async function setJanitoraiFavorite(id, favorited, { signal } = {}) {
    if (!id) return null;
    const request = buildVerifiedFavoriteMutation(String(id), !!favorited);
    const data = await hampterFetch(request.path, {
        signal,
        method: request.method,
        jsonBody: request.jsonBody,
    });
    return normalizeFavoriteState(data, request.responseShape);
}
```

`FAVORITE_STATE_ROUTE`, `FAVORITE_STATE_RESPONSE_SHAPE`, and `buildVerifiedFavoriteMutation` are literal implementations of the sanitized Task 1 evidence, not inferred names. When no state route exists, set `FAVORITE_STATE_ROUTE = null`. When mutation responses do not carry state, return `null`; the browse layer performs remote verification before changing local state.

- [ ] **Step 5: Widen the browser helper only when the observed mutation requires it**

If Task 1 records GET/POST only, leave `extras/cl-helper/index.js` unchanged. If it records `DELETE`, make the narrow change:

```js
const allowedMethods = new Set(['GET', 'POST', 'DELETE']);
if (!allowedMethods.has(method)) {
    return res.status(400).json({ error: 'method must be GET, POST, or DELETE' });
}
```

If it records another method, add only that exact method. Keep path validation restricted to `/hampter/`, keep the body type/size checks, and run `node --check extras/cl-helper/index.js`.

- [ ] **Step 6: Run focused verification**

Run:

```powershell
node --check modules/providers/janitorai/janitorai-api.js
node --check extras/cl-helper/index.js
node --experimental-default-type=module --test tests/janitorai-favorites.test.mjs
```

Expected: both syntax checks exit 0 and all unit tests PASS.

---

### Task 5: Add the My Favorites listing source, filters, and cache lifecycle

**Files:**
- Modify: `modules/providers/janitorai/janitorai-browse.js:53-475`
- Modify: `modules/providers/janitorai/janitorai-browse.js:1200-1760`
- Modify: `modules/providers/janitorai/janitorai-browse.js:1861-2258`
- Modify: `tests/janitorai-favorites.test.mjs`

**Interfaces:**
- Consumes: `fetchJanitoraiFavorites`, `fetchJanitoraiFavoriteState`, `setJanitoraiFavorite`, `JanitoraiFavoriteCache`, and `janitoraiSessionStatus().identity/favoriteIds`.
- Produces: `currentJanitoraiSource(): 'favorites'|'hampter'`; `ensureFavoriteMembershipLoaded({ force, signal })`; `jaFilterFavorites`; and favorites-aware `loadCharacters` behavior.

- [ ] **Step 1: Write source-priority and cache-invalidation tests against pure helpers**

Add pure exports to `janitorai-favorites.js` and extend the existing test import with `chooseJanitoraiSource`, `isJanitoraiLoadCurrent`, and `isJanitoraiSelectionCurrent`:

```js
export function chooseJanitoraiSource({ favorites }) {
    return favorites ? 'favorites' : 'hampter';
}

test('favorites has priority over the normal Hampter source', () => {
    assert.equal(chooseJanitoraiSource({ favorites: true }), 'favorites');
    assert.equal(chooseJanitoraiSource({ favorites: false }), 'hampter');
});

test('late source and modal responses are rejected', () => {
    assert.equal(isJanitoraiLoadCurrent({ capturedToken: 4, currentToken: 4, capturedSource: 'favorites', currentSource: 'favorites', active: true }), true);
    assert.equal(isJanitoraiLoadCurrent({ capturedToken: 4, currentToken: 5, capturedSource: 'favorites', currentSource: 'hampter', active: true }), false);
    assert.equal(isJanitoraiSelectionCurrent({ capturedToken: 2, currentToken: 2, capturedId: 'A', selectedId: 'a' }), true);
    assert.equal(isJanitoraiSelectionCurrent({ capturedToken: 2, currentToken: 3, capturedId: 'A', selectedId: 'B' }), false);
});
```

Run the focused test once before implementation and expect the missing export to fail; implement the four-line helper and rerun to PASS.

- [ ] **Step 2: Add browse state and identity synchronization**

At module scope add:

```js
let jaFilterFavorites = false;
let jaFavoritesPage = 1;
let jaFavoritesHasMore = true;
const jaFavoriteCache = new JanitoraiFavoriteCache();
let jaFavoriteMembershipPromise = null;
```

Add `syncFavoriteIdentity()` that reads `janitoraiSessionStatus()`, calls `jaFavoriteCache.syncIdentity(status.identity || '')`, seeds `status.favoriteIds`, and clears the active favorites source when signed out. Register one `janitorai:session-changed` listener during modal/event initialization and remove no user data from any other provider.

- [ ] **Step 3: Implement complete membership loading**

```js
async function ensureFavoriteMembershipLoaded({ force = false, signal } = {}) {
    syncFavoriteIdentity();
    if (!janitoraiSessionStatus()?.loggedIn) return false;
    if (!force && jaFavoriteCache.complete) return true;
    if (!force && jaFavoriteMembershipPromise) return jaFavoriteMembershipPromise;

    const identity = jaFavoriteCache.identity;
    jaFavoriteMembershipPromise = (async () => {
        const ids = [];
        let page = 1;
        let hasMore = true;
        while (hasMore) {
            const result = await fetchJanitoraiFavorites({ page, mode: 'all', sort: 'latest', signal });
            if (identity !== jaFavoriteCache.identity) return false;
            ids.push(...result.characters.map(hit => hit.character_id));
            hasMore = result.hasMore;
            page++;
        }
        jaFavoriteCache.replace(ids);
        return true;
    })();
    try { return await jaFavoriteMembershipPromise; }
    finally { jaFavoriteMembershipPromise = null; }
}
```

Use the same abort signal and load-generation checks as listing loads. Favorite feed pages also call `jaFavoriteCache.seed` immediately, but only an exhausted scan sets `complete=true`.

- [ ] **Step 4: Route listing loads through the selected source**

At the start of each load capture `const source = chooseJanitoraiSource({ favorites: jaFilterFavorites })`. Favorites calls `fetchJanitoraiFavorites`; Hampter retains `fetchJanitoraiCharacters`. Store `jaFavoritesPage/jaFavoritesHasMore` separately or reset them on every source change. Before applying results require all three conditions:

```js
if (!isJanitoraiLoadCurrent({
    capturedToken: thisToken,
    currentToken: jaLoadToken,
    capturedSource: source,
    currentSource: currentJanitoraiSource(),
    active: delegatesInitialized,
})) return;
```

Keep Hide Owned, Hide Possible, NSFW, persistent excluded tags, search, and tag behavior. When the favorites endpoint does not support a filter, apply it client-side and continue paging until at least 12 visible hits or exhaustion, matching the existing Hampter compensation loop.

- [ ] **Step 5: Add My Favorites to Features and wire login gating**

Render this above the existing Library section:

```html
<div class="dropdown-section-title">Personal <span style="font-size: 0.8em; opacity: 0.6;">(requires login)</span>:</div>
<label class="filter-checkbox"><input type="checkbox" id="janitoraiFilterFavorites"> <i class="fa-solid fa-heart" style="color: #e74c3c;"></i> My Favorites</label>
<hr style="margin: 8px 0; border-color: var(--glass-border);">
<div class="dropdown-section-title">Library:</div>
```

On change, reject signed-out activation by restoring `checked=false`, keeping `jaFilterFavorites=false`, and showing Janitor Settings/login guidance. On accepted activation clear creator filters, force Browse mode, reset source paging, abort the previous load through the existing controller, and load once. On deactivation restore the selected Hampter sort and load once.

- [ ] **Step 6: Add favorites-specific empty and error states**

Use distinct copy:

```text
No JanitorAI favorites yet
Favorite characters on JanitorAI and they will appear here.
```

When the raw favorites page had rows but active client filters removed all visible hits, use:

```text
No favorites match these filters
Relax your search, tags, NSFW, or library filters.
```

On `HAMPTER_LOGIN_REQUIRED` or definitively dead `HAMPTER_TOKEN_EXPIRED`, uncheck/revert My Favorites, clear the cache, and direct the user to Janitor Settings. Rate-limit/Cloudflare failures retain current cards and the active filter.

- [ ] **Step 7: Reset the correct state during lifecycle changes**

On DOM recreation reset favorites paging and checkbox state but retain the cache only when the account identity is unchanged. On provider deactivation abort the request and invalidate late results without discarding a valid same-account membership cache. On logout, account identity change, or definitively dead session clear the cache and active filter immediately.

- [ ] **Step 8: Run syntax and unit checks**

```powershell
node --check modules/providers/janitorai/janitorai-browse.js
node --experimental-default-type=module --test tests/janitorai-favorites.test.mjs
```

Expected: syntax check exits 0 and all tests PASS.

---

### Task 6: Add the authoritative preview heart and mobile pancake-menu integration

**Files:**
- Modify: `modules/providers/janitorai/janitorai-browse.js:500-820`
- Modify: `modules/providers/janitorai/janitorai-browse.js:1702-1751`
- Modify: `modules/providers/janitorai/janitorai-browse.js:2011-2050`
- Modify: `modules/providers/janitorai/janitorai-browse.css`
- Modify: `tests/janitorai-favorites.test.mjs`
- Verify without changing unless a defect is found: `app/library-mobile.js:3781-3797`

**Interfaces:**
- Consumes: `jaSelectedChar`, `jaDetailToken`, favorite cache/API functions, and the shared `.browse-fav-toggle` mobile bridge.
- Produces: `paintJanitoraiFavoriteButton({ favorited, count, loading })`; `resolveJanitoraiFavoriteState(hit, token)`; and `toggleJanitoraiFavorite()`.

- [ ] **Step 1: Add a failing markup integration test**

Use source text because the repository has no DOM test harness:

```js
import { readFile } from 'node:fs/promises';

test('Janitor preview exposes the shared mobile favorite hook', async () => {
    const browse = await readFile(new URL('../modules/providers/janitorai/janitorai-browse.js', import.meta.url), 'utf8');
    const mobile = await readFile(new URL('../app/library-mobile.js', import.meta.url), 'utf8');
    assert.match(browse, /id="janitoraiCharFavoriteBtn"[^>]*browse-fav-toggle/);
    assert.match(mobile, /querySelector\('\.browse-fav-toggle'\)/);
    assert.match(mobile, /Unfavorite/);
});
```

Expected before markup implementation: FAIL on the Janitor button assertion.

- [ ] **Step 2: Add compact preview markup**

Place the heart in the existing `.browse-char-meta` line after the creator identity:

```html
<span id="janitoraiCharFavoriteBtn" class="janitorai-fav-btn-inline browse-fav-toggle" title="Add to favorites on JanitorAI">
    <i class="fa-regular fa-heart"></i>
    <span id="janitoraiCharFavoriteCount" hidden></span>
</span>
```

The count span remains hidden when count is `null`; zero is displayed only when Janitor authoritatively supplies zero.

- [ ] **Step 3: Implement stale-safe state resolution**

On every preview open remove `favorited/loading`, reset the icon/count, capture the character UUID and `jaDetailToken`, then resolve in this order:

1. `hit._isFavorited` when boolean.
2. `jaFavoriteCache.get(id)`.
3. Task 1's per-character state route when present.
4. `ensureFavoriteMembershipLoaded()` when no state route exists.

Before painting, call `isJanitoraiSelectionCurrent` with the captured/current token and UUIDs. Signed-out users keep a clickable unfilled heart with login guidance rather than a false disabled state.

- [ ] **Step 4: Implement server-authoritative toggling**

```js
async function toggleJanitoraiFavorite() {
    const hit = jaSelectedChar;
    const id = hit?.character_id || hit?.id;
    const btn = document.getElementById('janitoraiCharFavoriteBtn');
    if (!id || btn?.classList.contains('loading')) return;
    if (!janitoraiSessionStatus()?.loggedIn) {
        showToast('Add your JanitorAI session in Settings to manage favorites.', 'warning', 7000);
        return;
    }

    const desired = !btn.classList.contains('favorited');
    const token = jaDetailToken;
    paintJanitoraiFavoriteButton({ favorited: !desired, count: currentFavoriteCount(hit), loading: true });
    try {
        let state = await setJanitoraiFavorite(id, desired);
        if (!state) state = await verifyJanitoraiFavoriteState(id, desired);
        if (!state || state.favorited !== desired) throw new Error('JanitorAI did not confirm the favorite change');
        if (token !== jaDetailToken || String(id) !== String(jaSelectedChar?.character_id || jaSelectedChar?.id)) return;
        applyConfirmedJanitoraiFavorite(hit, state);
    } catch (error) {
        if (token === jaDetailToken) paintJanitoraiFavoriteButton({ favorited: !desired, count: currentFavoriteCount(hit), loading: false });
        showJanitoraiFavoriteError(error);
    }
}
```

`verifyJanitoraiFavoriteState` uses the state route when available; otherwise it forces a complete favorites refresh and compares cache membership. `applyConfirmedJanitoraiFavorite` updates the heart, optional count, `hit._isFavorited`, normalized count field, cache Set, and every matching object in `jaCharacters`.

- [ ] **Step 5: Remove an unfavorited card only after confirmation**

When `jaFilterFavorites && state.favorited === false`, remove the matching UUID from `jaCharacters`, reset `jaGridRenderedCount`, rerender the grid, and close the modal if desired by existing modal behavior. Do not remove or decrement anything on request failure or ambiguous response.

- [ ] **Step 6: Wire the single handler and add compact CSS**

Register:

```js
on('janitoraiCharFavoriteBtn', 'click', toggleJanitoraiFavorite);
```

Add styles modeled on the existing provider hearts:

```css
.janitorai-fav-btn-inline {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    color: #ff6b6b;
    transition: background 0.2s ease, opacity 0.2s ease;
}

.janitorai-fav-btn-inline:hover,
.janitorai-fav-btn-inline.favorited { background: rgba(255, 100, 100, 0.12); }
.janitorai-fav-btn-inline.favorited i { font-weight: 900; }
.janitorai-fav-btn-inline.loading { pointer-events: none; opacity: 0.6; }
```

Do not add mobile-only Janitor handlers. The inline metadata is hidden by the shared mobile modal layout; `.browse-fav-toggle` makes the existing pancake menu create a fresh Favorite/Unfavorite action with the current class state each time it opens.

- [ ] **Step 7: Run focused tests and syntax checks**

```powershell
node --check modules/providers/janitorai/janitorai-browse.js
node --experimental-default-type=module --test tests/janitorai-favorites.test.mjs
```

Expected: syntax check exits 0 and all unit/markup tests PASS.

---

### Task 7: Verify account favorites end to end and create the first implementation commit

**Files:**
- Verify: all files changed by Tasks 1-6

**Interfaces:**
- Consumes: completed account-favorites implementation.
- Produces: one verified, reviewable Git commit containing favorites and its evidence/tests only.

- [ ] **Step 1: Run the complete automated verification set on the final tree**

```powershell
node --check modules/providers/janitor-session.js
node --check modules/providers/janitorai/janitorai-api.js
node --check modules/providers/janitorai/janitorai-browse.js
node --check extras/cl-helper/index.js
node --experimental-default-type=module --test tests/janitorai-favorites.test.mjs
git diff --check
```

Expected: every command exits 0; all tests PASS; `git diff --check` prints nothing.

- [ ] **Step 2: Inspect scope, secrets, and hand-written size**

```powershell
git diff --stat
git diff --numstat
git diff -- docs/superpowers/evidence modules/providers/janitor-session.js modules/providers/janitorai extras/cl-helper/index.js tests/janitorai-favorites.test.mjs
rg -n "access_token|refresh_token|Authorization: Bearer|sb-auth-auth-token|@[A-Za-z0-9._%+-]+\.[A-Za-z]{2,}" docs/superpowers/evidence tests modules/providers/janitorai
```

Expected: only scoped files changed; no actual credentials/account values; hand-written total remains below 1,500 lines. The existing source-code identifiers `access_token` and `refresh_token` may match, but evidence/tests must contain no values.

- [ ] **Step 3: Perform desktop manual checks**

Verify signed out, signed in, empty list, multi-page list, Hide Owned, Hide Possible, NSFW, tags, search, favorite, unfavorite, count-present/count-absent behavior, removal from active My Favorites, logout, account change, rate limit/Cloudflare guidance, and rapid modal/source switching.

- [ ] **Step 4: Perform mobile manual checks**

At a narrow phone viewport verify My Favorites in the Features sheet, open a Janitor preview, open the pancake button, confirm Favorite/Unfavorite label/icon state, perform both actions, reopen the menu to confirm updated state, and verify no creator-name overflow or inaccessible touch action.

- [ ] **Step 5: Stage the exact favorites scope and commit**

```powershell
git add docs/superpowers/evidence/2026-08-08-janitorai-favorites-contract.md modules/providers/janitor-session.js modules/providers/janitorai/janitorai-api.js modules/providers/janitorai/janitorai-browse.js modules/providers/janitorai/janitorai-browse.css modules/providers/janitorai/janitorai-favorites.js tests/janitorai-favorites.test.mjs
```

Add `extras/cl-helper/index.js` only if Task 1 required method widening. Then commit:

```powershell
git commit -m "feat: add JanitorAI account favorites"
```

- [ ] **Step 6: Verify the commit boundary**

```powershell
git show --stat --oneline HEAD
git status --short
```

Expected: the commit contains favorites/evidence/tests only; the working tree is clean before starting the optional Meili plan.
