# JannyAI Account Sync (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in JannyAI user save/unsave characters to their online JannyAI bookmarks from Character Library, browse their bookmarked set, and filter browse to "My Bookmarks" — on desktop and mobile.

**Architecture:** JannyAI auth is a browser session cookie + Cloudflare `cf_clearance` (no token). The `cl-helper` SillyTavern server plugin stores the handed-off cookie + browser User-Agent and replays them server-side against `jannyai.com/api/*` (bypassing browser CORS and Cloudflare, since cl-helper shares the browser's egress IP). This mirrors the existing CharacterTavern (`ct-*`) cookie-proxy provider and Botbooru's multi-method proxy handler. The frontend `janny-api.js` gains account helpers that call cl-helper; `janny-browse.js` gains a Connect UI, a bookmark toggle button (reusing the `.browse-fav-toggle` mobile-pickup convention), a cap guard, and a "My Bookmarks" data-source view.

**Tech Stack:** Node/Express (cl-helper, ESM), vanilla JS ES modules (provider frontend), Node built-in `node --test` for pure-logic unit tests (no test framework exists on `main`).

## Global Constraints

- Anonymous JannyAI browsing/extraction must keep working unchanged (MeiliSearch search + corsproxy HTML scraping). Account features are strictly additive.
- Never store the JannyAI cookie in CL settings or localStorage — it lives only in cl-helper memory (matches CharacterTavern).
- **Bookmark cap = 220** (default, configurable via `jannyBookmarkCap`): past this the JannyAI bookmark page renders invisible. Never issue a save that would make `count + additions > cap`.
- JannyAI API base: `https://jannyai.com`. Endpoints: `GET /api/bookmark` (saved IDs), `GET /api/get-characters?ids=<csv>` (batch details), `POST /api/bookmark` body `{"characterIds":["<uuid>"]}` content-type `text/plain;charset=UTF-8` (save), `DELETE /api/bookmark?ids=<csv>` (remove).
- Bookmark toggle glyph = bookmark icon (`fa-bookmark` / 🔖), NOT the heart used by Chub/Botbooru favorites. Button MUST carry class `browse-fav-toggle` (mobile derivation hook) and toggle `.favorited` for saved state.
- cl-helper frontend calls go through `CL_HELPER_PLUGIN_BASE` + `CoreAPI.apiRequest` (basic-auth reroute), exactly like `botbooru-api.js`.
- User-Agent sent to cl-helper on connect = the browser's `navigator.userAgent` (Cloudflare `cf_clearance` is UA-bound; the replay must use the same UA).

---

### Task 1: cl-helper JannyAI cookie routes + proxy

**Files:**
- Modify: `extras/cl-helper/index.js` (add a `registerJannyRoutes` function near the CharacterTavern block ~line 886; call it inside `init()` ~line 1957)

**Interfaces:**
- Produces (HTTP routes under the cl-helper plugin base):
  - `POST /jy-set-cookie` body `{ cookie: string, userAgent?: string }` → `{ ok: true }` | 400
  - `GET  /jy-validate` → `{ valid: boolean, bookmarkCount?: number, reason?: string }`
  - `POST /jy-logout` → `{ ok: true }`
  - `GET  /jy-session` → `{ active: boolean }`
  - `GET|POST|DELETE /jy-proxy/*` → forwards to `https://jannyai.com<path>` with stored cookie + UA; allowlisted to `/api/bookmark` and `/api/get-characters`

- [ ] **Step 1: Add module state + allowlist**

Insert after the CharacterTavern block (after line 886, before the DataCat section at line 888):

```javascript
// =============================================================================
// JannyAI: cookie session + bookmark API proxy (account sync Phase A)
// =============================================================================

const JANNY_BASE = 'https://jannyai.com';

// In-memory session store (persists until logout or server restart).
let jyCookie = null;     // raw Cookie header value handed off from the browser
let jyUserAgent = null;  // the browser UA that cf_clearance was issued for

// JannyAI API paths the proxy is allowed to forward.
const JANNY_ALLOWED_PATHS = [
    /^\/api\/bookmark$/,
    /^\/api\/get-characters$/,
];

function jyHeaders(extra = {}) {
    const headers = {
        'User-Agent': jyUserAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/152.0',
        'Accept': 'application/json',
        ...extra,
    };
    if (jyCookie) headers['Cookie'] = jyCookie;
    return headers;
}
```

- [ ] **Step 2: Add `registerJannyRoutes` with set-cookie / validate / logout / session**

Append this function immediately after the state block from Step 1:

```javascript
function registerJannyRoutes(router) {
    /**
     * POST /jy-set-cookie
     * Body: { cookie: "<full cookie header>", userAgent?: "<navigator.userAgent>" }
     * Stores the browser session cookie(s) (session + cf_clearance) and UA for
     * server-side replay. Rejects newline/oversized input.
     */
    router.post('/jy-set-cookie', (req, res) => {
        const { cookie, userAgent } = req.body ?? {};
        if (!cookie || typeof cookie !== 'string' || !cookie.trim()) {
            return res.status(400).json({ error: 'cookie string is required' });
        }
        const value = cookie.trim();
        if (/[\r\n]/.test(value) || value.length > 8192) {
            return res.status(400).json({ error: 'Invalid cookie value' });
        }
        jyCookie = value;
        jyUserAgent = (typeof userAgent === 'string' && userAgent.length <= 512) ? userAgent : null;
        console.log('[cl-helper] JannyAI session cookie stored');
        res.json({ ok: true });
    });

    /**
     * GET /jy-validate
     * Test request to /api/bookmark with stored cookie. Returns saved count.
     */
    router.get('/jy-validate', async (_req, res) => {
        if (!jyCookie) return res.json({ valid: false, reason: 'no cookie stored' });
        try {
            const response = await fetch(`${JANNY_BASE}/api/bookmark`, { headers: jyHeaders() });
            const ct = response.headers.get('content-type') || '';
            if (response.ok && ct.includes('application/json')) {
                const data = await response.json();
                const ids = Array.isArray(data) ? data : (data?.characterIds || data?.ids || []);
                return res.json({ valid: true, bookmarkCount: Array.isArray(ids) ? ids.length : 0 });
            }
            if (response.status === 401 || response.status === 403) {
                jyCookie = null; jyUserAgent = null;
                return res.json({ valid: false, reason: 'session expired or rejected' });
            }
            return res.json({ valid: false, reason: `HTTP ${response.status}` });
        } catch (err) {
            console.error('[cl-helper] JannyAI validate error:', err.message);
            res.json({ valid: false, reason: err.message });
        }
    });

    router.post('/jy-logout', (_req, res) => {
        jyCookie = null; jyUserAgent = null;
        console.log('[cl-helper] JannyAI session cleared');
        res.json({ ok: true });
    });

    router.get('/jy-session', (_req, res) => {
        res.json({ active: !!jyCookie });
    });

    router.get('/jy-proxy/*', handleJannyProxy);
    router.post('/jy-proxy/*', handleJannyProxy);
    router.delete('/jy-proxy/*', handleJannyProxy);
}
```

- [ ] **Step 3: Add the multi-method proxy handler**

Add `handleJannyProxy` above `registerJannyRoutes` (adapted from `handleBotbooruProxy`, but injecting the cookie and preserving JannyAI's `text/plain` save body):

```javascript
async function handleJannyProxy(req, res) {
    const targetPath = '/' + (req.params[0] || '');
    const normalizedPath = new URL(targetPath, JANNY_BASE).pathname;
    if (!JANNY_ALLOWED_PATHS.some(re => re.test(normalizedPath))) {
        console.warn(`[cl-helper] JannyAI proxy blocked: ${normalizedPath}`);
        return res.status(403).json({ error: 'Proxy path not allowed' });
    }
    const targetUrl = new URL(targetPath, JANNY_BASE);
    targetUrl.search = new URL(req.url, 'http://localhost').search;
    if (targetUrl.hostname !== 'jannyai.com') {
        return res.status(403).json({ error: 'Proxy target must be jannyai.com' });
    }
    if (!jyCookie) return res.status(401).json({ error: 'Not connected to JannyAI' });

    // JannyAI's save endpoint expects the JSON body as text/plain (it dodges
    // CORS preflight that way); replay it identically.
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method)
        && req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0;
    const headers = jyHeaders(hasBody ? { 'Content-Type': 'text/plain;charset=UTF-8' } : {});

    try {
        const response = await fetch(targetUrl.toString(), {
            method: req.method,
            headers,
            body: hasBody ? JSON.stringify(req.body) : undefined,
            redirect: 'follow',
        });
        res.status(response.status);
        const contentType = response.headers.get('content-type') || '';
        if (contentType) res.set('Content-Type', contentType);
        if (response.status === 204) return res.end();
        if (contentType.includes('application/json') || contentType.startsWith('text/')) {
            res.send(await response.text());
        } else {
            res.send(Buffer.from(await response.arrayBuffer()));
        }
    } catch (err) {
        console.error('[cl-helper] JannyAI proxy error:', err.message);
        res.status(502).json({ error: 'Failed to reach JannyAI' });
    }
}
```

- [ ] **Step 4: Register the routes in `init()`**

In `export async function init(router)`, add after `registerCharacterTavernRoutes(router);` (line 1951):

```javascript
    registerJannyRoutes(router);
```

- [ ] **Step 5: Syntax-check the plugin**

Run: `node --check extras/cl-helper/index.js`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add extras/cl-helper/index.js
git commit -m "feat(cl-helper): add JannyAI cookie session + bookmark API proxy"
```

---

### Task 2: Bookmark cap pure-logic module + unit tests

**Files:**
- Create: `modules/providers/janny/janny-bookmark-logic.js`
- Create: `tests/janny-bookmark-logic.test.mjs`

**Interfaces:**
- Produces:
  - `JANNY_BOOKMARK_CAP_DEFAULT = 220`
  - `capForSettings(getSetting) -> number` — reads `jannyBookmarkCap` setting, falls back to default, clamps to >= 1.
  - `canAddBookmarks(currentCount, addCount, cap) -> { ok: boolean, allowed: number, reason?: string }` — pure guard.
  - `reconcileBookmarkSet(set, ids, added) -> void` — add/remove ids from a Set (added=true→add, false→delete).

- [ ] **Step 1: Write the failing test**

Create `tests/janny-bookmark-logic.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    JANNY_BOOKMARK_CAP_DEFAULT,
    capForSettings,
    canAddBookmarks,
    reconcileBookmarkSet,
} from '../modules/providers/janny/janny-bookmark-logic.js';

test('default cap is 220', () => {
    assert.equal(JANNY_BOOKMARK_CAP_DEFAULT, 220);
});

test('capForSettings falls back to default and clamps', () => {
    assert.equal(capForSettings(() => undefined), 220);
    assert.equal(capForSettings(() => 300), 300);
    assert.equal(capForSettings(() => 0), 1);
});

test('canAddBookmarks blocks at/over cap', () => {
    assert.deepEqual(canAddBookmarks(219, 1, 220), { ok: true, allowed: 1 });
    const blocked = canAddBookmarks(220, 1, 220);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.allowed, 0);
    assert.match(blocked.reason, /cap/i);
});

test('canAddBookmarks partial batch is not ok but reports headroom', () => {
    const r = canAddBookmarks(218, 5, 220);
    assert.equal(r.ok, false);
    assert.equal(r.allowed, 2);
});

test('reconcileBookmarkSet adds and removes', () => {
    const s = new Set(['a']);
    reconcileBookmarkSet(s, ['b', 'c'], true);
    assert.deepEqual([...s].sort(), ['a', 'b', 'c']);
    reconcileBookmarkSet(s, ['a'], false);
    assert.deepEqual([...s].sort(), ['b', 'c']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/janny-bookmark-logic.test.mjs`
Expected: FAIL — cannot find module `janny-bookmark-logic.js`.

- [ ] **Step 3: Write minimal implementation**

Create `modules/providers/janny/janny-bookmark-logic.js`:

```javascript
// Pure, dependency-free bookmark cap + set logic for JannyAI account sync.
// Kept separate so it is unit-testable under `node --test` without a DOM.

export const JANNY_BOOKMARK_CAP_DEFAULT = 220;

/** Resolve the effective cap from CL settings, clamped to >= 1. */
export function capForSettings(getSetting) {
    const raw = Number(getSetting?.('jannyBookmarkCap'));
    const cap = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : JANNY_BOOKMARK_CAP_DEFAULT;
    return Math.max(1, cap);
}

/** Can we add `addCount` bookmarks without exceeding `cap`? */
export function canAddBookmarks(currentCount, addCount, cap) {
    const headroom = Math.max(0, cap - currentCount);
    if (addCount <= headroom) return { ok: true, allowed: addCount };
    return {
        ok: false,
        allowed: headroom,
        reason: `JannyAI bookmark cap (${cap}) reached; its bookmark page breaks past this. Remove some first.`,
    };
}

/** Mutate `set`: add ids when added=true, delete when added=false. */
export function reconcileBookmarkSet(set, ids, added) {
    for (const id of ids) {
        if (added) set.add(id);
        else set.delete(id);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/janny-bookmark-logic.test.mjs`
Expected: PASS — 5 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add modules/providers/janny/janny-bookmark-logic.js tests/janny-bookmark-logic.test.mjs
git commit -m "feat(janny): add bookmark cap pure-logic module with tests"
```

---

### Task 3: janny-api.js account + bookmark helpers

**Files:**
- Modify: `modules/providers/janny/janny-api.js`

**Interfaces:**
- Consumes: `CL_HELPER_PLUGIN_BASE` from `../provider-utils.js`; `canAddBookmarks`, `reconcileBookmarkSet`, `capForSettings` from `./janny-bookmark-logic.js`.
- Produces (exports):
  - `configureJannyAccount({ apiRequest, getSetting })` — binds `CoreAPI.apiRequest` + settings.
  - `jannyHelperAvailable() -> Promise<boolean>`
  - `connectJanny(cookie: string) -> Promise<{ ok: boolean, bookmarkCount?: number, error?: string }>`
  - `jannyAuthStatus() -> Promise<{ connected: boolean, bookmarkCount?: number, reason?: string }>`
  - `disconnectJanny() -> Promise<void>`
  - `jannyBookmarkIds: Set<string>` (exported live binding via getter `getJannyBookmarkIds()`)
  - `refreshJannyBookmarkIds() -> Promise<Set<string>>`
  - `toggleJannyBookmark(id: string, add: boolean) -> Promise<{ ok: boolean, error?: string }>`
  - `fetchJannyBookmarkCharacters(ids: string[]) -> Promise<object[]>`
  - `jannyBookmarkCap() -> number`

- [ ] **Step 1: Add imports + module state**

At the top of `janny-api.js`, after the existing constant exports (after line 13), add:

```javascript
import { CL_HELPER_PLUGIN_BASE } from '../provider-utils.js';
import { canAddBookmarks, reconcileBookmarkSet, capForSettings } from './janny-bookmark-logic.js';

const JANNY_PROXY_BASE = `${CL_HELPER_PLUGIN_BASE}/jy-proxy`;
const GET_CHARACTERS_CHUNK = 100; // ids per get-characters request (URL-length safe)

let _apiRequest = null;
let _getSetting = () => undefined;
const _bookmarkIds = new Set();

export function configureJannyAccount(deps = {}) {
    _apiRequest = deps.apiRequest || null;
    if (typeof deps.getSetting === 'function') _getSetting = deps.getSetting;
}

export function getJannyBookmarkIds() { return _bookmarkIds; }
export function jannyBookmarkCap() { return capForSettings(_getSetting); }
```

- [ ] **Step 2: Add helper availability + auth calls**

Append to `janny-api.js`:

```javascript
export async function jannyHelperAvailable() {
    if (!_apiRequest) return false;
    try {
        const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/health`);
        return !!resp && (resp.ok === true || resp.status === 200 || resp.status === undefined);
    } catch { return false; }
}

export async function connectJanny(cookie) {
    if (!_apiRequest) return { ok: false, error: 'cl-helper plugin not available' };
    try {
        await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/jy-set-cookie`, 'POST', {
            cookie,
            userAgent: (typeof navigator !== 'undefined' ? navigator.userAgent : ''),
        });
        const status = await jannyAuthStatus();
        if (status.connected) {
            await refreshJannyBookmarkIds();
            return { ok: true, bookmarkCount: status.bookmarkCount };
        }
        return { ok: false, error: status.reason || 'Session did not validate' };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export async function jannyAuthStatus() {
    if (!_apiRequest) return { connected: false, reason: 'no cl-helper' };
    try {
        const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/jy-validate`);
        const data = typeof resp?.json === 'function' ? await resp.json() : resp;
        return { connected: !!data?.valid, bookmarkCount: data?.bookmarkCount, reason: data?.reason };
    } catch (e) {
        return { connected: false, reason: e.message };
    }
}

export async function disconnectJanny() {
    _bookmarkIds.clear();
    if (!_apiRequest) return;
    try { await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/jy-logout`, 'POST'); } catch { /* ignore */ }
}
```

> **Note on `_apiRequest` return shape:** `CoreAPI.apiRequest` may resolve to either a parsed object or a `Response`. The `typeof resp?.json === 'function' ? await resp.json() : resp` guard above handles both; reuse it wherever a JSON body is read.

- [ ] **Step 3: Add bookmark fetch/toggle/batch helpers**

Append to `janny-api.js`:

```javascript
export async function refreshJannyBookmarkIds() {
    _bookmarkIds.clear();
    if (!_apiRequest) return _bookmarkIds;
    try {
        const resp = await _apiRequest(`${JANNY_PROXY_BASE}/api/bookmark`);
        const data = typeof resp?.json === 'function' ? await resp.json() : resp;
        const ids = Array.isArray(data) ? data : (data?.characterIds || data?.ids || []);
        for (const id of ids) _bookmarkIds.add(typeof id === 'string' ? id : id?.id);
    } catch (e) {
        console.warn('[JannyAPI] refresh bookmarks failed:', e.message);
    }
    return _bookmarkIds;
}

/** Add or remove one bookmark, enforcing the cap on add. */
export async function toggleJannyBookmark(id, add) {
    if (!_apiRequest) return { ok: false, error: 'cl-helper plugin not available' };
    if (add) {
        const guard = canAddBookmarks(_bookmarkIds.size, 1, jannyBookmarkCap());
        if (!guard.ok) return { ok: false, error: guard.reason };
    }
    try {
        if (add) {
            await _apiRequest(`${JANNY_PROXY_BASE}/api/bookmark`, 'POST', { characterIds: [id] });
        } else {
            await _apiRequest(`${JANNY_PROXY_BASE}/api/bookmark?ids=${encodeURIComponent(id)}`, 'DELETE');
        }
        reconcileBookmarkSet(_bookmarkIds, [id], add);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export async function fetchJannyBookmarkCharacters(ids) {
    const out = [];
    if (!_apiRequest || !ids?.length) return out;
    for (let i = 0; i < ids.length; i += GET_CHARACTERS_CHUNK) {
        const chunk = ids.slice(i, i + GET_CHARACTERS_CHUNK);
        try {
            const resp = await _apiRequest(`${JANNY_PROXY_BASE}/api/get-characters?ids=${chunk.map(encodeURIComponent).join(',')}`);
            const data = typeof resp?.json === 'function' ? await resp.json() : resp;
            const list = Array.isArray(data) ? data : (data?.characters || data?.results || []);
            out.push(...list);
        } catch (e) {
            console.warn('[JannyAPI] get-characters chunk failed:', e.message);
        }
    }
    return out;
}
```

- [ ] **Step 4: Syntax-check**

Run: `node --check modules/providers/janny/janny-api.js`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add modules/providers/janny/janny-api.js
git commit -m "feat(janny): add account + bookmark API helpers via cl-helper"
```

---

### Task 4: Wire provider deps + Connect JannyAI UI

**Files:**
- Modify: `modules/providers/janny/janny-provider.js` (bind deps at init, like `botbooru-provider.js:75`)
- Modify: `modules/providers/janny/janny-browse.js` (Connect UI + status states)
- Modify: `modules/providers/janny/janny-browse.css` (new controls; create if absent — janny has no browse.css yet, so create it and ensure it is loaded the same way sibling providers load theirs)

**Interfaces:**
- Consumes: `configureJannyAccount`, `connectJanny`, `jannyAuthStatus`, `disconnectJanny`, `jannyHelperAvailable` from `./janny-api.js`.
- Produces: a "Connect JannyAI" control block in the janny browse header with states signed-out / connected (shows count) / expired / helper-missing; module state `jannyConnected`.

- [ ] **Step 1: Bind deps in the provider**

In `janny-provider.js`, find where the provider initializes `api` / calls into `janny-api.js` (top-level `let api = null;` at line 20 and its init path). Add an import and a `configureJannyAccount` call wherever the provider has access to `CoreAPI`:

```javascript
import { configureJannyAccount } from './janny-api.js';
// ...inside the provider's init/registration (where coreAPI is available):
configureJannyAccount({ apiRequest: CoreAPI.apiRequest, getSetting });
```

Verify `CoreAPI` and `getSetting` are already imported in `janny-provider.js` (CoreAPI is imported at line 7). If `getSetting` is not in scope there, pass `apiRequest` only and call `configureJannyAccount({ getSetting })` again from `janny-browse.js` init (which already imports `getSetting`, line 23).

- [ ] **Step 2: Add the Connect UI markup**

In `janny-browse.js`, locate the browse header/toolbar region rendered near the search controls (search input wiring is at lines 967–998). Add a connect control next to the existing toolbar. Insert this HTML into the toolbar template string:

```html
<div id="jannyAccountBox" class="janny-account-box">
  <button id="jannyConnectBtn" class="janny-account-btn" title="Connect your JannyAI account to sync bookmarks">
    <i class="fa-regular fa-bookmark"></i> <span id="jannyConnectLabel">Connect JannyAI</span>
  </button>
</div>
```

- [ ] **Step 3: Add the connect flow + status render**

Add to `janny-browse.js` (near the other `on(...)` wiring in the init function ~line 967):

```javascript
import {
    configureJannyAccount, connectJanny, jannyAuthStatus, disconnectJanny,
    jannyHelperAvailable, refreshJannyBookmarkIds,
} from './janny-api.js';

let jannyConnected = false;

async function renderJannyAccountState() {
    const label = document.getElementById('jannyConnectLabel');
    const box = document.getElementById('jannyAccountBox');
    if (!label || !box) return;
    if (!(await jannyHelperAvailable())) {
        box.classList.add('helper-missing');
        label.textContent = 'JannyAI sync unavailable (cl-helper not installed)';
        return;
    }
    const status = await jannyAuthStatus();
    jannyConnected = status.connected;
    box.classList.toggle('connected', jannyConnected);
    label.textContent = jannyConnected
        ? `JannyAI: ${status.bookmarkCount ?? 0} bookmarked`
        : 'Connect JannyAI';
}

async function promptConnectJanny() {
    if (jannyConnected) {
        await disconnectJanny();
        await renderJannyAccountState();
        return;
    }
    const cookie = await window.callGenericPopup?.(
        'Paste your JannyAI session cookie (from a logged-in jannyai.com tab: DevTools → Application → Cookies → copy the whole cookie header, or run the Connect bookmarklet).',
        window.POPUP_TYPE?.INPUT ?? 3,
    );
    if (!cookie) return;
    const result = await connectJanny(String(cookie).trim());
    if (result.ok) {
        window.toastr?.success(`Connected to JannyAI (${result.bookmarkCount ?? 0} bookmarks)`);
    } else {
        window.toastr?.error(`JannyAI connect failed: ${result.error || 'unknown error'}`);
    }
    await renderJannyAccountState();
}

// wire in init():
on('jannyConnectBtn', 'click', () => promptConnectJanny());
// ensure deps bound + initial render (idempotent with provider binding):
configureJannyAccount({ getSetting });
renderJannyAccountState();
```

> Use the codebase's existing popup/toast utilities if they differ from `window.callGenericPopup`/`window.toastr` — grep `janny-browse.js` and siblings for how they already show input popups and toasts, and match that exact call. Do not introduce a new popup mechanism.

- [ ] **Step 4: Add minimal styles**

In `janny-browse.css` add:

```css
.janny-account-box { display: inline-flex; align-items: center; gap: 6px; }
.janny-account-btn { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.janny-account-box.connected .janny-account-btn { color: var(--active, #4caf50); }
.janny-account-box.helper-missing .janny-account-btn { opacity: 0.6; cursor: not-allowed; }
```

- [ ] **Step 5: Verify (manual, in SillyTavern)**

Reload the extension. Open the JannyAI browse view. Expected:
- With cl-helper installed and no session: button reads "Connect JannyAI".
- Click → paste cookie (from your logged-in tab) → toast "Connected to JannyAI (N bookmarks)" and label shows the count.
- Click again → disconnects, label returns to "Connect JannyAI".

- [ ] **Step 6: Commit**

```bash
git add modules/providers/janny/janny-provider.js modules/providers/janny/janny-browse.js modules/providers/janny/janny-browse.css
git commit -m "feat(janny): add Connect JannyAI account UI and status states"
```

---

### Task 5: Save/unsave bookmark button (desktop + mobile)

**Files:**
- Modify: `modules/providers/janny/janny-browse.js` (character modal button + toggle handler)
- Modify: `modules/providers/janny/janny-browse.css` (button styles)

**Interfaces:**
- Consumes: `toggleJannyBookmark`, `getJannyBookmarkIds`, `refreshJannyBookmarkIds` from `./janny-api.js`; `jannyConnected` from Task 4.
- Produces: `#jannyCharBookmarkBtn` (`.browse-fav-toggle`, `.favorited` when saved) inside the character modal; handler `toggleJannyCharBookmark`. Mobile action auto-derived by `library-mobile.js:~3825`.

- [ ] **Step 1: Add the button to the character modal**

In `janny-browse.js`, the character modal body is populated around lines 462–544 (`#jannyCharModal`, `.browse-char-body`). Locate where action buttons (e.g., an import/download button) are rendered in that modal and add, next to them, a bookmark toggle mirroring chub's `#chubCharFavoriteBtn` (chub-browse.js:666) but with a bookmark glyph:

```html
<span id="jannyCharBookmarkBtn" class="janny-bookmark-btn-inline browse-fav-toggle"
      title="Bookmark on JannyAI"><i class="fa-regular fa-bookmark"></i>
  <span id="jannyCharBookmarkLabel">Bookmark</span></span>
```

- [ ] **Step 2: Add the toggle handler + button-state updater**

Add to `janny-browse.js` (model on chub's `updateChubFavoriteButton` / `toggleChubCharFavorite` at lines 3847 / 3936). `_currentJannyChar` is whatever variable the modal already uses to hold the open character — reuse it; grep the modal render code (~line 462) for the character object it stores:

```javascript
import { toggleJannyBookmark, getJannyBookmarkIds } from './janny-api.js';

function jannyCharId(char) {
    return char?.id || char?.characterId || char?.uuid || null;
}

function updateJannyBookmarkButton(char) {
    const btn = document.getElementById('jannyCharBookmarkBtn');
    const label = document.getElementById('jannyCharBookmarkLabel');
    if (!btn) return;
    const id = jannyCharId(char);
    const saved = !!id && getJannyBookmarkIds().has(id);
    btn.classList.toggle('favorited', saved);
    const icon = btn.querySelector('i');
    if (icon) icon.className = saved ? 'fa-solid fa-bookmark' : 'fa-regular fa-bookmark';
    if (label) label.textContent = saved ? 'Remove bookmark' : 'Bookmark';
    btn.style.display = jannyConnected ? '' : 'none';
}

async function toggleJannyCharBookmark() {
    if (!jannyConnected) { window.toastr?.info('Connect JannyAI first'); return; }
    const char = _currentJannyChar; // reuse the modal's open-character variable
    const id = jannyCharId(char);
    if (!id) return;
    const btn = document.getElementById('jannyCharBookmarkBtn');
    const wasSaved = getJannyBookmarkIds().has(id);
    btn?.classList.add('loading');
    const result = await toggleJannyBookmark(id, !wasSaved);
    btn?.classList.remove('loading');
    if (!result.ok) { window.toastr?.error(result.error || 'JannyAI bookmark failed'); }
    updateJannyBookmarkButton(char);
}

// wire in init():
on('jannyCharBookmarkBtn', 'click', () => toggleJannyCharBookmark());
```

- [ ] **Step 3: Call the updater when the modal opens**

In the modal-open code (~line 462–544), after the character is rendered, add:

```javascript
updateJannyBookmarkButton(char); // `char` = the character object the modal just rendered
```

- [ ] **Step 4: Add styles + mobile label**

In `janny-browse.css`:

```css
.janny-bookmark-btn-inline { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.janny-bookmark-btn-inline.favorited { color: var(--active, #4caf50); }
.janny-bookmark-btn-inline.loading { opacity: 0.5; pointer-events: none; }
```

Confirm mobile pickup: `app/library-mobile.js:~3825` finds `.browse-fav-toggle` in the modal and builds a mobile action from it. Because our label already reads "Bookmark"/"Remove bookmark", the mobile item inherits it. If the mobile code hardcodes the word "Favorite"/"Unfavorite" (lines ~3676, ~3833), add a JannyAI branch there that reads the toggle's own label text instead of hardcoding, so mobile shows "Bookmark"/"Remove bookmark".

- [ ] **Step 5: Verify (manual)**

Desktop: open a JannyAI character while connected → button shows correct saved state → click toggles it (verify on jannyai.com the bookmark actually changed) → at 220 bookmarks, adding shows the cap warning toast and does nothing.
Mobile (`library-mobile`): open the same character → the actions sheet shows "Bookmark"/"Remove bookmark" and toggles correctly.

- [ ] **Step 6: Commit**

```bash
git add modules/providers/janny/janny-browse.js modules/providers/janny/janny-browse.css app/library-mobile.js
git commit -m "feat(janny): add bookmark save/unsave button (desktop + mobile)"
```

---

### Task 6: "My Bookmarks" data-source view + filter, settings, and E2E verification

**Files:**
- Modify: `modules/providers/janny/janny-browse.js` (filter checkbox + data-source load)
- Modify: `index.js` and/or the provider settings schema (add `jannyBookmarkCap` default 220; follow how `jannyNsfw` is declared — grep `jannyNsfw`)

**Interfaces:**
- Consumes: `refreshJannyBookmarkIds`, `getJannyBookmarkIds`, `fetchJannyBookmarkCharacters` from `./janny-api.js`; the existing janny render pipeline (the function that takes an array of character objects and renders cards — grep the search-result render path used by `doSearch`, ~line 977).
- Produces: `#jannyFilterBookmarks` checkbox + `jannyFilterBookmarks` state; a data-source branch that renders the user's bookmarks instead of MeiliSearch results.

- [ ] **Step 1: Add the filter checkbox markup**

In the janny filters dropdown (opened by `jannyFiltersBtn`, wired ~line 1077), add, mirroring `botbooruFilterFavorites` (botbooru-browse.js:623):

```html
<label class="filter-checkbox">
  <input type="checkbox" id="jannyFilterBookmarks">
  <i class="fa-solid fa-bookmark"></i> My Bookmarks
</label>
```

- [ ] **Step 2: Add state + wiring + data-source load**

Add to `janny-browse.js`:

```javascript
import { fetchJannyBookmarkCharacters } from './janny-api.js';

let jannyFilterBookmarks = false;

async function loadJannyBookmarksView() {
    if (!jannyConnected) {
        window.toastr?.warning('Connect JannyAI to view your bookmarks');
        const cb = document.getElementById('jannyFilterBookmarks');
        if (cb) cb.checked = false;
        jannyFilterBookmarks = false;
        return;
    }
    await refreshJannyBookmarkIds();
    const ids = [...getJannyBookmarkIds()];
    const chars = await fetchJannyBookmarkCharacters(ids);
    renderJannyCharacters(chars); // reuse the existing render function used by doSearch
}

// wire in init():
on('jannyFilterBookmarks', 'change', (e) => {
    jannyFilterBookmarks = e.target.checked;
    if (jannyFilterBookmarks) loadJannyBookmarksView();
    else doSearch(); // return to normal search results
});
```

Replace `renderJannyCharacters` with the actual render function name found in Step's grep (the one `doSearch` calls to paint cards). If bookmarks exceed one screen, page over `ids` in slices of the provider's page size, appending on "Load more" — reuse the existing `jannyLoadMoreBtn` handler (line 992) guarded by an `if (jannyFilterBookmarks)` branch that pulls the next id-slice instead of the next MeiliSearch page.

- [ ] **Step 3: Add the `jannyBookmarkCap` setting**

Grep `jannyNsfw` across `index.js` / settings schema to find where janny settings defaults live, and add a sibling default:

```javascript
jannyBookmarkCap: 220,
```

No UI is strictly required (the cap works from the default); if the janny settings panel lists toggles, add a number input bound to `jannyBookmarkCap` next to the JannyAI NSFW toggle, following that toggle's exact binding pattern.

- [ ] **Step 4: Run the pure-logic tests again (regression)**

Run: `node --test tests/janny-bookmark-logic.test.mjs`
Expected: PASS — 5 tests.

- [ ] **Step 5: Full manual E2E verification**

With cl-helper installed and logged into jannyai.com in the browser:
1. Connect JannyAI → label shows saved count.
2. Enable "My Bookmarks" → grid shows your saved characters (cards render via the normal pipeline).
3. Open one → "Remove bookmark" → it toggles off (confirm on jannyai.com) → re-add.
4. Disable "My Bookmarks" → normal search returns.
5. Cap: at 220, adding a new bookmark shows the cap warning and does not exceed (test via remove→re-add so you never actually cross 220).
6. Expired session: run `POST /jy-logout` (or wait for expiry) → next action reports "session expired"; anonymous browse still works.
7. cl-helper absent (rename/stop it): account UI shows "unavailable"; anonymous JannyAI browse/search/import still works unchanged.

- [ ] **Step 6: Commit**

```bash
git add modules/providers/janny/janny-browse.js index.js
git commit -m "feat(janny): add My Bookmarks data-source view, filter, and cap setting"
```

---

## Self-Review

**Spec coverage:**
- Connect JannyAI (cookie handoff) → Task 1 (routes) + Task 4 (UI). ✓
- Save/unsave to bookmarks → Task 3 (helpers) + Task 5 (button). ✓
- ~220 cap guard → Task 2 (logic+tests) + enforced in Task 3 `toggleJannyBookmark` + Task 6 setting. ✓
- Mirror bookmarks into CL + "My Bookmarks" filter → Task 6. ✓
- Mobile save button → Task 5 (`.browse-fav-toggle` derivation). ✓
- Signed-out/connected/expired/helper-missing states → Task 4 `renderJannyAccountState`. ✓
- Bookmark glyph (not heart) → Global Constraints + Task 5 markup. ✓
- Anonymous browse unchanged; cookie never in CL settings → Global Constraints; account paths are additive and cookie lives only in cl-helper. ✓
- Collections excluded (Phase B) → not in any task. ✓

**Placeholder scan:** No TBD/TODO. Two deliberate "match the existing pattern" pointers (popup/toast utility names in Task 4 Step 3; the exact render-function name in Task 6 Step 2) are grep-and-match instructions with concrete fallbacks, not missing logic — the surrounding janny file is 1.5k lines and the exact helper names must be read from it rather than guessed.

**Type consistency:** `getJannyBookmarkIds()` returns the same `Set` used by `canAddBookmarks(size,...)`, `reconcileBookmarkSet`, and the button/data-source code. `toggleJannyBookmark(id, add)` signature is consistent across Tasks 3 and 5. `configureJannyAccount({ apiRequest, getSetting })` matches its calls in Task 4. Route names (`/jy-set-cookie`, `/jy-validate`, `/jy-logout`, `/jy-session`, `/jy-proxy/*`) are identical in Task 1 and the `janny-api.js` callers in Task 3.
