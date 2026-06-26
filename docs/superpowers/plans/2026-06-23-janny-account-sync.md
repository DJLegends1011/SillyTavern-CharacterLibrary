# JannyAI account sync (cloud bookmarks) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an account-backed bookmark layer to the JannyAI provider so a user pasting their Supabase session token gets per-action bookmark sync with jannyai.com, a bookmark badge on browse cards, and a "Show only my bookmarks" filter.

**Architecture:**
- Browser cannot set `Cookie` headers in `fetch()`, so all authenticated calls go through new routes in the `cl-helper` ST plugin, which inject `Cookie: sb-access-token=<JWT>` server-side before hitting `jannyai.com/api/bookmark`.
- Client stores the JWT in a single Settings field (`jannyAccountToken`) and sends it on each request via an `x-janny-token` header. No server-side session map needed — the JWT is short enough to ride per-request.
- A module-scoped `Set<characterId>` of cloud bookmarks drives the bookmark badge and the "Show only my bookmarks" MeiliSearch filter; populated once on token validation and after each successful mutation.

**Tech Stack:** Vanilla JS modules, Node's built-in test runner with the existing browser-globals shim, Express routes in cl-helper, MeiliSearch `id IN […]` filtering for browse.

**Spec:** [docs/superpowers/specs/2026-06-23-janny-account-sync-design.md](../specs/2026-06-23-janny-account-sync-design.md)

**Test command (run from repo root):**
```
node --test --import=./tests/setup-browser-globals.mjs tests/janny-account.test.mjs
```

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `extras/cl-helper/janny-utils.js` | **new** | Token normalization, cookie header builder, response parsing — pure helpers, testable in isolation. |
| `extras/cl-helper/index.js` | modify | Add 4 routes: `GET/POST/DELETE /janny-bookmarks`, `POST /janny-bookmark-counter`. Token comes from `x-janny-token` request header. |
| `modules/providers/janny/janny-account.js` | **new** | Client-side: token getter, cached `Set<characterId>`, 4 endpoint wrappers, refresh function. |
| `modules/providers/janny/janny-provider.js` | modify | Flip `hasAuth` to true, return auth-status from `getAuthHeaders`, expose `getCurrentUserId` parsing the JWT `sub`. |
| `modules/providers/janny/janny-browse.js` | modify | Bookmark badge in `createJannyCard`, click handler with optimistic update, `jannyFilterOnlyBookmarked` state + MeiliSearch filter. |
| `app/library.html` | modify | New JannyAI Session Token field with hint and Connect button under the Janny settings section. |
| `app/library.js` | modify | Register `jannyAccountToken` default, wire Connect / Disconnect button handlers, trigger initial bookmark cache refresh on connect. |
| `tests/janny-account.test.mjs` | **new** | Cover pure helpers in `janny-utils.js` and `janny-account.js`: token normalization, URL building, response parsing, set updates. |

---

## Task 1: Settings storage + UI scaffolding

**Files:**
- Modify: `app/library.js:486` (defaults block)
- Modify: `app/library.html` (Janny settings section, near existing Janny controls)

- [ ] **Step 1: Add the setting default**

Open `app/library.js`, find the existing `datacatAccountToken: null,` line (around line 486) inside the defaults object. Add a new line just after it:

```js
    datacatAccountToken: null,
    jannyAccountToken: null,
```

- [ ] **Step 2: Find the Janny settings section in HTML**

Search `app/library.html` for the Janny-related settings group (look for an existing janny-prefixed control). Identify the closing `</div>` of that group — the new field goes just above it. If the file doesn't yet have a Janny account section, add a fresh `<div class="settings-section">` immediately after the DataCat account section (matching the wrapper structure used for `datacatAccountToken`).

- [ ] **Step 3: Add the token field**

Insert this block in the Janny settings section:

```html
<div class="settings-section">
    <h3 class="settings-section-title">JannyAI Account</h3>
    <p class="settings-hint">
        Paste your Supabase session token from <code>jannyai.com</code> to enable cloud bookmark sync.
        <a href="#" id="jannyAccountTokenHelpBtn">How to find this</a>
    </p>
    <div class="settings-row">
        <input type="password" id="settingsJannyAccountToken"
               class="settings-input"
               placeholder="sb-access-token (JWT)"
               autocomplete="off" spellcheck="false">
    </div>
    <div class="settings-row" style="gap: 8px;">
        <button id="jannyAccountTokenConnectBtn" class="settings-action-btn">
            <i class="fa-solid fa-link"></i> Connect Token
        </button>
        <button id="jannyAccountDisconnectBtn" class="settings-action-btn" style="display:none;">
            <i class="fa-solid fa-link-slash"></i> Disconnect
        </button>
        <span id="jannyAccountStatus" class="settings-status"></span>
    </div>
    <div id="jannyAccountTokenHelp" class="settings-hint" style="display:none;">
        <ol style="margin-top:6px;padding-left:20px;">
            <li>Sign in to <code>jannyai.com</code> in your browser.</li>
            <li>Open DevTools → Application → Cookies → <code>jannyai.com</code>.</li>
            <li>Copy the value of <code>sb-access-token</code>.</li>
            <li>Paste above and click Connect Token. Lasts ~7 days.</li>
        </ol>
    </div>
</div>
```

- [ ] **Step 4: Commit**

```bash
git add app/library.js app/library.html
git commit -m "feat(janny): scaffold JannyAI account token settings UI"
```

---

## Task 2: Pure helpers in `cl-helper/janny-utils.js` (TDD)

**Files:**
- Create: `extras/cl-helper/janny-utils.js`
- Create: `tests/janny-account.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/janny-account.test.mjs`:

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    normalizeJannyToken,
    buildJannyCookieHeaders,
    parseJannyBookmarksResponse,
    isJannyCharacterId,
} from '../extras/cl-helper/janny-utils.js';

describe('normalizeJannyToken', () => {
    it('trims and rejects empty/non-string', () => {
        assert.equal(normalizeJannyToken('  abc.def.ghi  '), 'abc.def.ghi');
        assert.equal(normalizeJannyToken(''), null);
        assert.equal(normalizeJannyToken('   '), null);
        assert.equal(normalizeJannyToken(null), null);
        assert.equal(normalizeJannyToken(123), null);
    });

    it('rejects values that look nothing like a JWT', () => {
        assert.equal(normalizeJannyToken('not-a-jwt'), null);
        assert.equal(normalizeJannyToken('a.b'), null);
    });

    it('accepts three-segment JWT-shaped strings', () => {
        assert.equal(normalizeJannyToken('aaa.bbb.ccc'), 'aaa.bbb.ccc');
    });
});

describe('buildJannyCookieHeaders', () => {
    it('builds Cookie + Origin + Referer + UA headers', () => {
        const h = buildJannyCookieHeaders('aaa.bbb.ccc');
        assert.equal(h['Cookie'], 'sb-access-token=aaa.bbb.ccc');
        assert.equal(h['Origin'], 'https://jannyai.com');
        assert.equal(h['Referer'], 'https://jannyai.com/');
        assert.ok(h['User-Agent']);
    });

    it('adds Content-Type when json:true', () => {
        const h = buildJannyCookieHeaders('aaa.bbb.ccc', { json: true });
        assert.equal(h['Content-Type'], 'application/json');
    });
});

describe('parseJannyBookmarksResponse', () => {
    it('extracts characterIds from the {bookmarks:[…]} shape', () => {
        const ids = parseJannyBookmarksResponse({
            bookmarks: [
                { characterId: 'aaaa', createdAt: '2026-06-22' },
                { characterId: 'bbbb', createdAt: '2026-06-21' },
            ],
        });
        assert.deepEqual(ids, ['aaaa', 'bbbb']);
    });

    it('returns [] for missing/malformed payloads', () => {
        assert.deepEqual(parseJannyBookmarksResponse(null), []);
        assert.deepEqual(parseJannyBookmarksResponse({}), []);
        assert.deepEqual(parseJannyBookmarksResponse({ bookmarks: 'nope' }), []);
    });
});

describe('isJannyCharacterId', () => {
    it('accepts UUID-shaped strings', () => {
        assert.equal(isJannyCharacterId('52fc1238-698e-45ee-b114-8280cd08501a'), true);
    });
    it('rejects garbage', () => {
        assert.equal(isJannyCharacterId('not-a-uuid'), false);
        assert.equal(isJannyCharacterId(''), false);
        assert.equal(isJannyCharacterId(null), false);
    });
});
```

- [ ] **Step 2: Run the tests; confirm they fail**

```
node --test --import=./tests/setup-browser-globals.mjs tests/janny-account.test.mjs
```

Expected: failure with `Cannot find module '../extras/cl-helper/janny-utils.js'`.

- [ ] **Step 3: Implement `janny-utils.js`**

Create `extras/cl-helper/janny-utils.js`:

```js
// JannyAI server-side helpers (cl-helper plugin).
// Pure functions only — no network, no Express deps. Network calls live in index.js.

export const JANNY_SITE_BASE = 'https://jannyai.com';

// Pretend to be a normal browser; jannyai.com sits behind Cloudflare.
export const JANNY_BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isJannyCharacterId(value) {
    return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Trim, ensure non-empty, and require a three-segment dotted shape (JWT-like).
 * No signature verification — just enough to reject obvious garbage before
 * sending upstream.
 */
export function normalizeJannyToken(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parts = trimmed.split('.');
    if (parts.length !== 3 || parts.some(p => p.length === 0)) return null;
    return trimmed;
}

/**
 * Build the headers needed to make the JannyAI API treat us like the site itself.
 * The browser refuses to set Cookie from fetch(), so this only runs server-side.
 */
export function buildJannyCookieHeaders(token, { json = false } = {}) {
    const headers = {
        'Cookie': `sb-access-token=${token}`,
        'Origin': JANNY_SITE_BASE,
        'Referer': `${JANNY_SITE_BASE}/`,
        'User-Agent': JANNY_BROWSER_UA,
        'Accept': 'application/json,text/plain,*/*',
    };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
}

/**
 * The /api/bookmark endpoint returns {bookmarks:[{characterId, createdAt}]}.
 * Return just the IDs in order; empty array for any malformed payload.
 */
export function parseJannyBookmarksResponse(payload) {
    if (!payload || !Array.isArray(payload.bookmarks)) return [];
    return payload.bookmarks
        .map(b => (b && typeof b.characterId === 'string') ? b.characterId : null)
        .filter(Boolean);
}
```

- [ ] **Step 4: Run tests; confirm they pass**

```
node --test --import=./tests/setup-browser-globals.mjs tests/janny-account.test.mjs
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add extras/cl-helper/janny-utils.js tests/janny-account.test.mjs
git commit -m "feat(janny): janny-utils helpers (token, cookie headers, response parser)"
```

---

## Task 3: cl-helper routes

**Files:**
- Modify: `extras/cl-helper/index.js`

Routes hit `https://jannyai.com/api/bookmark` and `https://jannyai.com/_actions/incrementCount`. Token arrives via `x-janny-token` request header on every call.

- [ ] **Step 1: Import the new helpers**

Edit the existing helper import block at the top of `extras/cl-helper/index.js` to add Janny imports just after the existing `datacat-utils.js` import:

```js
import {
    JANNY_SITE_BASE,
    buildJannyCookieHeaders,
    isJannyCharacterId,
    normalizeJannyToken,
    parseJannyBookmarksResponse,
} from './janny-utils.js';
```

- [ ] **Step 2: Add a request-level token guard**

Add this helper function near `requireDcAccount` (around line 863):

```js
function requireJannyToken(req, res) {
    const raw = req.headers['x-janny-token'];
    const token = normalizeJannyToken(typeof raw === 'string' ? raw : null);
    if (!token) {
        res.status(401).json({ error: 'Missing or malformed JannyAI session token' });
        return null;
    }
    return token;
}
```

- [ ] **Step 3: Add the four routes**

Find the existing `router.delete('/dc-yours/:characterId', ...)` line. Immediately after the next block ends, add the Janny routes. Use the same `router` reference these blocks share:

```js
// ── JannyAI account-backed bookmarks ────────────────────────────────
// Token comes per-request via x-janny-token; we forward it as the
// sb-access-token cookie because browser fetch() can't set Cookie itself.

router.get('/janny-bookmarks', async (req, res) => {
    const token = requireJannyToken(req, res);
    if (!token) return;
    try {
        const response = await fetch(`${JANNY_SITE_BASE}/api/bookmark`, {
            method: 'GET',
            headers: buildJannyCookieHeaders(token),
        });
        if (response.status === 401 || response.status === 403) {
            return res.status(401).json({ error: 'JannyAI session expired' });
        }
        if (!response.ok) {
            return res.status(502).json({ error: `JannyAI bookmark list failed: HTTP ${response.status}` });
        }
        const payload = await response.json().catch(() => null);
        return res.json({ ok: true, characterIds: parseJannyBookmarksResponse(payload) });
    } catch (err) {
        console.error('[cl-helper] Janny bookmark list error:', err.message);
        return res.status(502).json({ error: 'Failed to reach JannyAI' });
    }
});

router.post('/janny-bookmarks', async (req, res) => {
    const token = requireJannyToken(req, res);
    if (!token) return;
    const ids = Array.isArray(req.body?.characterIDs) ? req.body.characterIDs.filter(isJannyCharacterId) : [];
    if (!ids.length) return res.status(400).json({ error: 'characterIDs[] required' });
    try {
        const response = await fetch(`${JANNY_SITE_BASE}/api/bookmark`, {
            method: 'POST',
            headers: buildJannyCookieHeaders(token, { json: true }),
            body: JSON.stringify({ characterIDs: ids }),
        });
        if (response.status === 401 || response.status === 403) {
            return res.status(401).json({ error: 'JannyAI session expired' });
        }
        if (!response.ok) {
            return res.status(502).json({ error: `JannyAI bookmark add failed: HTTP ${response.status}` });
        }
        const payload = await response.json().catch(() => null);
        return res.json({ ok: true, characterIds: parseJannyBookmarksResponse(payload) });
    } catch (err) {
        console.error('[cl-helper] Janny bookmark add error:', err.message);
        return res.status(502).json({ error: 'Failed to reach JannyAI' });
    }
});

router.delete('/janny-bookmarks', async (req, res) => {
    const token = requireJannyToken(req, res);
    if (!token) return;
    const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
    const ids = raw.split(',').map(s => s.trim()).filter(isJannyCharacterId);
    if (!ids.length) return res.status(400).json({ error: 'ids query param required' });
    try {
        const url = `${JANNY_SITE_BASE}/api/bookmark?ids=${ids.map(encodeURIComponent).join(',')}`;
        const response = await fetch(url, {
            method: 'DELETE',
            headers: buildJannyCookieHeaders(token),
        });
        if (response.status === 401 || response.status === 403) {
            return res.status(401).json({ error: 'JannyAI session expired' });
        }
        if (!response.ok) {
            return res.status(502).json({ error: `JannyAI bookmark delete failed: HTTP ${response.status}` });
        }
        return res.json({ ok: true });
    } catch (err) {
        console.error('[cl-helper] Janny bookmark delete error:', err.message);
        return res.status(502).json({ error: 'Failed to reach JannyAI' });
    }
});

router.post('/janny-bookmark-counter', async (req, res) => {
    const token = requireJannyToken(req, res);
    if (!token) return;
    const id = req.body?.characterID;
    if (!isJannyCharacterId(id)) return res.status(400).json({ error: 'characterID required' });
    try {
        // Fire-and-forget on the upstream — counter bumps are cosmetic stats.
        // We still wait for the response so the client gets an honest status.
        const response = await fetch(`${JANNY_SITE_BASE}/_actions/incrementCount`, {
            method: 'POST',
            headers: buildJannyCookieHeaders(token, { json: true }),
            body: JSON.stringify({ characterID: id, count: 'bookmark' }),
        });
        return res.json({ ok: response.ok });
    } catch (err) {
        // Counter failures are silent on the client side; surface a soft signal.
        return res.json({ ok: false });
    }
});
```

- [ ] **Step 4: Bump the helper version**

Edit `extras/cl-helper/package.json` — bump `version` to `1.7.0` so users on older installs see they need to update:

```json
"version": "1.7.0",
```

- [ ] **Step 5: Commit**

```bash
git add extras/cl-helper/index.js extras/cl-helper/package.json
git commit -m "feat(cl-helper): JannyAI bookmark proxy routes"
```

---

## Task 4: Client-side `janny-account.js`

**Files:**
- Create: `modules/providers/janny/janny-account.js`
- Modify: `tests/janny-account.test.mjs` (extend with client-side helper coverage)

- [ ] **Step 1: Extend the test file with client-side helper tests**

Append to `tests/janny-account.test.mjs`:

```js
import {
    parseJannyJwtSub,
    applyBookmarkDiff,
} from '../modules/providers/janny/janny-account.js';

describe('parseJannyJwtSub', () => {
    it('returns the sub claim from a valid JWT', () => {
        // payload = {"sub":"abc-123","iat":1,"exp":2}
        const payload = Buffer.from(JSON.stringify({ sub: 'abc-123', iat: 1, exp: 2 })).toString('base64');
        const jwt = `header.${payload}.signature`;
        assert.equal(parseJannyJwtSub(jwt), 'abc-123');
    });
    it('returns null for malformed tokens', () => {
        assert.equal(parseJannyJwtSub('not.a.jwt'), null);
        assert.equal(parseJannyJwtSub(''), null);
        assert.equal(parseJannyJwtSub(null), null);
    });
});

describe('applyBookmarkDiff', () => {
    it('adds and removes from a Set', () => {
        const set = new Set(['a', 'b', 'c']);
        applyBookmarkDiff(set, { add: ['d'], remove: ['a'] });
        assert.deepEqual([...set].sort(), ['b', 'c', 'd']);
    });
    it('is a no-op when add/remove are empty', () => {
        const set = new Set(['a']);
        applyBookmarkDiff(set, {});
        assert.deepEqual([...set], ['a']);
    });
});
```

- [ ] **Step 2: Run tests; confirm failure**

```
node --test --import=./tests/setup-browser-globals.mjs tests/janny-account.test.mjs
```

Expected: `Cannot find module '../modules/providers/janny/janny-account.js'`.

- [ ] **Step 3: Implement `janny-account.js`**

Create `modules/providers/janny/janny-account.js`:

```js
// Client-side JannyAI account helpers.
// Bookmark state is the user's cloud bookmark set on jannyai.com.
// All network calls go through the cl-helper plugin so the JWT cookie
// can be set server-side (browser fetch() can't set Cookie).

import { CL_HELPER_PLUGIN_BASE } from '../provider-utils.js';

const JANNY_PROXY_BASE = `${CL_HELPER_PLUGIN_BASE}/janny-bookmarks`;
const JANNY_COUNTER_PATH = `${CL_HELPER_PLUGIN_BASE}/janny-bookmark-counter`;

// Module-scoped cache. Re-populated on connect and after each successful mutation.
const _bookmarkSet = new Set();
let _cachePopulated = false;

// -----------------------------------------------------------------------------
// Pure helpers (exported for testing)
// -----------------------------------------------------------------------------

/**
 * Decode the `sub` claim from a Supabase JWT without verifying the signature.
 * Used only to remember which account the cached bookmark set belongs to so
 * we don't surface stale data after a token swap.
 */
export function parseJannyJwtSub(jwt) {
    if (typeof jwt !== 'string') return null;
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    try {
        const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const pad = payload.length % 4 ? '='.repeat(4 - (payload.length % 4)) : '';
        const json = typeof atob === 'function'
            ? atob(payload + pad)
            : Buffer.from(payload + pad, 'base64').toString('utf8');
        const data = JSON.parse(json);
        return typeof data.sub === 'string' ? data.sub : null;
    } catch {
        return null;
    }
}

export function applyBookmarkDiff(set, { add = [], remove = [] } = {}) {
    for (const id of add) set.add(id);
    for (const id of remove) set.delete(id);
}

// -----------------------------------------------------------------------------
// Settings access — looked up dynamically so callers in browse/provider stay
// decoupled from app/library.js's getSetting wiring.
// -----------------------------------------------------------------------------

function jannyToken() {
    try {
        return window.CharacterLibrary?.getSetting?.('jannyAccountToken') || null;
    } catch {
        return null;
    }
}

export function isJannyAccountEnabled() {
    return Boolean(jannyToken());
}

export function getJannyBookmarkSet() {
    return _bookmarkSet;
}

export function isJannyBookmarkCachePopulated() {
    return _cachePopulated;
}

export function getJannyCurrentUserId() {
    return parseJannyJwtSub(jannyToken());
}

// -----------------------------------------------------------------------------
// Network
// -----------------------------------------------------------------------------

async function jannyFetch(path, opts = {}) {
    const token = jannyToken();
    if (!token) throw new Error('Not signed in to JannyAI');
    const headers = { ...(opts.headers || {}), 'x-janny-token': token };
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { ...opts, headers });
    return response;
}

export async function fetchJannyBookmarks() {
    const response = await jannyFetch(JANNY_PROXY_BASE);
    if (!response.ok) throw new Error(`fetchJannyBookmarks HTTP ${response.status}`);
    const data = await response.json();
    return Array.isArray(data.characterIds) ? data.characterIds : [];
}

export async function refreshJannyBookmarkCache() {
    if (!isJannyAccountEnabled()) {
        _bookmarkSet.clear();
        _cachePopulated = false;
        return;
    }
    try {
        const ids = await fetchJannyBookmarks();
        _bookmarkSet.clear();
        for (const id of ids) _bookmarkSet.add(id);
        _cachePopulated = true;
    } catch (err) {
        console.warn('[JannyAccount] cache refresh failed:', err.message);
        _cachePopulated = false;
    }
}

export async function addJannyBookmark(characterId) {
    const response = await jannyFetch(JANNY_PROXY_BASE, {
        method: 'POST',
        body: JSON.stringify({ characterIDs: [characterId] }),
    });
    if (!response.ok) throw new Error(`addJannyBookmark HTTP ${response.status}`);
    _bookmarkSet.add(characterId);
    bumpJannyBookmarkCounter(characterId).catch(() => {}); // fire-and-forget
}

export async function removeJannyBookmark(characterId) {
    const response = await jannyFetch(`${JANNY_PROXY_BASE}?ids=${encodeURIComponent(characterId)}`, {
        method: 'DELETE',
    });
    if (!response.ok) throw new Error(`removeJannyBookmark HTTP ${response.status}`);
    _bookmarkSet.delete(characterId);
}

export async function bumpJannyBookmarkCounter(characterId) {
    await jannyFetch(JANNY_COUNTER_PATH, {
        method: 'POST',
        body: JSON.stringify({ characterID: characterId, count: 'bookmark' }),
    });
}

export function clearJannyBookmarkCache() {
    _bookmarkSet.clear();
    _cachePopulated = false;
}
```

- [ ] **Step 4: Run tests; confirm pass**

```
node --test --import=./tests/setup-browser-globals.mjs tests/janny-account.test.mjs
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add modules/providers/janny/janny-account.js tests/janny-account.test.mjs
git commit -m "feat(janny): client-side janny-account module with bookmark cache"
```

---

## Task 5: Provider auth flip

**Files:**
- Modify: `modules/providers/janny/janny-provider.js:706-711`

- [ ] **Step 1: Update the imports**

Find the existing imports at the top of `janny-provider.js`. Add:

```js
import { isJannyAccountEnabled, getJannyCurrentUserId } from './janny-account.js';
```

- [ ] **Step 2: Replace the auth block**

Find lines 706-711:

```js
    // ── Authentication ──────────────────────────────────────

    // JannyAI MeiliSearch uses a public key, no user auth needed
    get hasAuth() { return false; }

    getAuthHeaders() { return {}; }
```

Replace with:

```js
    // ── Authentication ──────────────────────────────────────

    // Search still uses a public MeiliSearch key; account features
    // (bookmark sync) gate on a Supabase JWT pasted in Settings.
    get hasAuth() { return isJannyAccountEnabled(); }

    // Auth lives in the cl-helper plugin proxy, not in client headers,
    // so client-side calls don't need extra headers — this returns {} to
    // satisfy callers that still ask.
    getAuthHeaders() { return {}; }

    getCurrentUserId() { return getJannyCurrentUserId(); }
```

- [ ] **Step 3: Commit**

```bash
git add modules/providers/janny/janny-provider.js
git commit -m "feat(janny): flip hasAuth based on session token presence"
```

---

## Task 6: Settings wiring (Connect / Disconnect / Help)

**Files:**
- Modify: `app/library.js`

- [ ] **Step 1: Add element handles + import the cache refresher**

Near the existing DataCat handle declarations (around line 1594-1598), add:

```js
    const jannyAccountTokenInput = document.getElementById('settingsJannyAccountToken');
    const jannyAccountTokenConnectBtn = document.getElementById('jannyAccountTokenConnectBtn');
    const jannyAccountDisconnectBtn = document.getElementById('jannyAccountDisconnectBtn');
    const jannyAccountStatus = document.getElementById('jannyAccountStatus');
    const jannyAccountTokenHelpBtn = document.getElementById('jannyAccountTokenHelpBtn');
    const jannyAccountTokenHelp = document.getElementById('jannyAccountTokenHelp');
```

At the top of `app/library.js`, add an import (place near other module imports):

```js
import { refreshJannyBookmarkCache, clearJannyBookmarkCache, getJannyBookmarkSet } from '../modules/providers/janny/janny-account.js';
```

- [ ] **Step 2: Add the connect handler**

Below the existing `datacatAccountTokenConnectBtn` handler (around line 3843), add:

```js
    if (jannyAccountTokenConnectBtn) {
        jannyAccountTokenConnectBtn.onclick = async () => {
            const token = (jannyAccountTokenInput?.value || '').trim();
            if (!token) {
                if (jannyAccountStatus) jannyAccountStatus.textContent = 'Paste your sb-access-token first.';
                return;
            }
            jannyAccountTokenConnectBtn.disabled = true;
            jannyAccountTokenConnectBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Connecting...';
            try {
                setSetting('jannyAccountToken', token);
                await refreshJannyBookmarkCache();
                const count = getJannyBookmarkSet().size;
                if (jannyAccountStatus) jannyAccountStatus.textContent = `Signed in (${count} bookmarks)`;
                if (jannyAccountTokenInput) jannyAccountTokenInput.value = '';
                jannyAccountTokenConnectBtn.style.display = 'none';
                if (jannyAccountDisconnectBtn) jannyAccountDisconnectBtn.style.display = '';
            } catch (e) {
                setSetting('jannyAccountToken', null);
                if (jannyAccountStatus) jannyAccountStatus.textContent = `Failed: ${e.message}`;
            } finally {
                jannyAccountTokenConnectBtn.disabled = false;
                jannyAccountTokenConnectBtn.innerHTML = '<i class="fa-solid fa-link"></i> Connect Token';
            }
        };
    }
```

- [ ] **Step 3: Add the disconnect handler**

```js
    if (jannyAccountDisconnectBtn) {
        jannyAccountDisconnectBtn.onclick = () => {
            setSetting('jannyAccountToken', null);
            clearJannyBookmarkCache();
            if (jannyAccountStatus) jannyAccountStatus.textContent = 'Disconnected.';
            jannyAccountDisconnectBtn.style.display = 'none';
            if (jannyAccountTokenConnectBtn) jannyAccountTokenConnectBtn.style.display = '';
        };
    }
```

- [ ] **Step 4: Wire the help toggle**

```js
    if (jannyAccountTokenHelpBtn) {
        jannyAccountTokenHelpBtn.onclick = (e) => {
            e.preventDefault();
            if (!jannyAccountTokenHelp) return;
            jannyAccountTokenHelp.style.display =
                jannyAccountTokenHelp.style.display === 'none' ? '' : 'none';
        };
    }
```

- [ ] **Step 5: Restore connected state on settings open**

In the function that reflects current settings into the UI (search for `datacatAccountTokenConnectBtn.style.display` to find the right spot), add a sibling restore block:

```js
        if (getSetting('jannyAccountToken')) {
            if (jannyAccountTokenConnectBtn) jannyAccountTokenConnectBtn.style.display = 'none';
            if (jannyAccountDisconnectBtn) jannyAccountDisconnectBtn.style.display = '';
            if (jannyAccountStatus) jannyAccountStatus.textContent = 'Signed in.';
        } else {
            if (jannyAccountTokenConnectBtn) jannyAccountTokenConnectBtn.style.display = '';
            if (jannyAccountDisconnectBtn) jannyAccountDisconnectBtn.style.display = 'none';
        }
```

- [ ] **Step 6: Trigger bookmark cache refresh on app startup**

Find the existing post-init block where DataCat session restoration runs (search for `datacatAccountToken` in app/library.js, around line 3700-3725). Add adjacent:

```js
        if (getSetting('jannyAccountToken')) {
            refreshJannyBookmarkCache().catch(err => {
                console.warn('[CL] JannyAI bookmark cache initial refresh failed:', err.message);
            });
        }
```

- [ ] **Step 7: Commit**

```bash
git add app/library.js
git commit -m "feat(janny): wire Settings connect/disconnect and startup cache refresh"
```

---

## Task 7: Bookmark badge + click handler in browse view

**Files:**
- Modify: `modules/providers/janny/janny-browse.js`

- [ ] **Step 1: Add the imports**

At the top of `janny-browse.js`, add:

```js
import {
    isJannyAccountEnabled,
    getJannyBookmarkSet,
    addJannyBookmark,
    removeJannyBookmark,
} from './janny-account.js';
```

- [ ] **Step 2: Add bookmark icon to `createJannyCard`**

Find `createJannyCard` (line 230). In the badges-building section (around line 242), append after the existing `if (inLibrary) … else if (possibleMatch) …` block:

```js
    if (isJannyAccountEnabled()) {
        const isBookmarked = getJannyBookmarkSet().has(String(charId));
        const icon = isBookmarked ? 'fa-solid' : 'fa-regular';
        const title = isBookmarked ? 'Bookmarked on JannyAI' : 'Bookmark on JannyAI';
        badges.push(`<button class="browse-feature-badge janny-bookmark-badge${isBookmarked ? ' active' : ''}" title="${title}" data-action="janny-bookmark"><i class="${icon} fa-bookmark"></i></button>`);
    }
```

- [ ] **Step 3: Add the click handler**

Find where other card click handlers attach (search for `data-janny-id` or grep for an existing delegate listener on `jannyGrid`). Add a click handler that intercepts the bookmark-badge button before the card-open handler fires:

```js
function bindJannyBookmarkToggles() {
    const grid = document.getElementById('jannyGrid');
    if (!grid || grid.dataset.bookmarkBound === '1') return;
    grid.dataset.bookmarkBound = '1';
    grid.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action="janny-bookmark"]');
        if (!btn) return;
        e.stopPropagation();
        e.preventDefault();

        const card = btn.closest('[data-janny-id]');
        const id = card?.dataset.jannyId;
        if (!id) return;

        const wasActive = btn.classList.contains('active');
        // Optimistic flip
        btn.classList.toggle('active');
        const icon = btn.querySelector('i');
        if (icon) icon.classList.toggle('fa-solid'), icon.classList.toggle('fa-regular');

        try {
            if (wasActive) await removeJannyBookmark(id);
            else await addJannyBookmark(id);
        } catch (err) {
            // Revert on failure
            btn.classList.toggle('active');
            if (icon) icon.classList.toggle('fa-solid'), icon.classList.toggle('fa-regular');
            console.warn('[Janny] bookmark toggle failed:', err.message);
            if (typeof window.toastr?.error === 'function') {
                window.toastr.error('Could not update JannyAI bookmark');
            }
        }
    });
}
```

- [ ] **Step 4: Call `bindJannyBookmarkToggles()` once on grid creation**

Find `renderGrid` (line 290). Right after the `grid.insertAdjacentHTML(...)` line (around line 301), call:

```js
    bindJannyBookmarkToggles();
```

(It's idempotent — the `dataset.bookmarkBound` guard prevents double-binding.)

- [ ] **Step 5: Minimal styling so the badge looks like a clickable affordance**

Append to `modules/providers/janny/janny-browse.css` (or the equivalent CSS file the existing janny browse styles live in — confirm by inspecting the directory):

```css
.janny-bookmark-badge {
    cursor: pointer;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    border: 0;
    padding: 4px 6px;
}
.janny-bookmark-badge.active {
    color: #ffd84a;
}
.janny-bookmark-badge:hover {
    background: rgba(0, 0, 0, 0.75);
}
```

(If the file doesn't exist, skip the CSS step — the existing `.browse-feature-badge` styles handle 80% of it and a stylistic pass can follow.)

- [ ] **Step 6: Commit**

```bash
git add modules/providers/janny/janny-browse.js modules/providers/janny/janny-browse.css 2>/dev/null
git commit -m "feat(janny): bookmark badge with optimistic toggle on browse cards"
```

---

## Task 8: "Show only my bookmarks" filter

**Files:**
- Modify: `modules/providers/janny/janny-browse.js`

- [ ] **Step 1: Add filter state**

Find the filter state block (around line 62-70). After `let jannyAuthorFilter = null;` add:

```js
let jannyFilterOnlyBookmarked = false;
```

- [ ] **Step 2: Integrate into the MeiliSearch filter array**

In `searchJanny` (line 78), inside the `filters` array construction (just after `if (jannyIncludeTags.size > 0) { … }` around line 90), append:

```js
    if (jannyFilterOnlyBookmarked && isJannyAccountEnabled()) {
        const ids = [...getJannyBookmarkSet()];
        if (ids.length === 0) {
            // Force empty result rather than returning unfiltered hits
            filters.push('id = "__none__"');
        } else {
            const quoted = ids.map(id => `"${id}"`).join(',');
            filters.push(`id IN [${quoted}]`);
        }
    }
```

- [ ] **Step 3: Add the UI toggle**

Find the existing filter UI region (search for `jannyShowLowQuality` to find where filters are rendered). Add a new toggle button next to the existing ones:

```html
<label class="janny-filter-toggle" id="jannyOnlyBookmarkedToggleWrap" style="display:none;">
    <input type="checkbox" id="jannyOnlyBookmarkedToggle">
    <i class="fa-solid fa-bookmark"></i> Only my bookmarks
</label>
```

In the wiring code that binds the other filter toggles (search for `jannyShowLowQuality` again to find the JS wiring), add:

```js
    const onlyBookmarked = document.getElementById('jannyOnlyBookmarkedToggle');
    const onlyBookmarkedWrap = document.getElementById('jannyOnlyBookmarkedToggleWrap');
    if (onlyBookmarked && onlyBookmarkedWrap) {
        // Show the toggle only when signed in
        onlyBookmarkedWrap.style.display = isJannyAccountEnabled() ? '' : 'none';
        onlyBookmarked.checked = jannyFilterOnlyBookmarked;
        onlyBookmarked.onchange = () => {
            jannyFilterOnlyBookmarked = onlyBookmarked.checked;
            // Re-run search; match whatever function the other filter toggles
            // call to kick a fresh load (search the file for `jannyShowLowQuality`
            // to find the analogous call site).
            loadJanny();
        };
    }
```

(If the wiring spot uses `loadJanny()` or similar instead of `doJannySearch()`, substitute the correct function name — match what the existing toggles call.)

- [ ] **Step 4: Reveal/hide the toggle when the cache becomes ready**

In `app/library.js` Task 6 Step 6, after `refreshJannyBookmarkCache().catch(...)`, append a tick that re-evaluates the toggle visibility once the cache settles. Inside the `.then(...)` clause:

```js
        if (getSetting('jannyAccountToken')) {
            refreshJannyBookmarkCache()
                .then(() => {
                    const wrap = document.getElementById('jannyOnlyBookmarkedToggleWrap');
                    if (wrap) wrap.style.display = '';
                })
                .catch(err => console.warn('[CL] JannyAI bookmark cache initial refresh failed:', err.message));
        }
```

- [ ] **Step 5: Commit**

```bash
git add modules/providers/janny/janny-browse.js app/library.js app/library.html
git commit -m "feat(janny): Show only my bookmarks filter for browse view"
```

---

## Task 9: Manual smoke test + push

This task has no automated tests because it exercises browser + JannyAI cookies. Use a real session token.

- [ ] **Step 1: Restart ST so the cl-helper plugin picks up the new routes**

In the running SillyTavern terminal, Ctrl+C and `npm start` again. Confirm `[cl-helper]` initialization line still appears in the log.

- [ ] **Step 2: Connect**

1. In CL Settings, paste your `sb-access-token` from jannyai.com → click Connect Token.
2. Expected: button hides, status shows `Signed in (N bookmarks)`, Disconnect button appears.

- [ ] **Step 3: Verify badge mirrors server state**

1. Open JannyAI browse.
2. Pick a card you know is bookmarked on jannyai.com — badge should render filled (`fa-solid fa-bookmark`, gold).
3. Pick one that isn't — badge renders outline (`fa-regular fa-bookmark`).

- [ ] **Step 4: Toggle**

1. Click an outline badge — it should fill immediately (optimistic), and on jannyai.com refreshing the same character should show it now bookmarked.
2. Click a filled badge — it goes outline, the site agrees.
3. (Optional) check that the public bookmark count incremented after add (the `incrementCount` call).

- [ ] **Step 5: Filter**

1. Toggle "Only my bookmarks" — grid should narrow to the exact set you have bookmarked.
2. Toggle off — full grid returns.

- [ ] **Step 6: Disconnect**

1. Click Disconnect.
2. Bookmark badges should disappear (provider reports `hasAuth=false`); filter toggle hides.

- [ ] **Step 7: Mobile smoke**

Per project memory, the user primarily uses ST on mobile. Repeat steps 3-5 on the mobile layout — confirm the badge is tappable, the filter toggle is visible/usable, and the toggle's state survives the card-viewer drawer open/close cycle.

- [ ] **Step 8: Push**

```bash
git push -u origin codex/janny-account-sync
```

Per project memory: always push immediately so the user can test from GitHub.

---

## Self-Review Notes

- **Spec coverage:** Each spec section maps to at least one task. (1) Login model → Task 1+6; (2) cloud bookmark sync per-action → Task 3+4+7; (3) bookmark badge → Task 7; (4) "Show only my bookmarks" → Task 8; (5) deferred refresh-token and Yours star → explicitly out of scope, not in plan.
- **Type/name consistency:** `addJannyBookmark`/`removeJannyBookmark` are singular (one ID at a time on client side; server route accepts an array but client always passes 1). `getJannyBookmarkSet()` returns the live `Set` (callers don't copy — they read).
- **Risk: cache staleness across sessions.** If the user bookmarks a card *on jannyai.com* directly, the badge stays outline until the page reloads and the cache refreshes. Acceptable for v1 — spec calls out per-action, not eventual-consistency.
- **No automated browser tests** — only the pure JS helpers are unit-tested. Browse rendering is verified manually in Task 9.
