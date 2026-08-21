# JannyAI Bridge Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the JannyAI cookie-relay transport (cl-helper server proxy) with a Tampermonkey userscript bridge, mirroring upstream v6.7.0's `cl-janitor-bridge.user.js` pattern, with zero-paste login.

**Architecture:** A new userscript (`extras/cl-janny-bridge.user.js`) makes allowlisted jannyai.com requests via `GM_xmlhttpRequest` (CORS-exempt, carries the browser's own cf_clearance + `sb-…-auth-token.0/.1` cookies). A page-side client (`janny-bridge.js`) talks to it over origin-checked postMessage. `janny-api.js` account/public-collection functions re-route through the bridge; the HTML parsers move client-side into `janny-html.js`. All cl-helper janny plumbing, cookie UI, and the Android WebView bridge are deleted.

**Tech Stack:** Vanilla ES modules, GM_xmlhttpRequest userscript, `node --test` (node:test + assert/strict).

**Spec:** `docs/superpowers/specs/2026-07-18-jannyai-bridge-transport-design.md`

## Global Constraints

- **Push after every commit** (`git push origin codex/jannyai-account-sync`) — the user tests from GitHub.
- Do NOT modify `extras/cl-janitor-bridge.user.js` or anything under `modules/providers/datacat/` — upstream-owned.
- Message tags: page→script `source: 'character-library-janny'`; script→page `source: 'cl-janny-bridge'`. Never reuse datacat's `'character-library'`/`'cl-janitor-bridge'` tags.
- Bridge allowlist host: exactly `https://jannyai.com` (origin check via `new URL()`), no other hosts, no wildcard subdomains.
- Tests: `node --test tests/<file>` from repo root. Tests that import window-touching modules must set `globalThis.window` BEFORE a dynamic `import()` of the module (no `--import` shim needed for the files in this plan).
- Settings UI must work on mobile (user is mobile-first); any element toggled via `.hidden` inside browse-shared.css scope needs an explicit `.X.hidden { display: none; }` re-hide rule (browse-shared.css loads after library.css and its display rules win).
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Map

| File | Action |
|---|---|
| `extras/cl-janny-bridge.user.js` | Create — userscript |
| `modules/providers/janny/janny-bridge.js` | Create — page-side postMessage client |
| `modules/providers/janny/janny-html.js` | Create — parsers moved from cl-helper/janny-account.js |
| `modules/providers/janny/janny-api.js` | Modify — account section rides the bridge |
| `modules/providers/janny/janny-browse.js` | Modify — status/gating, drop cookie plumbing |
| `modules/providers/janny/janny-provider.js` | Modify — init bridge, drop setJannyApiRequest |
| `app/library.html` | Modify — status-only settings group, Help & Tips text |
| `app/library.js` | Modify — drop cookie plumbing, add status refresh |
| `app/library-mobile.css`, `modules/providers/browse-shared.css` | Modify — remove cookie-UI-only rules |
| `extras/cl-helper/index.js`, `extras/cl-helper/package.json` | Restore to `main` (upstream 1.8.1) |
| `extras/cl-helper/janny-account.js` | Delete |
| `extras/android-webview-bridge/` | Delete |
| `tests/janny-bridge-userscript-static.test.mjs` | Create |
| `tests/janny-bridge.test.mjs` | Create |
| `tests/janny-html.test.mjs` | Create (port parser tests) |
| `tests/janny-api-account.test.mjs` | Create |
| `tests/janny-account.test.mjs` | Delete (superseded) |
| `tests/janny-settings-account.test.mjs` | Rewrite |
| `README.md` | Modify — bridge instructions replace cookie instructions |

---

### Task 1: Userscript `extras/cl-janny-bridge.user.js`

**Files:**
- Create: `extras/cl-janny-bridge.user.js`
- Test: `tests/janny-bridge-userscript-static.test.mjs`

**Interfaces:**
- Produces (postMessage protocol consumed by Task 2):
  - listens for `{ source: 'character-library-janny', type: 'ping' }` → replies `{ source: 'cl-janny-bridge', type: 'ready' }`
  - listens for `{ source: 'character-library-janny', type: 'fetch', id, method, url, body, contentType }` → replies `{ source: 'cl-janny-bridge', type: 'result', id, ok, status, body, finalUrl }`

- [ ] **Step 1: Write the failing static test**

```js
// tests/janny-bridge-userscript-static.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../extras/cl-janny-bridge.user.js', import.meta.url), 'utf8');

test('janny bridge userscript is scoped to jannyai.com only', () => {
    assert.match(src, /@connect\s+jannyai\.com/);
    assert.doesNotMatch(src, /janitorai\.com/);
    assert.match(src, /https:\/\/jannyai\.com/);
});

test('janny bridge uses its own message tags (no cross-talk with the janitor bridge)', () => {
    assert.match(src, /'character-library-janny'/);
    assert.match(src, /'cl-janny-bridge'/);
    assert.doesNotMatch(src, /'cl-janitor-bridge'/);
});

test('janny bridge allowlists the account + public collection surface', () => {
    for (const marker of [
        '/api/bookmark',
        '/api/get-characters',
        '/api/collections/mine',
        '/collections/form/add-collection',
        '/collections/form/edit-collection',
        '/collections/form/delete-collection',
        'collectors',
    ]) {
        assert.ok(src.includes(marker), `missing allowlist marker: ${marker}`);
    }
});

test('janny bridge keeps the security guards', () => {
    assert.match(src, /e\.origin !== location\.origin/);
    assert.match(src, /@noframes/);
    assert.match(src, /finalUrl/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/janny-bridge-userscript-static.test.mjs`
Expected: FAIL (ENOENT — userscript file does not exist).

- [ ] **Step 3: Write the userscript**

```js
// extras/cl-janny-bridge.user.js
// ==UserScript==
// @name         Character Library - JannyAI Bridge
// @namespace    https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary
// @version      1.0.0
// @description  Lets Character Library sync JannyAI bookmarks and collections by making the Cloudflare-gated requests from your own logged-in browser.
// @author       DJLegends
// @match        *://*/*
// @connect      jannyai.com
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * WHY THIS EXISTS
 * CL's page cannot send your jannyai.com cookies cross-origin, so Cloudflare blocks its
 * direct requests and login is impossible. GM_xmlhttpRequest is CORS-exempt: it carries
 * your browser's own jannyai cookies (cf_clearance AND the sb-...-auth-token session
 * chunks), so being logged into jannyai.com in this browser IS the login. Nothing is
 * pasted or stored.
 *
 * SECURITY
 * Privileged context, deliberately locked down:
 *   - ONLY https://jannyai.com requests, and only the method+path pairs in isAllowed()
 *     below (bookmarks, collections, public collection pages). Anything else is refused.
 *   - Only answers same-origin messages tagged by CL ('character-library-janny').
 *   - @connect jannyai.com makes the userscript manager enforce the host boundary too.
 */

(function () {
    'use strict';

    const PAGE_SRC = 'character-library-janny';
    const SCRIPT_SRC = 'cl-janny-bridge';
    const JANNY_ORIGIN = 'https://jannyai.com';

    const isCLPage = /\/SillyTavern-CharacterLibrary\/app\/library\.html/i.test(location.pathname)
        || !!document.querySelector('meta[name="character-library"]');
    if (!isCLPage) return;
    console.debug('[CL-JannyBridge] active on Character Library page');

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const COLLECTION_PATH_RE = /^\/collections\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:_[^/?#]+)?$/i;
    const COLLECTION_CHARACTERS_RE = /^\/api\/collections\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/characters$/i;
    const FORM_PATHS = [
        '/collections/form/add-collection',
        '/collections/form/edit-collection',
        '/collections/form/delete-collection',
    ];

    function csvIdsAreSafe(value) {
        if (!value || value.length > 4096) return false;
        return value.split(',').every(id => UUID_RE.test(id.trim()));
    }

    function isAllowed(method, urlStr) {
        let url;
        try { url = new URL(urlStr); } catch { return false; }
        if (url.origin !== JANNY_ORIGIN) return false;

        const verb = String(method || 'GET').toUpperCase();
        const p = url.pathname;
        const params = url.searchParams;
        const paramKeys = [...params.keys()];
        const hasOnly = (allowed) => paramKeys.every(k => allowed.includes(k));
        const noParams = paramKeys.length === 0;

        // Public collection browsing (HTML pages).
        if (verb === 'GET' && p === '/collections') return hasOnly(['page', 'sort', 'q']);
        if (verb === 'GET' && /^\/collectors\/[^/?#]{1,128}$/.test(p)) return noParams;
        if (verb === 'GET' && COLLECTION_PATH_RE.test(p)) return noParams;

        // Bookmarks.
        if (p === '/api/bookmark') {
            if (verb === 'GET' || verb === 'POST') return noParams;
            if (verb === 'DELETE') return hasOnly(['ids']) && csvIdsAreSafe(params.get('ids'));
            return false;
        }

        // Character hydration.
        if (verb === 'GET' && p === '/api/get-characters') {
            return hasOnly(['ids']) && csvIdsAreSafe(params.get('ids'));
        }

        // Collections (JSON APIs).
        if (verb === 'GET' && p === '/api/collections/mine') return noParams;
        if (COLLECTION_CHARACTERS_RE.test(p)) {
            if (verb === 'GET' || verb === 'POST') return noParams;
            if (verb === 'DELETE') return hasOnly(['characterId']) && UUID_RE.test(params.get('characterId') || '');
            return false;
        }

        // Collection create/edit/delete (server-rendered form POSTs, 302 on success).
        if (verb === 'POST' && FORM_PATHS.includes(p)) return noParams;

        return false;
    }

    const gmRequest = (typeof GM_xmlhttpRequest === 'function')
        ? GM_xmlhttpRequest
        : (typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest.bind(GM) : null);

    function reply(id, ok, status, body, finalUrl) {
        window.postMessage({ source: SCRIPT_SRC, type: 'result', id, ok, status, body, finalUrl: finalUrl || '' }, location.origin);
    }

    function announce() {
        window.postMessage({ source: SCRIPT_SRC, type: 'ready' }, location.origin);
    }

    window.addEventListener('message', (e) => {
        // Origin-guarded rather than e.source === window: under an Xray wrapper the sandbox
        // window is not identity-equal to the page window.
        if (e.origin !== location.origin) return;
        const msg = e.data;
        if (!msg || msg.source !== PAGE_SRC) return;

        if (msg.type === 'ping') { announce(); return; }
        if (msg.type !== 'fetch') return;

        const { id, method, url, body, contentType } = msg;
        if (!id) return;
        if (!gmRequest) { reply(id, false, 0, 'Userscript manager does not expose GM_xmlhttpRequest'); return; }
        if (!isAllowed(method, url)) { reply(id, false, 0, 'Blocked: bridge only permits allowlisted JannyAI requests'); return; }

        const headers = { 'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8' };
        if (typeof contentType === 'string' && contentType) headers['Content-Type'] = contentType;

        gmRequest({
            method: String(method).toUpperCase(),
            url,
            headers,
            data: typeof body === 'string' && body ? body : undefined,
            timeout: 25000,
            onload: (r) => reply(id, r.status >= 200 && r.status < 400, r.status, r.responseText || '', r.finalUrl || ''),
            onerror: () => reply(id, false, 0, 'Network error'),
            ontimeout: () => reply(id, false, 0, 'Timed out'),
        });
    });

    announce();
})();
```

Note: `ok` is `status < 400` (not `< 300` like the janitor bridge) because collection form-POSTs legitimately answer 302 when the manager surfaces the redirect status directly.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/janny-bridge-userscript-static.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit and push**

```bash
git add extras/cl-janny-bridge.user.js tests/janny-bridge-userscript-static.test.mjs
git commit -m "feat: JannyAI userscript bridge (allowlisted GM_xmlhttpRequest transport)"
git push origin codex/jannyai-account-sync
```

---

### Task 2: Page-side client `modules/providers/janny/janny-bridge.js`

**Files:**
- Create: `modules/providers/janny/janny-bridge.js`
- Test: `tests/janny-bridge.test.mjs`

**Interfaces:**
- Consumes: the userscript protocol from Task 1.
- Produces (used by Tasks 4, 5, 7):
  - `initJannyBridge(): void` — idempotent; attaches listener, pings, sets `window.clJannyBridge = { isAvailable, request }`
  - `isJannyBridgeAvailable(): boolean`
  - `jannyBridgeFetch(method: string, url: string, { body?: string, contentType?: string } = {}): Promise<{ ok, status, body, finalUrl }>` — rejects on no-bridge/timeout

- [ ] **Step 1: Write the failing test**

```js
// tests/janny-bridge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal same-origin window shim: postMessage loops back to listeners asynchronously,
// exactly like the real page<->userscript channel.
function makeFakeWindow() {
    const listeners = [];
    const win = {
        location: { origin: 'http://127.0.0.1:8001' },
        addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
        postMessage(data, _origin) {
            queueMicrotask(() => { for (const fn of [...listeners]) fn({ data, origin: win.location.origin }); });
        },
    };
    return win;
}

globalThis.window = makeFakeWindow();
const { initJannyBridge, isJannyBridgeAvailable, jannyBridgeFetch } =
    await import('../modules/providers/janny/janny-bridge.js');

// Acts as the userscript side. One listener, one swappable fetch handler — repeated
// installs must NOT stack listeners or earlier tests' handlers would also fire (and an
// assert inside a stacked handler would throw as an unhandled microtask rejection).
let fetchHandler = null;
let listenerInstalled = false;
function installFakeUserscript(handler) {
    fetchHandler = handler;
    if (listenerInstalled) return;
    listenerInstalled = true;
    window.addEventListener('message', (e) => {
        const msg = e.data;
        if (!msg || msg.source !== 'character-library-janny') return;
        if (msg.type === 'ping') {
            window.postMessage({ source: 'cl-janny-bridge', type: 'ready' }, window.location.origin);
            return;
        }
        if (msg.type === 'fetch' && fetchHandler) fetchHandler(msg);
    });
    // The real userscript announces on load; do the same so the bridge (which already
    // pinged before this listener existed) learns we are here.
    window.postMessage({ source: 'cl-janny-bridge', type: 'ready' }, window.location.origin);
}

test('bridge reports unavailable before handshake and rejects fetches', async () => {
    initJannyBridge();
    assert.equal(isJannyBridgeAvailable(), false);
    await assert.rejects(
        jannyBridgeFetch('GET', 'https://jannyai.com/api/bookmark'),
        /not available/,
    );
});

test('handshake marks the bridge available and round-trips a fetch', async () => {
    let seen = null;
    installFakeUserscript((msg) => {
        seen = msg;
        window.postMessage({
            source: 'cl-janny-bridge', type: 'result', id: msg.id,
            ok: true, status: 200, body: '{"bookmarks":[]}', finalUrl: msg.url,
        }, window.location.origin);
    });
    await new Promise(r => setTimeout(r, 0)); // let the fake userscript's ready land
    assert.equal(isJannyBridgeAvailable(), true);

    const res = await jannyBridgeFetch('GET', 'https://jannyai.com/api/bookmark');
    assert.equal(seen.method, 'GET');
    assert.equal(seen.url, 'https://jannyai.com/api/bookmark');
    assert.deepEqual(res, { ok: true, status: 200, body: '{"bookmarks":[]}', finalUrl: 'https://jannyai.com/api/bookmark' });
});

test('fetch forwards body and contentType for writes', async () => {
    let seen = null;
    installFakeUserscript((msg) => {
        seen = msg;
        window.postMessage({ source: 'cl-janny-bridge', type: 'result', id: msg.id, ok: true, status: 200, body: '{}', finalUrl: '' }, window.location.origin);
    });
    await jannyBridgeFetch('POST', 'https://jannyai.com/api/bookmark', {
        body: '{"characterIDs":["x"]}', contentType: 'application/json',
    });
    assert.equal(seen.body, '{"characterIDs":["x"]}');
    assert.equal(seen.contentType, 'application/json');
});

test('replies from unknown sources are ignored', async () => {
    installFakeUserscript((msg) => {
        // Wrong source first (must be ignored), then the real reply.
        window.postMessage({ source: 'cl-janitor-bridge', type: 'result', id: msg.id, ok: false, status: 500, body: 'wrong' }, window.location.origin);
        window.postMessage({ source: 'cl-janny-bridge', type: 'result', id: msg.id, ok: true, status: 200, body: 'right', finalUrl: '' }, window.location.origin);
    });
    const res = await jannyBridgeFetch('GET', 'https://jannyai.com/api/collections/mine');
    assert.equal(res.body, 'right');
});

test('initJannyBridge exposes window.clJannyBridge for the settings UI', () => {
    assert.equal(typeof window.clJannyBridge?.isAvailable, 'function');
    assert.equal(typeof window.clJannyBridge?.request, 'function');
    assert.equal(window.clJannyBridge.isAvailable(), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/janny-bridge.test.mjs`
Expected: FAIL (cannot find module janny-bridge.js).

- [ ] **Step 3: Implement `modules/providers/janny/janny-bridge.js`**

```js
// JannyAI userscript bridge (transport for account sync + public collection pages).
//
// CL's page cannot send jannyai.com cookies cross-origin, so Cloudflare blocks direct
// fetches and cookie-based login can't ride them at all. The companion userscript
// (extras/cl-janny-bridge.user.js) closes the gap: GM_xmlhttpRequest is CORS-exempt and
// carries the browser's own jannyai cookies — cf_clearance AND the sb-...-auth-token
// session chunks — so being logged into jannyai.com in this browser IS the login.
//
// Pure postMessage transport, mirroring datacat/janitor-bridge.js but with write support
// (method/body/contentType) and finalUrl surfaced for redirect-answering form POSTs.
// Distinct message tags keep the two userscripts from ever processing each other's traffic.

const PAGE_SRC = 'character-library-janny';
const SCRIPT_SRC = 'cl-janny-bridge';
const REQUEST_TIMEOUT_MS = 30000;

let bridgeReady = false;
let initialized = false;
const pending = new Map(); // requestId -> { resolve, timer }

function handleMessage(e) {
    // Origin-guarded, not e.source === window: the userscript runs behind an Xray wrapper
    // (Firefox), so its window is not identity-equal to the page's.
    if (e.origin !== window.location.origin) return;
    const msg = e.data;
    if (!msg || msg.source !== SCRIPT_SRC) return;

    if (msg.type === 'ready') {
        if (!bridgeReady) console.debug('[CL] JannyAI userscript bridge connected');
        bridgeReady = true;
        return;
    }
    if (msg.type === 'result') {
        const p = pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.resolve({
            ok: !!msg.ok,
            status: msg.status || 0,
            body: typeof msg.body === 'string' ? msg.body : '',
            finalUrl: typeof msg.finalUrl === 'string' ? msg.finalUrl : '',
        });
    }
}

export function initJannyBridge() {
    if (initialized) return;
    initialized = true;
    window.addEventListener('message', handleMessage);
    // Symmetric handshake: the userscript announces 'ready' on load, and this ping
    // re-triggers that announce if the userscript attached first.
    window.postMessage({ source: PAGE_SRC, type: 'ping' }, window.location.origin);
    // Settings UI (app/library.js) lives outside the module graph; give it a handle.
    window.clJannyBridge = { isAvailable: isJannyBridgeAvailable, request: jannyBridgeFetch };
}

export function isJannyBridgeAvailable() {
    return bridgeReady;
}

// Resolves { ok, status, body, finalUrl }; rejects on transport failure (no bridge /
// timeout) so callers can surface an install-the-userscript state.
export function jannyBridgeFetch(method, url, { body, contentType } = {}) {
    return new Promise((resolve, reject) => {
        if (!bridgeReady) {
            reject(new Error('JannyAI bridge not available'));
            return;
        }
        const id = `cljy_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('JannyAI bridge request timed out'));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        window.postMessage({ source: PAGE_SRC, type: 'fetch', id, method, url, body, contentType }, window.location.origin);
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/janny-bridge.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit and push**

```bash
git add modules/providers/janny/janny-bridge.js tests/janny-bridge.test.mjs
git commit -m "feat: page-side JannyAI bridge client (postMessage transport)"
git push origin codex/jannyai-account-sync
```

---

### Task 3: Client-side parsers `modules/providers/janny/janny-html.js`

**Files:**
- Create: `modules/providers/janny/janny-html.js`
- Test: `tests/janny-html.test.mjs`
- Reference (do not modify yet): `extras/cl-helper/janny-account.js`

**Interfaces:**
- Produces (used by Task 4):
  - `parseJannyPublicCollectionsPage(html): { collections: Array<{id,name,path,url,description,characterCount,ownerName,viewCount,updatedAt,images}>, hasMore: boolean }`
  - `parseJannyPublicCollectionDetailPage(html, path): { collection, characterIds: string[], characterUrls: string[] }`
  - `validateJannyPublicCollectionPath(path): { ok, path?, error? }`
  - `validateJannyCollectorName(name): { ok, name?, error? }`
  - `detectJannyCloudflareBody(status: number, body: string): boolean`

- [ ] **Step 1: Create the test by porting the parser tests**

Copy `tests/janny-account.test.mjs` to `tests/janny-html.test.mjs`, then edit the copy:
1. Change the import to `from '../modules/providers/janny/janny-html.js'` and keep ONLY these names: `parseJannyPublicCollectionsPage`, `parseJannyPublicCollectionDetailPage`, `validateJannyPublicCollectionPath`, `validateJannyCollectorName`, plus add `detectJannyCloudflareBody`.
2. Delete every test that exercises removed helpers: `sanitizeJannyCookieHeader`, `buildJannyPublicRequestHeaders`, `buildFlareSolverrJannyRequest`, `jannyFamilyOrder`, `isAllowedJannyAccountRequest`, `isJannyCollectionFormPath`, `parseJannyBookmarkPage`, `summarizeJannyResponseForClient`, `validateJannyPublicCharacterIds`, `detectJannyCloudflareChallenge`.
3. Add a replacement challenge-detector test:

```js
test('detectJannyCloudflareBody flags real challenges but not injected scripts on 2xx', () => {
    assert.equal(detectJannyCloudflareBody(403, '<title>Just a moment...</title>'), true);
    assert.equal(detectJannyCloudflareBody(403, 'window._cf_chl_opt = {}'), true);
    assert.equal(detectJannyCloudflareBody(403, '<script src="/cdn-cgi/challenge-platform/h/g"></script>'), true);
    // Cloudflare injects its detection script into legitimate 200s — not a challenge.
    assert.equal(detectJannyCloudflareBody(200, '<script src="/cdn-cgi/challenge-platform/h/g"></script><div>real page</div>'), false);
    assert.equal(detectJannyCloudflareBody(200, '<title>Just a moment</title>'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/janny-html.test.mjs`
Expected: FAIL (cannot find module janny-html.js).

- [ ] **Step 3: Create `janny-html.js` by moving code**

Create `modules/providers/janny/janny-html.js` with a header comment (`// JannyAI HTML parsers for public collection pages — moved client-side from cl-helper now that the userscript bridge fetches these pages in the browser.`) and move **verbatim** from `extras/cl-helper/janny-account.js` (leave the source file untouched for now — Task 6 deletes it):

- Constants: `JANNY_BASE`, `UUID_RE`, `CHARACTER_PATH_RE`, `COLLECTION_PATH_RE`, `CHARACTER_LINK_RE` (lines 1, 6–9)
- Private helpers (lines 118–272): `decodeJannyHtml`, `stripJannyTags`, `parseJannyCompactNumber`, `jannyAttr`, `normalizeJannyCollectionPath`, `extractJannyCollectionName`, `extractJannyUpdatedAt`, `extractJannyImages`, `extractJannyOwnerName`, `parseAccountPath`, `JANNY_CARD_SEGMENT_CAP`, `JANNY_LAST_UPDATED_TEXT_RE`, `stripJannyParagraphs`, `extractJannyCardDescription`, `stripJannyCollectionNameSuffix`
- Exported: `validateJannyPublicCollectionPath` (227–233), `validateJannyCollectorName` (237–242), `parseJannyPublicCollectionsPage` (274–330), `parseJannyPublicCollectionDetailPage` (332–395)
- New export (body-only adaptation of `detectJannyCloudflareChallenge`, no headers arg — the bridge doesn't surface response headers):

```js
// Challenge pages are HTML with distinctive markers. Cloudflare also injects its
// JS-detection script into legitimate 2xx pages, so looser markers only count on errors.
export function detectJannyCloudflareBody(status, body) {
    const lower = String(body || '').toLowerCase();
    if (lower.includes('<title>just a moment') || lower.includes('cf-chl-') || lower.includes('window._cf_chl_opt')) {
        return true;
    }
    if (status >= 400) {
        return lower.includes('just a moment')
            || lower.includes('cf_chl_')
            || lower.includes('/cdn-cgi/challenge-platform/');
    }
    return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/janny-html.test.mjs`
Expected: PASS. Also run `node --test tests/janny-account.test.mjs` — still PASS (source untouched).

- [ ] **Step 5: Commit and push**

```bash
git add modules/providers/janny/janny-html.js tests/janny-html.test.mjs
git commit -m "feat: move JannyAI public-collection HTML parsers client-side"
git push origin codex/jannyai-account-sync
```

---

### Task 4: Rewire `janny-api.js` onto the bridge

**Files:**
- Modify: `modules/providers/janny/janny-api.js:50-314` (the account section)
- Test: `tests/janny-api-account.test.mjs`

**Interfaces:**
- Consumes: `jannyBridgeFetch`/`isJannyBridgeAvailable` (Task 2), parsers (Task 3).
- Produces (consumed by Task 5's janny-browse and Task 7's settings):
  - Kept, same names, **options params removed**: `fetchJannyBookmarks()`, `addJannyBookmarks(ids)`, `removeJannyBookmarks(ids)`, `fetchJannyCharactersByIds(ids)`, `fetchJannyPublicCharactersByIds(ids)`, `fetchJannyCollections()`, `fetchJannyCollectionCharacters(collectionId)`, `addJannyCharacterToCollection(collectionId, characterId)`, `removeJannyCharacterFromCollection(collectionId, characterId)`, `createJannyCollection({name, description, isPrivate})`, `updateJannyCollection({id, name, description, isPrivate})`, `deleteJannyCollection(id)`, `fetchJannyPublicCollections({sort, page})`, `fetchJannyPublicCollection(path)`, `fetchJannyCollectorCollections(name)`
  - New: `probeJannyAccount(): Promise<{ bridge: boolean, active: boolean, cloudflare: boolean, reason: string }>`
  - Errors carry `err.status`, `err.cloudflare`, and `err.code` (`'JANNY_BRIDGE_MISSING'` | `'JANNY_LOGIN_REQUIRED'`)
  - **Deleted exports** (Task 5 removes their importers): `setJannyApiRequest`, `checkJannyPluginAvailable`, `setJannySessionCookie`, `clearJannySession`, `getJannySessionStatus`, `validateJannySession`, `fetchJannyBookmarkPage`

- [ ] **Step 1: Write the failing test**

```js
// tests/janny-api-account.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

function makeFakeWindow() {
    const listeners = [];
    const win = {
        location: { origin: 'http://127.0.0.1:8001' },
        addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
        postMessage(data, _origin) {
            queueMicrotask(() => { for (const fn of [...listeners]) fn({ data, origin: win.location.origin }); });
        },
    };
    return win;
}
globalThis.window = makeFakeWindow();

const { initJannyBridge } = await import('../modules/providers/janny/janny-bridge.js');
const api = await import('../modules/providers/janny/janny-api.js');

// Fake userscript: routes each allowed fetch through `routes`, a map of
// `${METHOD} ${pathname}` -> (url, msg) => partial result.
const routes = new Map();
window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.source !== 'character-library-janny') return;
    if (msg.type === 'ping') {
        window.postMessage({ source: 'cl-janny-bridge', type: 'ready' }, window.location.origin);
        return;
    }
    if (msg.type !== 'fetch') return;
    const url = new URL(msg.url);
    const handler = routes.get(`${msg.method.toUpperCase()} ${url.pathname}`);
    const result = handler
        ? handler(url, msg)
        : { ok: false, status: 404, body: 'no route' };
    window.postMessage({ source: 'cl-janny-bridge', type: 'result', id: msg.id, finalUrl: msg.url, ...result }, window.location.origin);
});
initJannyBridge();
await new Promise(r => setTimeout(r, 0));

test('fetchJannyBookmarks maps entry objects to ids', async () => {
    routes.set('GET /api/bookmark', () => ({
        ok: true, status: 200,
        body: JSON.stringify({ bookmarks: [{ characterId: 'aaaaaaaa-1111-4111-8111-111111111111' }, 'bbbbbbbb-2222-4222-8222-222222222222'] }),
    }));
    assert.deepEqual(await api.fetchJannyBookmarks(), [
        'aaaaaaaa-1111-4111-8111-111111111111',
        'bbbbbbbb-2222-4222-8222-222222222222',
    ]);
});

test('addJannyBookmarks POSTs a JSON characterIDs body', async () => {
    let seen = null;
    routes.set('POST /api/bookmark', (_url, msg) => {
        seen = msg;
        return { ok: true, status: 200, body: '{"bookmarks":[]}' };
    });
    await api.addJannyBookmarks(['aaaaaaaa-1111-4111-8111-111111111111']);
    assert.equal(seen.contentType, 'application/json');
    assert.deepEqual(JSON.parse(seen.body), { characterIDs: ['aaaaaaaa-1111-4111-8111-111111111111'] });
});

test('removeJannyBookmarks DELETEs with an ids query', async () => {
    let seenUrl = null;
    routes.set('DELETE /api/bookmark', (url) => {
        seenUrl = url;
        return { ok: true, status: 200, body: '{"bookmarks":[]}' };
    });
    await api.removeJannyBookmarks(['aaaaaaaa-1111-4111-8111-111111111111']);
    assert.equal(seenUrl.searchParams.get('ids'), 'aaaaaaaa-1111-4111-8111-111111111111');
});

test('createJannyCollection form-POSTs and extracts the new id from finalUrl', async () => {
    let seen = null;
    routes.set('POST /collections/form/add-collection', (_url, msg) => {
        seen = msg;
        return {
            ok: true, status: 200, body: '<html>edit page</html>',
            finalUrl: 'https://jannyai.com/collections/cccccccc-3333-4333-8333-333333333333_my-set/edit',
        };
    });
    const result = await api.createJannyCollection({ name: 'My Set', description: 'd', isPrivate: true });
    assert.equal(seen.contentType, 'application/x-www-form-urlencoded');
    assert.equal(new URLSearchParams(seen.body).get('isPrivate'), 'yes');
    assert.equal(result.id, 'cccccccc-3333-4333-8333-333333333333');
    assert.equal(result.success, true);
});

test('a 401 surfaces JANNY_LOGIN_REQUIRED', async () => {
    routes.set('GET /api/collections/mine', () => ({ ok: false, status: 401, body: '{"error":"unauthorized"}' }));
    await assert.rejects(api.fetchJannyCollections(), (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.code, 'JANNY_LOGIN_REQUIRED');
        return true;
    });
});

test('probeJannyAccount distinguishes logged-in from logged-out', async () => {
    routes.set('GET /api/bookmark', () => ({ ok: true, status: 200, body: '{"bookmarks":[]}' }));
    assert.deepEqual(await api.probeJannyAccount(), { bridge: true, active: true, cloudflare: false, reason: '' });

    routes.set('GET /api/bookmark', () => ({ ok: false, status: 401, body: '{}' }));
    const out = await api.probeJannyAccount();
    assert.equal(out.bridge, true);
    assert.equal(out.active, false);
});

test('fetchJannyPublicCollections parses the HTML page client-side', async () => {
    routes.set('GET /collections', (url) => {
        assert.equal(url.searchParams.get('sort'), 'latest');
        assert.equal(url.searchParams.get('page'), '2');
        return {
            ok: true, status: 200,
            body: '<a href="/collections/dddddddd-4444-4444-8444-444444444444_cool"><h3>Cool (12 characters)</h3></a>',
        };
    });
    const data = await api.fetchJannyPublicCollections({ sort: 'latest', page: 2 });
    assert.equal(data.ok, true);
    assert.equal(data.collections.length, 1);
    assert.equal(data.collections[0].id, 'dddddddd-4444-4444-8444-444444444444');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/janny-api-account.test.mjs`
Expected: FAIL (`api.probeJannyAccount is not a function`, and bookmark tests fail because the current code posts to cl-helper, not the bridge).

- [ ] **Step 3: Rewrite the account section of `janny-api.js`**

Replace everything from the `// ACCOUNT SYNC` banner (line 59) through the end of file with the code below, and delete the now-unused `CL_HELPER_PLUGIN_BASE` from the import on line 50 (keep `fetchWithProxy`).

```js
// ========================================
// ACCOUNT SYNC (bookmarks + collections via the userscript bridge)
// ========================================
// All jannyai.com account and public-collection requests ride the companion userscript
// (extras/cl-janny-bridge.user.js): GM_xmlhttpRequest carries the browser's own jannyai
// cookies, so Cloudflare passes and being logged into jannyai.com IS the login. No
// cookies are captured, stored, or relayed through cl-helper.

import { isJannyBridgeAvailable, jannyBridgeFetch } from './janny-bridge.js';
import {
    parseJannyPublicCollectionsPage,
    parseJannyPublicCollectionDetailPage,
    validateJannyPublicCollectionPath,
    validateJannyCollectorName,
    detectJannyCloudflareBody,
} from './janny-html.js';

async function jannyBridgeRequest(method, path, { json, form } = {}) {
    if (!isJannyBridgeAvailable()) {
        const err = new Error('JannyAI bridge userscript not detected');
        err.code = 'JANNY_BRIDGE_MISSING';
        throw err;
    }
    let body, contentType;
    if (json !== undefined) { body = JSON.stringify(json); contentType = 'application/json'; }
    if (form !== undefined) { body = new URLSearchParams(form).toString(); contentType = 'application/x-www-form-urlencoded'; }

    const res = await jannyBridgeFetch(method, `${JANNY_SITE_BASE}${path}`, { body, contentType });
    if (!res.ok) {
        const err = new Error(`JannyAI HTTP ${res.status}`);
        err.status = res.status;
        err.cloudflare = detectJannyCloudflareBody(res.status, res.body);
        if (res.status === 401) err.code = 'JANNY_LOGIN_REQUIRED';
        throw err;
    }
    return res;
}

function parseJsonBody(res) {
    try { return JSON.parse(res.body); } catch { return null; }
}

function toIdArray(ids) {
    return [...new Set((Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean))];
}

// /api/bookmark returns [{ characterId, createdAt }], not bare id strings,
// so pull the id out of each entry (tolerating a plain-string shape too).
function bookmarkEntryId(entry) {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') return entry.characterId || entry.character_id || entry.id || '';
    return '';
}

// Reports transport + login state for gating and the Settings panel. Never throws.
export async function probeJannyAccount() {
    if (!isJannyBridgeAvailable()) {
        return { bridge: false, active: false, cloudflare: false, reason: 'JannyAI bridge userscript not detected' };
    }
    try {
        await jannyBridgeRequest('GET', '/api/bookmark');
        return { bridge: true, active: true, cloudflare: false, reason: '' };
    } catch (err) {
        return {
            bridge: true,
            active: false,
            cloudflare: !!err.cloudflare,
            reason: err.code === 'JANNY_LOGIN_REQUIRED' ? 'Not logged into jannyai.com in this browser' : err.message,
        };
    }
}

export async function fetchJannyBookmarks() {
    const data = parseJsonBody(await jannyBridgeRequest('GET', '/api/bookmark'));
    const bookmarks = data?.bookmarks || [];
    return Array.isArray(bookmarks) ? bookmarks.map(bookmarkEntryId).filter(Boolean) : [];
}

export async function addJannyBookmarks(ids) {
    const characterIDs = toIdArray(ids);
    if (!characterIDs.length) return [];
    const data = parseJsonBody(await jannyBridgeRequest('POST', '/api/bookmark', { json: { characterIDs } }));
    return data?.bookmarks || [];
}

export async function removeJannyBookmarks(ids) {
    const characterIDs = toIdArray(ids);
    if (!characterIDs.length) return [];
    const data = parseJsonBody(await jannyBridgeRequest('DELETE', `/api/bookmark?ids=${encodeURIComponent(characterIDs.join(','))}`));
    return data?.bookmarks || [];
}

// Keep ?ids= URLs comfortably short regardless of how many ids a caller passes.
const JANNY_GET_CHARACTERS_CHUNK = 20;

export async function fetchJannyCharactersByIds(ids) {
    const characterIDs = toIdArray(ids);
    if (!characterIDs.length) return [];
    const out = [];
    for (let i = 0; i < characterIDs.length; i += JANNY_GET_CHARACTERS_CHUNK) {
        const chunk = characterIDs.slice(i, i + JANNY_GET_CHARACTERS_CHUNK);
        const data = parseJsonBody(await jannyBridgeRequest('GET', `/api/get-characters?ids=${encodeURIComponent(chunk.join(','))}`));
        const chars = data?.characters || [];
        if (Array.isArray(chars)) out.push(...chars);
    }
    return out;
}

// /api/get-characters is public; with the bridge there is no separate anonymous path.
export const fetchJannyPublicCharactersByIds = fetchJannyCharactersByIds;

export async function fetchJannyCollections() {
    const data = parseJsonBody(await jannyBridgeRequest('GET', '/api/collections/mine'));
    return data?.collections || [];
}

export async function fetchJannyCollectionCharacters(collectionId) {
    if (!collectionId) return [];
    const data = parseJsonBody(await jannyBridgeRequest('GET', `/api/collections/${collectionId}/characters`));
    return data?.characters || [];
}

export async function addJannyCharacterToCollection(collectionId, characterId) {
    const res = await jannyBridgeRequest('POST', `/api/collections/${collectionId}/characters`, { json: { characterId } });
    return parseJsonBody(res) || {};
}

export async function removeJannyCharacterFromCollection(collectionId, characterId) {
    const res = await jannyBridgeRequest('DELETE', `/api/collections/${collectionId}/characters?characterId=${encodeURIComponent(characterId)}`);
    return parseJsonBody(res) || {};
}

// Collection create/edit/delete are server-rendered Astro form POSTs
// (application/x-www-form-urlencoded). Success answers 302; the userscript manager
// follows the redirect, so the created collection's id is read from finalUrl.
export async function createJannyCollection({ name, description = '', isPrivate = true } = {}) {
    const res = await jannyBridgeRequest('POST', '/collections/form/add-collection', {
        form: { name, description, isPrivate: isPrivate ? 'yes' : 'no' },
    });
    const location = res.finalUrl || '';
    const idMatch = location.match(/\/collections\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
    return { success: true, id: idMatch ? idMatch[1] : null, location };
}

export async function updateJannyCollection({ id, name, description = '', isPrivate = true } = {}) {
    const res = await jannyBridgeRequest('POST', '/collections/form/edit-collection', {
        form: { id, name, description, isPrivate: isPrivate ? 'yes' : 'no' },
    });
    return { success: true, location: res.finalUrl || '' };
}

export async function deleteJannyCollection(id) {
    const res = await jannyBridgeRequest('POST', '/collections/form/delete-collection', { form: { id } });
    return { success: true, location: res.finalUrl || '' };
}

// ========================================
// PUBLIC COLLECTIONS (HTML pages via the bridge, parsed client-side)
// ========================================

export async function fetchJannyPublicCollections({ sort = 'latest', page = 1 } = {}) {
    const params = new URLSearchParams({ sort: String(sort), page: String(page) });
    const res = await jannyBridgeRequest('GET', `/collections?${params}`);
    return { ok: true, status: res.status, ...parseJannyPublicCollectionsPage(res.body) };
}

export async function fetchJannyCollectorCollections(name) {
    const validation = validateJannyCollectorName(name);
    if (!validation.ok) throw new Error(validation.error);
    const res = await jannyBridgeRequest('GET', `/collectors/${encodeURIComponent(validation.name)}`);
    return { ok: true, status: res.status, ...parseJannyPublicCollectionsPage(res.body) };
}

export async function fetchJannyPublicCollection(path) {
    const validation = validateJannyPublicCollectionPath(path);
    if (!validation.ok) throw new Error(validation.error);
    const res = await jannyBridgeRequest('GET', validation.path);
    return { ok: true, status: res.status, ...parseJannyPublicCollectionDetailPage(res.body, validation.path) };
}
```

This deletes: `setJannyApiRequest`, `helperRequest`, `helperJsonGet`, `checkJannyPluginAvailable`, `setJannySessionCookie`, `clearJannySession`, `getJannySessionStatus`, `jannyValidatePath`, `validateJannySession`, `accountOptions`, `jannyAccountProxy`, `fetchJannyBookmarkPage`, and every `options`/FlareSolverr parameter.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/janny-api-account.test.mjs`
Expected: PASS (7 tests). `node --test tests/janny-bridge.test.mjs tests/janny-html.test.mjs` — still PASS.

- [ ] **Step 5: Commit and push**

```bash
git add modules/providers/janny/janny-api.js tests/janny-api-account.test.mjs
git commit -m "feat: route JannyAI account + public collections through the userscript bridge"
git push origin codex/jannyai-account-sync
```

---

### Task 5: Rewire `janny-browse.js` and `janny-provider.js`

**Files:**
- Modify: `modules/providers/janny/janny-browse.js` (imports at 6–35; status block at ~99, ~1458–1560; every `jannyAccountOptions()` call site; the cloudflare copy at ~1463)
- Modify: `modules/providers/janny/janny-provider.js` (imports; `init` at ~424)

**Interfaces:**
- Consumes: `probeJannyAccount` and the no-options API functions (Task 4); `initJannyBridge` (Task 2).
- Produces: `jannyAccountStatus` module state shaped `{ bridge, active, cloudflare, reason }` (internal to janny-browse).

- [ ] **Step 1: Update imports**

In `janny-browse.js` (lines 6–35): remove `checkJannyPluginAvailable`, `getJannySessionStatus`, `setJannySessionCookie`, `validateJannySession` from the janny-api import; add `probeJannyAccount`.

In `janny-provider.js`: remove `setJannyApiRequest` from the janny-api import and delete the `setJannyApiRequest(coreAPI.apiRequest);` line in `init` (~line 427). Add `import { initJannyBridge } from './janny-bridge.js';` and call `initJannyBridge();` in `init` (mirroring `datacat-provider.js:91`).

- [ ] **Step 2: Replace the status/gating block**

In `janny-browse.js`, replace the module state at ~line 99 with:

```js
let jannyAccountStatus = { bridge: false, active: false, cloudflare: false, reason: '' };
```

Delete `restoreJannySessionFromSettings` entirely (function ~1495–1509 and any call sites — grep `restoreJannySessionFromSettings`). Delete `jannyAccountOptions` (function at ~1458). Replace `refreshJannyAccountStatus` and `ensureJannyAccountReady` (~1514–1556) with:

```js
// Tracks account readiness for gating (ensureJannyAccountReady) only. Login state is
// shown in Settings, matching every other provider.
async function refreshJannyAccountStatus() {
    jannyAccountStatus = await probeJannyAccount();
    return jannyAccountStatus;
}

async function ensureJannyAccountReady() {
    if (!jannyAccountStatus.bridge || !jannyAccountStatus.active) {
        await refreshJannyAccountStatus();
    }
    if (!jannyAccountStatus.bridge) {
        showToast('Install the JannyAI bridge userscript (extras/cl-janny-bridge.user.js) to use account sync', 'warning', 6000);
        return false;
    }
    if (!jannyAccountStatus.active) {
        showToast('Log into jannyai.com in this browser, then try again', 'warning', 5000);
        return false;
    }
    return true;
}
```

- [ ] **Step 3: Fix every call site**

Grep `jannyAccountOptions()` (10 sites: ~513, 1524, 1560, 1595, 1607, 1672, 1681, 1949, 2011) — remove the argument, e.g. `fetchJannyBookmarks(jannyAccountOptions())` → `fetchJannyBookmarks()`. Grep `validate: false` / `{ validate:` calls to `refreshJannyAccountStatus` and drop the argument. Grep `\.plugin` on `jannyAccountStatus` and change to `.bridge`. Update the cloudflare copy at ~1463:

```js
if (err?.cloudflare) {
    return 'Cloudflare challenged the request. Reload jannyai.com in this browser to clear the challenge, then try again.';
}
```

Grep the whole file for `cookie`/`Cookie`/`cl-helper` in janny contexts and update any remaining user-facing strings to the bridge story.

- [ ] **Step 4: Verify nothing dangling**

Run: `node --test tests/` — all suites PASS.
Run: `grep -n "jannyAccountOptions\|setJannySessionCookie\|getJannySessionStatus\|validateJannySession\|checkJannyPluginAvailable\|restoreJannySessionFromSettings\|fetchJannyBookmarkPage" modules/providers/janny/*.js` — no matches.

- [ ] **Step 5: Commit and push**

```bash
git add modules/providers/janny/janny-browse.js modules/providers/janny/janny-provider.js
git commit -m "feat: janny browse/provider ride the bridge; drop cookie session gating"
git push origin codex/jannyai-account-sync
```

---

### Task 6: cl-helper cleanup (revert the relay)

**Files:**
- Restore to main: `extras/cl-helper/index.js`, `extras/cl-helper/package.json`
- Delete: `extras/cl-helper/janny-account.js`, `tests/janny-account.test.mjs`, `extras/android-webview-bridge/`

- [ ] **Step 1: Confirm the branch's cl-helper delta is all janny-relay**

Run: `git diff main...HEAD --stat -- extras/cl-helper/` and skim `git diff main...HEAD -- extras/cl-helper/index.js`. Every hunk must be janny-account related (imports from janny-account.js, `jannySession*` state, family agents, `/janny-*` routes, `_SELF_UPDATE_FILES` entry). If any non-janny change exists, keep it and remove only the janny hunks by hand instead of the checkout below.

- [ ] **Step 2: Restore and delete**

```bash
git checkout main -- extras/cl-helper/index.js extras/cl-helper/package.json
git rm extras/cl-helper/janny-account.js
git rm tests/janny-account.test.mjs
git rm -r extras/android-webview-bridge
```

- [ ] **Step 3: Verify**

Run: `node --test tests/` — PASS (janny-account.test.mjs is gone; janny-html/bridge/api suites cover the surviving logic).
Run: `grep -rn "janny" extras/cl-helper/ | grep -iv "janitor"` — only hits that also exist on main (verify with `git grep -n "janny" main -- extras/cl-helper/`).
Run: `node --check extras/cl-helper/index.js` — syntax OK.

- [ ] **Step 4: Commit and push**

```bash
git add -A extras/cl-helper extras/android-webview-bridge tests
git commit -m "revert: drop cl-helper janny cookie relay and Android WebView bridge"
git push origin codex/jannyai-account-sync
```

---

### Task 7: Settings UI (zero-paste, DataCat-style layout)

**Files:**
- Modify: `app/library.html` (~2510–2550, the group containing `jannySettingsCookieInput`)
- Modify: `app/library.js` (settings state `jannyCookie` default at ~541; handlers ~1664–1670 and ~2238–2360)
- Modify: `app/library-mobile.css`, `modules/providers/browse-shared.css` (cookie-UI-only rules)
- Test: `tests/janny-settings-account.test.mjs` (rewrite)

**Interfaces:**
- Consumes: `window.clJannyBridge = { isAvailable(), request(method, url, opts) }` (Task 2).
- Produces: element ids `jannySettingsBridgeStatus`, `jannySettingsAccountStatus`, `jannySettingsRefreshBtn`; keeps `jannySettingsAccountHint`, `jannySettingsOpenJannyLink`.

- [ ] **Step 1: Rewrite the failing settings test**

Replace the whole of `tests/janny-settings-account.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../app/library.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../app/library.js', import.meta.url), 'utf8');

test('JannyAI settings are status-only (bridge + account), no paste fields', () => {
    for (const id of [
        'jannySettingsBridgeStatus',
        'jannySettingsAccountStatus',
        'jannySettingsRefreshBtn',
        'jannySettingsAccountHint',
        'jannySettingsOpenJannyLink',
    ]) {
        assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    // The cookie-era controls are gone.
    for (const id of [
        'jannySettingsCookieInput',
        'jannySettingsUserAgentInput',
        'jannySettingsValidateBtn',
        'jannySettingsClearSessionBtn',
    ]) {
        assert.doesNotMatch(html, new RegExp(`id="${id}"`), `stale #${id}`);
    }
    assert.match(html, /cl-janny-bridge\.user\.js/);
});

test('library.js drops the cookie plumbing and refreshes via the bridge', () => {
    assert.ok(js.includes('function refreshJannySettingsAccountStatus'), 'missing status refresh');
    assert.ok(js.includes('window.clJannyBridge'), 'must read the bridge handle');
    for (const stale of [
        'mergeJannyClearanceIntoCookie',
        'saveJannySettingsAccountCookie',
        'janny-set-cookie',
        'janny-clear-session',
        'janny-session',
        "getSetting('jannyCookie')",
        "setSetting('jannyCookie'",
    ]) {
        assert.ok(!js.includes(stale), `stale reference: ${stale}`);
    }
});
```

Run: `node --test tests/janny-settings-account.test.mjs` — Expected: FAIL (old markup still present).

- [ ] **Step 2: Replace the settings group in `library.html`**

Locate the settings-group containing `jannySettingsCookieInput` (inside the JannyAI provider `<details>` — it must stay nested there) and replace the whole group with (match surrounding class conventions — compare with the DataCat "JanitorAI Login" group at ~2714 for row/hint classes):

```html
<div class="settings-group">
    <div class="settings-group-title"><i class="fa-solid fa-user-lock"></i> JannyAI Account Sync</div>
    <div class="settings-row">
        <span class="settings-hint">Bookmarks and collections ride a companion userscript (<code>extras/cl-janny-bridge.user.js</code>, installed in Tampermonkey or Violentmonkey): it makes JannyAI requests from your own browser, so Cloudflare and login are handled by the browser itself. Works on desktop and on Firefox for Android + Tampermonkey. Nothing to paste — just be logged into jannyai.com in this same browser.</span>
    </div>
    <div class="settings-row">
        <label>Bridge:</label>
        <span id="jannySettingsBridgeStatus" class="settings-hint">Checking&hellip;</span>
    </div>
    <div class="settings-row">
        <label>Account:</label>
        <span id="jannySettingsAccountStatus" class="settings-hint">Unknown</span>
    </div>
    <div class="settings-row" style="gap: 8px;">
        <button id="jannySettingsRefreshBtn" class="settings-action-btn">
            <i class="fa-solid fa-arrows-rotate"></i> Refresh
        </button>
        <a id="jannySettingsOpenJannyLink" class="settings-hint" href="https://jannyai.com/collections" target="_blank" rel="noopener noreferrer">Open JannyAI in a new tab</a>
    </div>
    <div class="settings-row">
        <span id="jannySettingsAccountHint" class="settings-hint"></span>
    </div>
</div>
```

Also update the JannyAI entry in Help & Tips (search the info-sections for the JannyAI block) to describe the bridge instead of cookie capture, mirroring the tone of the Hampter access paragraph at ~1554.

- [ ] **Step 3: Replace the plumbing in `library.js`**

Delete: the `jannyCookie: null` settings default (~541) and any `jannyUserAgent` default; the element lookups for the removed ids (~1664–1670); `readJannySettingsAccountJson`, `parseJannySettingsAccountResponse`, `mergeJannyClearanceIntoCookie`, `saveJannySettingsAccountCookie`, the validate/clear handlers, and the restore-on-load block (~2238–2360). Grep `jannyCookie`, `jannySettingsCookieInput`, `janny-set-cookie`, `janny-clear-session`, `janny-session` — zero matches afterward.

Add in the same settings-wiring area:

```js
async function refreshJannySettingsAccountStatus() {
    const bridgeEl = document.getElementById('jannySettingsBridgeStatus');
    const accountEl = document.getElementById('jannySettingsAccountStatus');
    const hintEl = document.getElementById('jannySettingsAccountHint');
    if (!bridgeEl || !accountEl) return;

    const bridge = window.clJannyBridge;
    const available = !!bridge?.isAvailable?.();
    bridgeEl.textContent = available ? 'Userscript detected' : 'Not detected';
    if (!available) {
        accountEl.textContent = 'Unavailable';
        if (hintEl) hintEl.textContent = 'Install extras/cl-janny-bridge.user.js in Tampermonkey or Violentmonkey, then reload this page.';
        return;
    }

    accountEl.textContent = 'Checking…';
    try {
        const res = await bridge.request('GET', 'https://jannyai.com/api/bookmark');
        if (res.ok) {
            accountEl.textContent = 'Logged in';
            if (hintEl) hintEl.textContent = '';
        } else if (res.status === 401 || res.status === 403) {
            accountEl.textContent = 'Not logged in';
            if (hintEl) hintEl.textContent = 'Log into jannyai.com in this same browser, then hit Refresh.';
        } else {
            accountEl.textContent = `Error (HTTP ${res.status})`;
            if (hintEl) hintEl.textContent = '';
        }
    } catch (err) {
        accountEl.textContent = 'Error';
        if (hintEl) hintEl.textContent = err.message;
    }
}
```

Wire it where the old handlers were wired: `document.getElementById('jannySettingsRefreshBtn')?.addEventListener('click', refreshJannySettingsAccountStatus);` and call `refreshJannySettingsAccountStatus()` from the same hook that previously ran the restore-on-load block (settings open / provider section init).

- [ ] **Step 4: CSS cleanup**

Grep `janny` in `app/library-mobile.css` and `modules/providers/browse-shared.css`; delete rules that target only the removed cookie controls (`jannySettingsCookieInput`, `jannySettingsUserAgentInput`, etc.). Leave collections-UX rules alone. If any new status element gets toggled with `.hidden` under browse-shared.css scope, add the explicit `.X.hidden { display: none; }` re-hide rule.

- [ ] **Step 5: Run tests, commit, push**

Run: `node --test tests/` — all PASS (including the rewritten settings test and `janny-collections-ux-static.test.mjs`).

```bash
git add app/library.html app/library.js app/library-mobile.css modules/providers/browse-shared.css tests/janny-settings-account.test.mjs
git commit -m "feat: zero-paste JannyAI settings (bridge + account status, DataCat-style)"
git push origin codex/jannyai-account-sync
```

---

### Task 8: Docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**

Run `git diff main...HEAD -- README.md` to see the branch's 19 added lines. Replace the cookie-capture instructions with the bridge story: install `extras/cl-janny-bridge.user.js` in Tampermonkey/Violentmonkey (desktop or Firefox for Android), be logged into jannyai.com in the same browser, done — bookmarks and collections sync with nothing to paste; cl-helper is NOT required for JannyAI account sync. Keep the entry consistent with the README's existing per-provider format.

- [ ] **Step 2: Commit and push**

```bash
git add README.md
git commit -m "docs: JannyAI account sync via userscript bridge"
git push origin codex/jannyai-account-sync
```

---

### Task 9: Full verification (automated + live)

- [ ] **Step 1: Full test suite**

Run: `node --test tests/`
Expected: all tests pass, zero failures.

- [ ] **Step 2: Dangling-reference sweep**

Run each; expected zero matches (excluding docs/superpowers history):
```bash
grep -rn "janny-account" --include="*.js" --include="*.mjs" app modules extras tests
grep -rn "jannyCookie\|janny-set-cookie\|janny-clear-session\|janny-proxy\|janny-validate\|janny-public-coll\|janny-public-char\|janny-collector" --include="*.js" --include="*.html" app modules extras
grep -rn "flareSolverr\|flareUrl\|FlareSolverr" --include="*.js" modules/providers/janny
```

- [ ] **Step 3: Syntax check the page entry points**

```bash
node --check app/library.js
node --check modules/providers/janny/janny-api.js
node --check modules/providers/janny/janny-browse.js
```
(`--check` on ES modules: if it complains about import syntax, use `node --input-type=module --check < file` or skip — the test imports already cover the modules.)

- [ ] **Step 4: Live verification (user-assisted — cannot be fully automated)**

This exercises real JannyAI endpoints; per project rule, account features are never shipped on code reading alone. Ask the user to:
1. Pull the branch on their ST (127.0.0.1:8001), hard-refresh CL.
2. Install `extras/cl-janny-bridge.user.js` in Tampermonkey (PC first, then Firefox Android).
3. Settings → Online → JannyAI: Bridge shows "Userscript detected"; Account shows "Logged in" (while logged into jannyai.com in that browser) — and "Not logged in" from a logged-out browser profile.
4. Browse JannyAI: bookmark add/remove; collections list; create a test collection; add/remove a character in it; delete it. Confirm each is visible on jannyai.com.
5. Repeat step 3–4 on mobile (Firefox Android + Tampermonkey).

Record outcomes; fix anything that fails before calling the branch done. Watch specifically for:
- whether `GET /api/bookmark` is the right login probe (401 vs 200) — swap the probe endpoint if it behaves differently live;
- whether form-POST success lands as followed-redirect 200 with a usable `finalUrl` in both Tampermonkey and Violentmonkey;
- whether `/api/get-characters` enforces a stricter ids cap than 20.

- [ ] **Step 5: Final commit (if fixes were needed) and push**

```bash
git add -A
git commit -m "fix: live-verification adjustments for the JannyAI bridge"
git push origin codex/jannyai-account-sync
```
