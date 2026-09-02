# JannyAI Real-Browser Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace JannyAI's broken userscript transports with a real-browser Cloudflare/session transport and direct hydrated-page definition extraction while preserving direct MeiliSearch browsing and all bookmark/collection features.

**Architecture:** JannyAI receives provider-specific browser client/helper routes and a dedicated session module, but reuses the existing JanitorAI managed/external browser process, profile, endpoint configuration, and low-level CDP primitives. `search.jannyai.com` stays direct; only `jannyai.com` pages and account operations use the browser. JanitorAI's route contracts and settings UI remain unchanged.

**Tech Stack:** Browser ES modules, Node.js 22.15+ ESM, SillyTavern `cl-helper`, Chrome DevTools Protocol, JannyAI's server-rendered Astro pages, Node's built-in `node:test`, HTML/CSS settings UI.

**Spec:** `docs/superpowers/specs/2026-09-01-jannyai-browser-transport-design.md`

## Global Constraints

- Set the bundled `cl-helper` version and JannyAI minimum helper version to `1.13.0`.
- Do not change existing `/janitorai-*` route names, request/response shapes, settings IDs, or provider behavior.
- Keep `search.jannyai.com` MeiliSearch requests browser-independent and anonymously usable.
- Use the existing `janitoraiBrowserMode` and `janitoraiBrowserEndpoint` settings as the single shared browser configuration.
- Give JannyAI separate warm-page state, helper routes, request policy, account-session cookies, UI IDs, diagnostics, and tests.
- Accept a complete `sb-eenzcbluoctduymzksoq-auth-token.0`/`.1` session first and a bare JWT only as a non-renewable fallback.
- Treat pasted credentials as one-time browser installation input; persist neither the raw cookie header nor parsed access/refresh tokens in Character Library settings.
- Never place account tokens in URLs, helper responses, logs, fixtures, screenshots, committed files, or command output.
- Preserve Cloudflare cookies on Janny logout while clearing Janny account cookies and any inert legacy token settings.
- Never import a listing-only or empty-definition card after a 403, challenge, malformed page, or parser failure.
- Remove every active Janny dependency and user-facing instruction for `cl-janny-bridge.user.js` and `cl-janitor-bridge.user.js`; retain the latter for DataCat.
- Live account mutations must be reversible, inspect original state first, and restore it in cleanup.
- Use `apply_patch` for source edits and run the focused failing test before each implementation step.

## File and responsibility map

| File | Responsibility after this plan |
|---|---|
| `extras/cl-helper/janny-browser-policy.js` | Pure Janny origin/path/method/query/body validation plus auth-cookie construction/deletion selection; no CDP or Express state |
| `extras/cl-helper/index.js` | Shared managed browser lifecycle plus isolated Janny warm page, CDP fetch/session/logout/test routes |
| `extras/cl-helper/package.json` | Bundled helper version `1.13.0` |
| `modules/providers/janny/janny-auth.js` | Pure cookie/session parsing and JWT claim decoding |
| `modules/providers/janny/janny-session.js` | One-time session installation, redacted browser status, recovery coordination, and logout |
| `modules/providers/janny/janny-browser.js` | Browser configuration and typed client wrappers for Janny helper routes |
| `modules/providers/janny/janny-api.js` | Bookmarks, collections, and public-page APIs through the browser client |
| `modules/providers/janny/janny-html.js` | Public collection and collector-page parsers |
| `modules/providers/janny/janny-provider.js` | Provider lifecycle and fail-closed character definition flow |
| `modules/providers/janny/janny-browse.js` | Account readiness, cache invalidation, collection/bookmark UX, and precise errors |
| `app/library.html` | Separate Janny browser/account settings and updated Help & Tips |
| `app/library.js` | Janny browser controls, account status/actions, shared config binding, helper updater bundle |
| `app/library.css` | Desktop status-row layout for both provider-local browser sections |
| `app/library-mobile.css` | Mobile status-row layout for both provider-local browser sections |
| `README.md` | Current Janny setup and corrected DataCat/userscript scope |
| `tests/janny-browser-policy.test.mjs` | Pure allowlist security matrix |
| `tests/janny-browser-helper-static.test.mjs` | Helper route/warm-page/version/log-redaction regression checks |
| `tests/janny-browser-client.test.mjs` | Client request shaping, config reuse, timeout and error classification |
| `tests/janny-session.test.mjs` | Parsing, browser installation, non-persistence, recovery serialization, redacted status, logout |
| `tests/janny-api-account.test.mjs` | Account/public API behavior over the browser client |
| `tests/janny-html.test.mjs` | Public collection and collector-page parsing |
| `tests/janny-definition-browser.test.mjs` | Single hydrated-page provider path and empty-import refusal |
| `tests/janny-settings-account.test.mjs` | Browser/account settings structure and copy |
| `tests/janny-no-userscript-regression.test.mjs` | No active Janny userscript source, imports, copy, or docs |

---

### Task 1: Pure Janny browser request policy

**Files:**
- Create: `extras/cl-helper/janny-browser-policy.js`
- Create: `tests/janny-browser-policy.test.mjs`

**Interfaces:**
- Consumes: Standard `URL`, plain request objects.
- Produces: `JANNY_ORIGIN`, `JANNY_AUTH_COOKIE`, `JANNY_CF_COOKIE_NAMES`, `buildJannySessionCookies(accessToken, refreshToken, nowSeconds)`, `jannyAccountCookiesToDelete(cookies)`, `validateJannyFinalUrl(finalUrl, formPost)`, and `validateJannyBrowserRequest(input)` returning `{ method, safePath, contentType, body, inspectCharacterId }` or throwing an error with `code = 'JANNY_REQUEST_BLOCKED'`.

- [ ] **Step 1: Write the failing policy tests**

```js
// tests/janny-browser-policy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildJannySessionCookies,
    jannyAccountCookiesToDelete,
    validateJannyFinalUrl,
    validateJannyBrowserRequest,
} from '../extras/cl-helper/janny-browser-policy.js';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';

test('allows the exact public and account request surface', () => {
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: `/characters/${A}_demo` }).safePath, `/characters/${A}_demo`);
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: '/collections?page=2&sort=latest' }).safePath, '/collections?page=2&sort=latest');
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: '/collections?q=robots&page=1&sort=popular' }).method, 'GET');
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: `/collectors/demo-user` }).safePath, '/collectors/demo-user');
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: `/collections/${A}_set` }).safePath, `/collections/${A}_set`);
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: '/api/bookmark' }).method, 'GET');
    assert.equal(validateJannyBrowserRequest({ method: 'POST', path: '/api/bookmark', jsonBody: { characterIDs: [A, B] } }).contentType, 'application/json');
    assert.equal(validateJannyBrowserRequest({ method: 'DELETE', path: `/api/bookmark?ids=${A},${B}` }).method, 'DELETE');
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: `/api/get-characters?ids=${A},${B}` }).method, 'GET');
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: '/api/collections/mine' }).method, 'GET');
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: `/api/collections/${A}/characters` }).method, 'GET');
    assert.equal(validateJannyBrowserRequest({ method: 'POST', path: `/api/collections/${A}/characters`, jsonBody: { characterId: B } }).method, 'POST');
    assert.equal(validateJannyBrowserRequest({ method: 'DELETE', path: `/api/collections/${A}/characters?characterId=${B}` }).method, 'DELETE');
    assert.equal(validateJannyBrowserRequest({ method: 'POST', path: '/collections/form/add-collection', formBody: { name: 'Set', description: '', isPrivate: 'yes' } }).contentType, 'application/x-www-form-urlencoded');
    assert.equal(validateJannyBrowserRequest({ method: 'POST', path: '/collections/form/edit-collection', formBody: { id: A, name: 'Set', description: 'Updated', isPrivate: 'no' } }).method, 'POST');
    assert.equal(validateJannyBrowserRequest({ method: 'POST', path: '/collections/form/delete-collection', formBody: { id: A } }).method, 'POST');
});

test('rejects origin escape, traversal, extra query keys, invalid UUIDs and body shapes', () => {
    const blocked = [
        { method: 'GET', path: 'https://evil.example/api/bookmark' },
        { method: 'GET', path: 'https://jannyai.com:444/api/bookmark' },
        { method: 'GET', path: '/api/bookmark/../admin' },
        { method: 'GET', path: '/api/bookmark/%2e%2e/admin' },
        { method: 'GET', path: '/collections?page=1&token=secret' },
        { method: 'DELETE', path: '/api/bookmark?ids=not-a-uuid' },
        { method: 'POST', path: '/api/bookmark', jsonBody: { characterIDs: ['not-a-uuid'] } },
        { method: 'PATCH', path: '/api/bookmark' },
        { method: 'POST', path: '/collections/form/add-collection', formBody: { name: 'x'.repeat(5000) } },
    ];
    for (const input of blocked) {
        assert.throws(() => validateJannyBrowserRequest(input), error => error.code === 'JANNY_REQUEST_BLOCKED');
    }
});

test('allows hydrated inspection only when the id matches the character path', () => {
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: `/characters/${A}_demo`, inspectCharacterId: A }).inspectCharacterId, A);
    assert.throws(
        () => validateJannyBrowserRequest({ method: 'GET', path: `/characters/${A}_demo`, inspectCharacterId: B }),
        error => error.code === 'JANNY_REQUEST_BLOCKED',
    );
});

test('rejects cross-origin redirects and constrains form success locations', () => {
    assert.equal(validateJannyFinalUrl('https://jannyai.com/characters', false), 'https://jannyai.com/characters');
    assert.equal(validateJannyFinalUrl(`https://jannyai.com/collections/${A}_set`, true), `https://jannyai.com/collections/${A}_set`);
    assert.throws(() => validateJannyFinalUrl('https://evil.example/collections', false), error => error.code === 'JANNY_REQUEST_BLOCKED');
    assert.throws(() => validateJannyFinalUrl('https://jannyai.com/admin', true), error => error.code === 'JANNY_REQUEST_BLOCKED');
});

test('builds Supabase chunks and selects only account cookies for logout', () => {
    const accessToken = `x.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url')}.y`;
    const cookies = buildJannySessionCookies(accessToken, 'r'.repeat(7000), 1_900_000_000);
    assert.deepEqual(cookies.map(cookie => cookie.name), [
        'sb-eenzcbluoctduymzksoq-auth-token.0',
        'sb-eenzcbluoctduymzksoq-auth-token.1',
        'sb-eenzcbluoctduymzksoq-auth-token.2',
    ]);
    assert.ok(cookies.every(cookie => cookie.expires === 2_000_000_000));
    assert.deepEqual(jannyAccountCookiesToDelete([
        { name: 'cf_clearance' },
        { name: '__cf_bm' },
        { name: 'sb-eenzcbluoctduymzksoq-auth-token.0' },
        { name: 'unrelated' },
    ]), ['sb-eenzcbluoctduymzksoq-auth-token.0']);
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `node --test tests/janny-browser-policy.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `janny-browser-policy.js`.

- [ ] **Step 3: Implement the pure policy module**

```js
// extras/cl-helper/janny-browser-policy.js
export const JANNY_ORIGIN = 'https://jannyai.com';
export const JANNY_AUTH_COOKIE = 'sb-eenzcbluoctduymzksoq-auth-token';
export const JANNY_CF_COOKIE_NAMES = new Set(['cf_clearance', '__cf_bm']);
export const JANNY_COOKIE_CHUNK_LIMIT = 3180;

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID_SOURCE}$`, 'i');
const CHARACTER_RE = new RegExp(`^/characters/(${UUID_SOURCE})(?:_[^/?#]{1,256})?$`, 'i');
const COLLECTION_RE = new RegExp(`^/collections/(${UUID_SOURCE})(?:_[^/?#]{1,256})?$`, 'i');
const MEMBERS_RE = new RegExp(`^/api/collections/(${UUID_SOURCE})/characters$`, 'i');
const BODY_LIMIT = 16 * 1024;

function blocked(message) {
    const error = new Error(message);
    error.code = 'JANNY_REQUEST_BLOCKED';
    throw error;
}

function uuidCsv(value) {
    const ids = String(value || '').split(',').filter(Boolean);
    return ids.length > 0 && ids.length <= 100 && ids.every(id => UUID_RE.test(id));
}

function noQuery(url) {
    return url.searchParams.size === 0;
}

function exactQuery(url, keys) {
    const actual = [...url.searchParams.keys()];
    return actual.length === keys.length
        && keys.every(key => url.searchParams.getAll(key).length === 1);
}

function plainRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}

function exactBodyKeys(value, keys) {
    return plainRecord(value)
        && Object.keys(value).length === keys.length
        && keys.every(key => Object.hasOwn(value, key));
}

function encodedBody(contentType, value) {
    if (value.length > BODY_LIMIT) blocked('JannyAI request body is too large');
    return { contentType, body: value };
}

function validatedCollectionForm(path, formBody) {
    if (path === '/collections/form/delete-collection') {
        if (!exactBodyKeys(formBody, ['id']) || !UUID_RE.test(String(formBody.id))) {
            blocked('Invalid collection delete form');
        }
    } else {
        const keys = path.endsWith('/edit-collection')
            ? ['id', 'name', 'description', 'isPrivate']
            : ['name', 'description', 'isPrivate'];
        if (!exactBodyKeys(formBody, keys)) blocked('Invalid collection form fields');
        if (keys.includes('id') && !UUID_RE.test(String(formBody.id))) blocked('Invalid collection id');
        const name = String(formBody.name);
        const description = String(formBody.description);
        if (name.length < 1 || name.length > 160) blocked('Invalid collection name');
        if (description.length > 4000) blocked('Invalid collection description');
        if (!['yes', 'no'].includes(formBody.isPrivate)) blocked('Invalid collection visibility');
    }
    return encodedBody('application/x-www-form-urlencoded', new URLSearchParams(formBody).toString());
}

export function buildJannySessionCookies(accessToken, refreshToken = '', nowSeconds = Math.floor(Date.now() / 1000)) {
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 16_384
        || typeof refreshToken !== 'string' || refreshToken.length > 16_384) blocked('Invalid JannyAI session');
    let expiresAt = nowSeconds + 3600;
    try {
        const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
        if (Number.isInteger(claims.exp) && claims.exp > nowSeconds) expiresAt = claims.exp;
    } catch { /* use the bounded fallback expiry */ }
    const session = {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: Math.max(60, expiresAt - nowSeconds),
        expires_at: expiresAt,
        refresh_token: refreshToken,
        user: {},
    };
    const value = `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64')}`;
    const values = value.length <= JANNY_COOKIE_CHUNK_LIMIT
        ? [value]
        : Array.from({ length: Math.ceil(value.length / JANNY_COOKIE_CHUNK_LIMIT) }, (_, index) =>
            value.slice(index * JANNY_COOKIE_CHUNK_LIMIT, (index + 1) * JANNY_COOKIE_CHUNK_LIMIT));
    return values.map((chunk, index) => ({
        name: values.length === 1 ? JANNY_AUTH_COOKIE : `${JANNY_AUTH_COOKIE}.${index}`,
        value: chunk,
        expires: expiresAt,
    }));
}

export function jannyAccountCookiesToDelete(cookies) {
    return [...new Set((cookies || [])
        .map(cookie => String(cookie?.name || ''))
        .filter(name => name === JANNY_AUTH_COOKIE || name.startsWith(`${JANNY_AUTH_COOKIE}.`))
        .filter(name => !JANNY_CF_COOKIE_NAMES.has(name)))];
}

export function validateJannyFinalUrl(finalUrl, formPost = false) {
    let parsed;
    try { parsed = new URL(String(finalUrl || ''), JANNY_ORIGIN); }
    catch { blocked('Malformed JannyAI final URL'); }
    if (parsed.origin !== JANNY_ORIGIN) blocked('Cross-origin JannyAI redirect rejected');
    let decodedPath;
    try { decodedPath = decodeURIComponent(parsed.pathname); }
    catch { blocked('Malformed JannyAI final pathname'); }
    if (formPost && !(decodedPath === '/collections' || COLLECTION_RE.test(decodedPath))) {
        blocked('Unexpected JannyAI collection redirect');
    }
    return parsed.href;
}

export function validateJannyBrowserRequest(input = {}) {
    const method = String(input.method || 'GET').toUpperCase();
    const raw = String(input.path || '');
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.length > 2048 || /[\0\r\n\\#]/.test(raw)) {
        blocked('Origin-relative JannyAI path required');
    }
    let decodedRawPath;
    try { decodedRawPath = decodeURIComponent(raw.split('?')[0]); }
    catch { blocked('Malformed JannyAI path encoding'); }
    if (decodedRawPath.split('/').some(segment => segment === '.' || segment === '..')) {
        blocked('Path traversal rejected');
    }
    let url;
    try { url = new URL(raw, JANNY_ORIGIN); }
    catch { blocked('Malformed JannyAI path'); }
    if (url.origin !== JANNY_ORIGIN) blocked('JannyAI origin required');
    let decodedPath;
    try { decodedPath = decodeURIComponent(url.pathname); }
    catch { blocked('Malformed JannyAI pathname'); }

    const hasJsonBody = input.jsonBody !== undefined;
    const hasFormBody = input.formBody !== undefined;
    if (hasJsonBody && hasFormBody) blocked('Only one JannyAI body type is allowed');
    const inspectCharacterId = String(input.inspectCharacterId || '');
    const finish = (payload = null) => {
        if (!payload && (hasJsonBody || hasFormBody)) blocked('This JannyAI route does not accept a body');
        return {
            method,
            safePath: url.pathname + url.search,
            contentType: payload?.contentType || '',
            body: payload?.body || '',
            inspectCharacterId,
        };
    };
    const character = decodedPath.match(CHARACTER_RE);
    if (character && method === 'GET' && noQuery(url)) {
        if (inspectCharacterId && (!UUID_RE.test(inspectCharacterId) || inspectCharacterId.toLowerCase() !== character[1].toLowerCase())) {
            blocked('Character inspection id must match the path');
        }
        return finish();
    }
    if (inspectCharacterId) blocked('Hydrated inspection is limited to character pages');

    if (decodedPath === '/collections' && method === 'GET') {
        const keys = [...url.searchParams.keys()];
        if (keys.some(key => !['sort', 'page', 'q'].includes(key)) || keys.some(key => url.searchParams.getAll(key).length !== 1)) {
            blocked('Invalid public collection query');
        }
        if (url.searchParams.has('sort') && !['latest', 'popular'].includes(url.searchParams.get('sort'))) blocked('Invalid collection sort');
        if (url.searchParams.has('page') && !/^[1-9][0-9]{0,3}$/.test(url.searchParams.get('page'))) blocked('Invalid collection page');
        if (url.searchParams.has('q') && url.searchParams.get('q').length > 256) blocked('Invalid collection search');
        return finish();
    }
    if (method === 'GET' && noQuery(url) && /^\/collectors\/[^/]{1,384}$/u.test(decodedPath)) {
        const name = decodedPath.slice('/collectors/'.length);
        if (name.length > 128 || /[\0-\x1f\\]/.test(name)) blocked('Invalid collector name');
        return finish();
    }
    if (COLLECTION_RE.test(decodedPath) && method === 'GET' && noQuery(url)) return finish();

    if (decodedPath === '/api/bookmark' && method === 'GET' && noQuery(url)) return finish();
    if (decodedPath === '/api/bookmark' && method === 'POST' && noQuery(url)) {
        const value = input.jsonBody;
        if (!exactBodyKeys(value, ['characterIDs']) || !Array.isArray(value.characterIDs)
            || value.characterIDs.length < 1 || value.characterIDs.length > 100
            || !value.characterIDs.every(id => UUID_RE.test(String(id)))) blocked('Invalid bookmark body');
        return finish(encodedBody('application/json', JSON.stringify(value)));
    }
    if (decodedPath === '/api/bookmark' && method === 'DELETE' && exactQuery(url, ['ids']) && uuidCsv(url.searchParams.get('ids'))) return finish();
    if (decodedPath === '/api/get-characters' && method === 'GET' && exactQuery(url, ['ids']) && uuidCsv(url.searchParams.get('ids'))) return finish();
    if (decodedPath === '/api/collections/mine' && method === 'GET' && noQuery(url)) return finish();

    const members = decodedPath.match(MEMBERS_RE);
    if (members && method === 'GET' && noQuery(url)) return finish();
    if (members && method === 'POST' && noQuery(url)) {
        const value = input.jsonBody;
        if (!exactBodyKeys(value, ['characterId']) || !UUID_RE.test(String(value.characterId))) blocked('Invalid collection member body');
        return finish(encodedBody('application/json', JSON.stringify(value)));
    }
    if (members && method === 'DELETE' && exactQuery(url, ['characterId']) && UUID_RE.test(url.searchParams.get('characterId'))) return finish();

    if (method === 'POST' && noQuery(url) && [
        '/collections/form/add-collection',
        '/collections/form/edit-collection',
        '/collections/form/delete-collection',
    ].includes(decodedPath)) return finish(validatedCollectionForm(decodedPath, input.formBody));

    blocked('JannyAI request is not allowlisted');
}
```

- [ ] **Step 4: Run the policy tests**

Run: `node --test tests/janny-browser-policy.test.mjs`

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit the policy**

```bash
git add extras/cl-helper/janny-browser-policy.js tests/janny-browser-policy.test.mjs
git commit -m "feat: validate JannyAI browser requests"
```

---

### Task 2: Janny helper browser routes and isolated warm page

**Files:**
- Modify: `extras/cl-helper/index.js:2039-2578,2590-3038,3812-3814,4407-4418`
- Modify: `extras/cl-helper/package.json:3`
- Modify: `app/library.js:1794-1840`
- Create: `tests/janny-browser-helper-static.test.mjs`

**Interfaces:**
- Consumes: `validateJannyBrowserRequest`, existing `CdpClient`, `CdpPage`, `waitForCloudflare`, `resolveBrowserEndpoint`, `getManagedEndpoint`, and managed-browser state.
- Produces: `/jannyai-managed/start|stop|status`, `/jannyai-browser-test`, `/jannyai-browser-fetch`, `/jannyai-browser-session`, `/jannyai-browser-logout`; helper version `1.13.0`.

- [ ] **Step 1: Write static route/isolation/version tests**

```js
// tests/janny-browser-helper-static.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const helper = readFileSync(new URL('../extras/cl-helper/index.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../extras/cl-helper/package.json', import.meta.url), 'utf8'));
const library = readFileSync(new URL('../app/library.js', import.meta.url), 'utf8');

test('registers isolated Janny routes without renaming Janitor routes', () => {
    for (const route of [
        '/jannyai-managed/start', '/jannyai-managed/stop', '/jannyai-managed/status',
        '/jannyai-browser-test', '/jannyai-browser-fetch',
        '/jannyai-browser-session', '/jannyai-browser-logout',
    ]) assert.ok(helper.includes(route), `missing ${route}`);
    for (const route of [
        '/janitorai-managed/start', '/janitorai-browser-test',
        '/janitorai-browser-fetch', '/janitorai-browser-session',
    ]) assert.ok(helper.includes(route), `Janitor regression: missing ${route}`);
    assert.match(helper, /_jannyWarmPage/);
    assert.match(helper, /closeJannyWarmPage/);
    assert.doesNotMatch(helper, /console\.(?:log|info|warn|error)\([^\n]*(?:req\.body|accessToken|refreshToken|authorization|cookie[^\n]*value)/i);
});

test('bumps and bundles the three-file helper', () => {
    assert.equal(pkg.version, '1.13.0');
    assert.match(helper, /\['package\.json', 'index\.js', 'janny-browser-policy\.js'\]/);
    assert.match(library, /\['package\.json', 'index\.js', 'janny-browser-policy\.js'\]/);
});
```

- [ ] **Step 2: Run the test and verify it fails on missing routes/version**

Run: `node --test tests/janny-browser-helper-static.test.mjs`

Expected: FAIL because the Janny routes are absent and the package is `1.12.0`.

- [ ] **Step 3: Add the helper import, isolated state, session-cookie functions, and route registration**

At the top of `extras/cl-helper/index.js` add:

```js
import {
    JANNY_ORIGIN,
    JANNY_AUTH_COOKIE,
    JANNY_CF_COOKIE_NAMES,
    buildJannySessionCookies,
    jannyAccountCookiesToDelete,
    validateJannyFinalUrl,
    validateJannyBrowserRequest,
} from './janny-browser-policy.js';
```

Near the existing Janitor warm-page code add Janny-only state:

```js
let _jannyWarmPage = null;
let _jannyWarmEndpoint = '';
let _jannyWarmLastUsed = 0;
let _jannyWarmReaper = null;
```

Implementation requirements:

- Define `closeJannyWarmPage()`, `getJannyWarmPage(endpoint)`, `injectJannySession(page, accessToken, refreshToken)`, `extractHydratedJannyCharacter(page, safePath, characterId)`, and `registerJannyaiBrowserRoutes(router)` alongside that state.
- `getJannyWarmPage` connects through the supplied resolved endpoint, creates a separate `CdpPage`, navigates to `JANNY_ORIGIN`, waits through `waitForCloudflare`, and reuses the page only for the same endpoint.
- The Janny warm page gets its own ten-minute idle reaper. It never reads or writes `_warmPage`, `_warmEndpoint`, or Janitor's warm-page reaper.
- `injectJannySession` calls `buildJannySessionCookies`, clears unchunked and `.0` through `.7` values, then installs the returned name/value/expiry records on domain `jannyai.com`, path `/`, `SameSite=Lax`.
- The logout route obtains browser cookies, calls `jannyAccountCookiesToDelete`, deletes precisely those names, and leaves the Cloudflare and unrelated cookies untouched.
- `extractHydratedJannyCharacter` navigates only to the already validated character path, waits for document readiness, reads known Astro island props/DOM state for the requested UUID, and returns `{ character, imageUrl }` or `null`. It must not return cookies, storage, headers, or unrelated responses.
- `registerJannyaiBrowserRoutes` adds thin lifecycle aliases over the existing managed browser, a Janny-specific capability test, fetch, session, and logout routes.
- The fetch route validates through `validateJannyBrowserRequest` before obtaining the warm page. Execute same-origin `fetch(safePath, { credentials: 'include', method, headers, body })`; add Authorization only when `token` is a bounded string. Pass the browser's response URL through `validateJannyFinalUrl`, with `formPost = true` for collection forms. Return `{ ok: true, status, body, finalUrl, hydratedCharacter }` only after that check.
- On transport failure, close only the Janny warm page and return a redacted error.
- The session route accepts only bounded `token` and `refreshToken` strings and returns `{ ok: true }` without echoing either.
- The logout route returns only the cleared account-cookie names.
- The test route reports endpoint, browser, script, rendering, codecs, Cloudflare, clearance, and a usable Janny character-page check. It uses no account token.

Register `registerJannyaiBrowserRoutes(router)` directly after `registerJanitoraiBrowserRoutes(router)`.

- [ ] **Step 4: Add the new helper file to self-update and bump the version**

Change both bundle lists to:

```js
const CL_HELPER_BUNDLE_FILES = ['package.json', 'index.js', 'janny-browser-policy.js'];
```

Use `CL_HELPER_BUNDLE_FILES` in `app/library.js` for preflight fetch/display. Set `_SELF_UPDATE_FILES` in `extras/cl-helper/index.js` to the same three literal names. Set `extras/cl-helper/package.json` version to `1.13.0`.

- [ ] **Step 5: Run focused validation**

Run:

```bash
node --check extras/cl-helper/index.js
node --check extras/cl-helper/janny-browser-policy.js
node --test tests/janny-browser-policy.test.mjs tests/janny-browser-helper-static.test.mjs
```

Expected: syntax checks exit 0; all focused tests PASS.

- [ ] **Step 6: Commit helper transport**

```bash
git add extras/cl-helper/index.js extras/cl-helper/janny-browser-policy.js extras/cl-helper/package.json app/library.js tests/janny-browser-helper-static.test.mjs
git commit -m "feat: add JannyAI real-browser helper routes"
```

---

### Task 3: Typed browser client and shared configuration adapter

**Files:**
- Create: `modules/providers/janny/janny-browser.js`
- Create: `tests/janny-browser-client.test.mjs`

**Interfaces:**
- Consumes: `CoreAPI.getSetting`, `CoreAPI.apiRequest`, `CL_HELPER_PLUGIN_BASE`.
- Produces: `getJannyBrowserMode()`, `getJannyBrowserEndpoint()`, `jannyBrowserTarget(endpoint)`, `testJannyBrowserEndpoint(endpoint)`, `jannyBrowserFetch(path, options)`, `jannyBrowserSetSession(token, refreshToken, endpoint)`, and `jannyBrowserLogout(endpoint)`.

- [ ] **Step 1: Write failing browser-client tests**

```js
// tests/janny-browser-client.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const settings = { janitoraiBrowserMode: 'managed', janitoraiBrowserEndpoint: 'http://browser:9222' };
const calls = [];
globalThis.window = {
    getSetting: key => settings[key],
    apiRequest: async (path, method, body) => {
        calls.push({ path, method, body });
        return { ok: true, status: 200, json: async () => ({ ok: true, status: 200, body: '{}', finalUrl: 'https://jannyai.com/api/bookmark' }) };
    },
};
await import('../modules/core-api.js');
const browser = await import('../modules/providers/janny/janny-browser.js');

test('reuses Janitor browser configuration', () => {
    assert.equal(browser.getJannyBrowserMode(), 'managed');
    assert.equal(browser.getJannyBrowserEndpoint(), 'http://browser:9222');
    assert.deepEqual(browser.jannyBrowserTarget(), { managed: true });
    settings.janitoraiBrowserMode = 'endpoint';
    assert.deepEqual(browser.jannyBrowserTarget(), { endpoint: 'http://browser:9222' });
});

test('shapes an authenticated helper fetch without putting the token in the URL', async () => {
    settings.janitoraiBrowserMode = 'managed';
    await browser.jannyBrowserFetch('/api/bookmark', { token: 'secret-token' });
    const call = calls.at(-1);
    assert.equal(call.path, '/plugins/cl-helper/jannyai-browser-fetch');
    assert.equal(call.method, 'POST');
    assert.equal(call.body.path, '/api/bookmark');
    assert.equal(call.body.token, 'secret-token');
    assert.doesNotMatch(call.path, /secret-token/);
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `node --test tests/janny-browser-client.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `janny-browser.js`.

- [ ] **Step 3: Implement the browser client**

```js
// modules/providers/janny/janny-browser.js
import CoreAPI from '../../core-api.js';
import { CL_HELPER_PLUGIN_BASE } from '../provider-utils.js';

export function getJannyBrowserMode() {
    return CoreAPI.getSetting('janitoraiBrowserMode') || 'managed';
}

export function getJannyBrowserEndpoint() {
    return String(CoreAPI.getSetting('janitoraiBrowserEndpoint') || '').trim();
}

export function jannyBrowserTarget(endpoint = '') {
    if (endpoint) return { endpoint };
    return getJannyBrowserMode() === 'managed'
        ? { managed: true }
        : { endpoint: getJannyBrowserEndpoint() };
}
```

Implement the remaining exports through a private `callHelper(route, body, { timeoutMs, signal })` matching Janitor's timeout/cancellation behavior:

| Export | Helper route | Request body |
|---|---|---|
| `testJannyBrowserEndpoint(endpoint)` | `/plugins/cl-helper/jannyai-browser-test` | `jannyBrowserTarget(endpoint)` |
| `jannyBrowserFetch(path, options)` | `/plugins/cl-helper/jannyai-browser-fetch` | shared target plus `path`, uppercase `method`, `token`, `jsonBody`, `formBody`, and `inspectCharacterId` |
| `jannyBrowserSetSession(token, refreshToken, endpoint)` | `/plugins/cl-helper/jannyai-browser-session` | shared target plus the two bounded token strings |
| `jannyBrowserLogout(endpoint)` | `/plugins/cl-helper/jannyai-browser-logout` | `jannyBrowserTarget(endpoint)` |

`callHelper` must parse helper JSON, preserve `{ status, body, finalUrl, hydratedCharacter }`, and map helper/network failures to stable Janny error codes without including request bodies or tokens in messages. `jannyBrowserFetch` defaults to `GET`, sends no token key when the token is empty, and passes `AbortSignal`/timeout values only to the local helper call.

Use this classification table in one private classifier and assert representative rows in `janny-browser-client.test.mjs`:

| Condition | Code |
|---|---|
| helper missing, health/version failure | `JANNY_HELPER_UNAVAILABLE` |
| endpoint/connect/process failure | `JANNY_BROWSER_UNAVAILABLE` |
| local timeout | `JANNY_BROWSER_TIMEOUT` |
| challenge title/body or helper clearance failure | `JANNY_CF_BLOCKED` |
| 401 after one browser-owned recovery | `JANNY_LOGIN_REQUIRED` |
| browser-reported expiry reached | `JANNY_TOKEN_EXPIRED` |
| HTTP 429 | `JANNY_RATE_LIMITED` |
| valid page with unknown character schema | `JANNY_PAGE_SHAPE_CHANGED` |
| helper policy refusal | `JANNY_REQUEST_BLOCKED` |
| other non-success HTTP response | `JANNY_HTTP_ERROR` |

If the caller's `AbortSignal` fires, rethrow its abort reason or an `AbortError`; do not translate it to a Janny browser code.

Expose these handles for the classic settings script:

```js
export function initJannyBrowserClient() {
    window.jannyTestBrowserEndpoint = testJannyBrowserEndpoint;
    window.jannyBrowserSetSession = jannyBrowserSetSession;
    window.jannyBrowserLogout = jannyBrowserLogout;
}
```

- [ ] **Step 4: Run client tests and syntax check**

Run:

```bash
node --check modules/providers/janny/janny-browser.js
node --test tests/janny-browser-client.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the client**

```bash
git add modules/providers/janny/janny-browser.js tests/janny-browser-client.test.mjs
git commit -m "feat: add JannyAI browser client"
```

---

### Task 4: Browser-owned Janny account session lifecycle

**Files:**
- Modify: `extras/cl-helper/index.js:2640-2710,3225-3270`
- Modify: `extras/cl-helper/janny-browser-policy.js:59-70`
- Modify: `modules/providers/janny/janny-auth.js`
- Modify: `modules/providers/janny/janny-browser.js`
- Create: `modules/providers/janny/janny-session.js`
- Modify: `app/library.js:524-555`
- Modify: `tests/janny-auth.test.mjs`
- Modify: `tests/janny-browser-policy.test.mjs`
- Modify: `tests/janny-browser-client.test.mjs`
- Replace: `tests/janny-provider-session.test.mjs`
- Create: `tests/janny-session.test.mjs`

**Interfaces:**
- Consumes: `parseJannySession`, `decodeJannyClaims`, `jannyBrowserSetSession`, `jannyBrowserLogout`, and the persistent Janny browser profile from Tasks 2-3.
- Produces: `jannyBrowserSessionStatus(endpoint)`, `jannyBrowserRefreshSession(endpoint)`, `jannySetSession(raw)`, `jannySessionStatus()`, `jannyRecoverSession()`, `jannyLogout()`, `setJannySessionBrowserHooks(hooks)`, and `initJannySession()`.

- [ ] **Step 1: Expand parser tests for contiguous chunks and rejection cases**

Add to `tests/janny-auth.test.mjs`:

```js
test('parseJannySession rejects missing or out-of-order chunk sequences', () => {
    assert.equal(parseJannySession('sb-eenzcbluoctduymzksoq-auth-token.1=tail'), null);
    assert.equal(parseJannySession('sb-eenzcbluoctduymzksoq-auth-token.0=head; sb-eenzcbluoctduymzksoq-auth-token.2=tail'), null);
});

test('parseJannySession accepts a Cookie prefix and URL-encoded chunk values', () => {
    const middle = Math.ceil(encoded.length / 2);
    const raw = `Cookie: sb-eenzcbluoctduymzksoq-auth-token.0=${encodeURIComponent(encoded.slice(0, middle))}; sb-eenzcbluoctduymzksoq-auth-token.1=${encodeURIComponent(encoded.slice(middle))}`;
    assert.deepEqual(parseJannySession(raw), session);
});
```

- [ ] **Step 2: Write failing browser-session client and coordinator tests**

Extend `tests/janny-browser-client.test.mjs` to assert the exact local routes:

```js
await browser.jannyBrowserSessionStatus();
assert.equal(calls.at(-1).path, '/plugins/cl-helper/jannyai-browser-session-status');

await browser.jannyBrowserRefreshSession();
assert.equal(calls.at(-1).path, '/plugins/cl-helper/jannyai-browser-refresh-session');
```

Update `tests/janny-browser-policy.test.mjs` so a complete session keeps its cookie for 400 days while its serialized `expires_at` remains the access JWT expiry, and a bare JWT cookie still expires with that JWT:

```js
const full = buildJannySessionCookies(accessToken, 'refresh-1', nowSeconds);
assert.ok(full.every(cookie => cookie.expires === nowSeconds + (400 * 24 * 60 * 60)));

const bare = buildJannySessionCookies(accessToken, '', nowSeconds);
assert.ok(bare.every(cookie => cookie.expires === accessExp));
```

In `tests/janny-session.test.mjs`, use browser-hook fakes and exact assertions for:

1. A complete encoded session is installed once with its access/refresh pair, then only redacted browser status is returned.
2. A bare future JWT is installed with an empty refresh token and is reported as non-renewable.
3. Wrong Janny issuer and an expired bare JWT are rejected before any browser hook runs.
4. An expired access token accompanied by a refresh token is installed, receives exactly one browser recovery attempt, and succeeds only when the browser reports an active rotated session.
5. Neither successful installation nor status writes the pasted cookie, access token, or refresh token to `CoreAPI` settings.
6. Three concurrent `jannyRecoverSession()` calls share one browser recovery navigation.
7. `jannyLogout()` calls browser logout once, clears legacy `jannyToken` and `jannyRefreshToken` settings, and returns no credentials.
8. The module source contains no Supabase `apikey`, `/auth/v1/user`, or `grant_type=refresh_token` call.

- [ ] **Step 3: Run the tests and verify failures**

Run:

```bash
node --test tests/janny-auth.test.mjs tests/janny-browser-policy.test.mjs tests/janny-browser-client.test.mjs tests/janny-session.test.mjs
```

Expected: parser gap assertions fail and the new browser/session exports are missing.

- [ ] **Step 4: Add redacted helper session status and vanilla recovery routes**

Add a private `readJannyBrowserSession(cookies)` beside `injectJannySession`. It must join the unsuffixed cookie or contiguous `.0`, `.1`, ... chunks, decode only the known Supabase session representation, and return this shape without either token:

```js
{
    active: Boolean(accessToken && (!expMs || expMs > Date.now())),
    email: claims.email || '',
    expMs,
    hasRefresh: Boolean(refreshToken),
    refreshable: Boolean(refreshToken),
}
```

Register:

- `POST /jannyai-browser-session-status`: obtain the warm page, read Janny cookies, and return the redacted shape.
- `POST /jannyai-browser-refresh-session`: navigate the Janny warm page to `/auth/profile`, wait for document readiness and Cloudflare completion, then return freshly read redacted status. This delegates renewal to JannyAI's own server/browser flow; it must not call Supabase directly.

Both routes return generic local transport errors and never log or echo cookie/token values.

Update `buildJannySessionCookies` so `session.expires_at` continues to describe the access JWT, but cookie metadata uses `nowSeconds + 400 * 24 * 60 * 60` when a refresh token exists. A bare JWT cookie retains the access-token expiry. This prevents the browser from deleting the refresh token at access-token expiry and matches Supabase SSR's long-lived cookie storage model.

- [ ] **Step 5: Add browser client wrappers**

In `janny-browser.js`, implement:

```js
export function jannyBrowserSessionStatus(endpoint) {
    return callHelper('/jannyai-browser-session-status', jannyBrowserTarget(endpoint), { timeoutMs: 60_000 });
}

export function jannyBrowserRefreshSession(endpoint) {
    return callHelper('/jannyai-browser-refresh-session', jannyBrowserTarget(endpoint), { timeoutMs: 120_000 });
}
```

Expose both from `initJannyBrowserClient()` without changing Janitor's globals.

- [ ] **Step 6: Implement browser-owned session coordination**

Create `janny-session.js` with this hook boundary:

```js
let browserHooks = {
    setSession: async () => ({ ok: false, error: 'Browser client not initialized' }),
    status: async () => ({ active: false, hasRefresh: false, refreshable: false }),
    refresh: async () => ({ active: false, hasRefresh: false, refreshable: false }),
    logout: async () => ({ ok: false, error: 'Browser client not initialized' }),
};
let recoveryInFlight = null;

export function setJannySessionBrowserHooks(hooks) {
    browserHooks = { ...browserHooks, ...hooks };
}
```

Implement these rules:

- `jannySetSession(raw)` parses the input, validates the Janny issuer locally, rejects an expired bare JWT, and installs a complete pair even when its access JWT just expired so the browser can rotate it. After installation it calls `status()`; when inactive with `hasRefresh`, it calls `jannyRecoverSession()` once. Only an active result clears legacy token settings and counts as success.
- `jannySessionStatus()` delegates to the browser and returns only `{ active, email, expMs, hasRefresh, refreshable }`.
- `jannyRecoverSession()` serializes one call to the browser `refresh` hook and returns its redacted status.
- `jannyLogout()` clears legacy token settings, calls browser logout, and returns the helper's non-secret result.
- `initJannySession()` exposes `window.jannySetSession`, `window.jannySessionStatus`, `window.jannyRecoverSession`, and `window.jannyLogout`.

Do not define `JANNY_ANON_KEY`, `jannyVerifyToken`, `jannyRefreshGrant`, `getValidJannyToken`, or `jannyForceRefresh`. Do not add `jannyRefreshToken` to defaults; the browser profile is the durable store.

- [ ] **Step 7: Replace the provider-session static test**

Rewrite `tests/janny-provider-session.test.mjs` to assert that provider initialization wires all four browser hooks into `janny-session.js` and contains no inline token persistence or direct Supabase calls.

- [ ] **Step 8: Run session tests**

Run:

```bash
node --check extras/cl-helper/index.js
node --check extras/cl-helper/janny-browser-policy.js
node --check modules/providers/janny/janny-auth.js
node --check modules/providers/janny/janny-browser.js
node --check modules/providers/janny/janny-session.js
node --test tests/janny-auth.test.mjs tests/janny-browser-policy.test.mjs tests/janny-browser-client.test.mjs tests/janny-session.test.mjs tests/janny-provider-session.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit browser-owned session lifecycle**

```bash
git add extras/cl-helper/index.js extras/cl-helper/janny-browser-policy.js modules/providers/janny/janny-auth.js modules/providers/janny/janny-browser.js modules/providers/janny/janny-session.js app/library.js tests/janny-auth.test.mjs tests/janny-browser-policy.test.mjs tests/janny-browser-client.test.mjs tests/janny-session.test.mjs tests/janny-provider-session.test.mjs
git commit -m "feat: use browser-owned JannyAI sessions"
```

---

### Task 5: Rewire bookmarks, collections, and public pages

**Files:**
- Modify: `extras/cl-helper/index.js:3177-3223`
- Modify: `modules/providers/janny/janny-browser.js`
- Modify: `modules/providers/janny/janny-api.js:111-334`
- Modify: `tests/janny-browser-client.test.mjs`
- Replace: `tests/janny-api-account.test.mjs`
- Delete: `tests/janny-public-collections-bridge-optional.test.mjs`

**Interfaces:**
- Consumes: `jannyBrowserFetch`, `jannyRecoverSession`, `jannySessionStatus`, and existing Janny HTML parsers.
- Produces: Existing bookmark/collection/public-page exports with unchanged caller signatures; `probeJannyAccount()` returning `{ browser, active, cloudflare, reason, code }`.

- [ ] **Step 1: Rewrite account tests around cookie-authenticated helper transport**

Replace the postMessage fake userscript in `tests/janny-api-account.test.mjs` with a fake `window.apiRequest` router for `/plugins/cl-helper/jannyai-browser-fetch`. Preserve assertions for bookmark object normalization, JSON bodies, delete queries, form posts, collection ID extraction, character chunking, and public collection parsing.

Add these cases:

```js
test('retries one 401 after one browser-owned recovery', async () => {
    helperReplies.push({ ok: true, status: 401, body: '{}' });
    helperReplies.push({ ok: true, status: 200, body: '{"bookmarks":[]}' });
    refreshStatus = { active: true, hasRefresh: true, refreshable: true };
    assert.deepEqual(await api.fetchJannyBookmarks(), []);
    assert.equal(recoveryCalls, 1);
    assert.equal(seenFetchBodies.length, 2);
    assert.equal('token' in seenFetchBodies[0], false);
    assert.equal('token' in seenFetchBodies[1], false);
});

test('stops after a second 401', async () => {
    helperReplies.push({ ok: true, status: 401, body: '{}' });
    helperReplies.push({ ok: true, status: 401, body: '{}' });
    await assert.rejects(api.fetchJannyBookmarks(), error => error.code === 'JANNY_LOGIN_REQUIRED');
    assert.equal(recoveryCalls, 1);
});

test('public collection pages require browser transport and have no direct fetch fallback', async () => {
    await api.fetchJannyPublicCollections({ sort: 'latest', page: 2 });
    assert.equal(seenFetchBodies.at(-1).path, '/collections?sort=latest&page=2');
    assert.equal(directFetchCount, 0);
});
```

- [ ] **Step 2: Run tests and verify bridge-coupled failures**

Run: `node --test tests/janny-api-account.test.mjs`

Expected: FAIL because `janny-api.js` still imports and calls the userscript bridge.

- [ ] **Step 3: Replace `jannyBridgeRequest` with browser request completion**

```js
import { jannyBrowserFetch } from './janny-browser.js';
import { jannyRecoverSession, jannySessionStatus } from './janny-session.js';

async function jannyBrowserRequest(method, path, { jsonBody, formBody } = {}) {
    let result = await jannyBrowserFetch(path, { method, jsonBody, formBody });
    if (result.status === 401) {
        const recovered = await jannyRecoverSession();
        if (recovered.active) result = await jannyBrowserFetch(path, { method, jsonBody, formBody });
    }
    return finishJannyBrowserResponse(result);
}
```

`finishJannyBrowserResponse` maps status/helper error codes to the stable design codes. It accepts empty successful bodies for form redirects, detects Cloudflare HTML, and rejects a 200 challenge/login page. Every browser request relies on `credentials: include`; no caller passes a token or `anonymous` flag.

`probeJannyAccount()` first reads redacted browser status. When inactive, it returns `JANNY_LOGIN_REQUIRED` without attempting an account mutation. When active, it performs a read-only `/api/bookmark` request as the end-to-end account check.

Remove all imports, availability checks, postMessage assumptions, bearer-token handling, and direct `fetch` fallback from `janny-api.js`.

Remove the `token` option from `jannyBrowserFetch`, its helper request body, and its tests. Remove the `req.body.token` validation and `headers.Authorization` branch from `/jannyai-browser-fetch`; `/jannyai-browser-session` remains the only route that accepts account credentials.

- [ ] **Step 4: Remove the obsolete optional-bridge test and run focused tests**

Run:

```bash
node --check modules/providers/janny/janny-api.js
node --check modules/providers/janny/janny-browser.js
node --check extras/cl-helper/index.js
node --test tests/janny-api-account.test.mjs tests/janny-browser-client.test.mjs tests/janny-html.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit account transport**

```bash
git add extras/cl-helper/index.js modules/providers/janny/janny-browser.js modules/providers/janny/janny-api.js tests/janny-browser-client.test.mjs tests/janny-api-account.test.mjs
git rm tests/janny-public-collections-bridge-optional.test.mjs
git commit -m "feat: route JannyAI accounts through browser cookies"
```

---

### Task 6: Direct hydrated-page definition extraction and provider lifecycle

**Files:**
- Modify: `extras/cl-helper/index.js:2700-2750,3177-3223`
- Modify: `modules/providers/janny/janny-provider.js:1-390,454-463,547-560,739-744`
- Modify: `tests/janny-browser-helper-static.test.mjs`
- Create: `tests/janny-definition-browser.test.mjs`

**Interfaces:**
- Consumes: `jannyBrowserFetch(path, { inspectCharacterId })`, `initJannyBrowserClient`, `initJannySession`, and the Task 4 browser hooks.
- Produces: one-navigation `fetchCharacterDetails(characterId, slug)` returning `{ character, imageUrl }`; provider `minClHelperVersion = '1.13.0'`.

- [ ] **Step 1: Add failing helper assertions for one-navigation extraction**

Extend `tests/janny-browser-helper-static.test.mjs` to isolate the `inspectCharacterId` branch and assert:

```js
assert.match(inspectBranch, /extractHydratedJannyCharacter/);
assert.doesNotMatch(inspectBranch, /fetch\(/);
assert.match(extractor, /component-(?:export|url)[^\n]*CharacterButtons/);
assert.match(extractor, /firstMessage/);
assert.match(extractor, /personality/);
assert.match(extractor, /scenario/);
assert.match(extractor, /exampleDialogs/);
```

The test must also assert that the extractor rejects a requested-ID mismatch and never reads cookies, local storage, or response headers.

- [ ] **Step 2: Write failing provider tests around hydrated data as the only definition source**

`tests/janny-definition-browser.test.mjs` must fake helper responses and assert:

```js
test('requests hydrated character data in one browser call', async () => {
    browserReplies.push({
        status: 200,
        body: '',
        finalUrl: characterUrl,
        hydratedCharacter: { character: completeCharacter, imageUrl },
    });
    const result = await provider.fetchMetadata(`${characterId}_demo`);
    assert.equal(result.personality, 'Definition');
    assert.equal(result.firstMessage, 'Hello');
    assert.equal(browserCalls.length, 1);
    assert.equal(browserCalls[0].inspectCharacterId, characterId);
});

test('rejects hydrated payloads missing a greeting or all definition fields', async () => {
    browserReplies.push({ status: 200, hydratedCharacter: { character: { ...completeCharacter, firstMessage: '' } } });
    await assert.rejects(provider.fetchMetadata(`${characterId}_demo`), error => error.code === 'JANNY_PAGE_SHAPE_CHANGED');
});

test('propagates a classified block and never imports a listing stub', async () => {
    browserReplies.push({ status: 403, body: '<title>Forbidden</title>', finalUrl: characterUrl });
    await assert.rejects(provider.fetchMetadata(`${characterId}_demo`), error => error.code === 'JANNY_CF_BLOCKED');
    assert.equal(importCalls.length, 0);
});
```

- [ ] **Step 3: Run the tests and verify current ladder behavior fails**

Run:

```bash
node --test tests/janny-browser-helper-static.test.mjs tests/janny-definition-browser.test.mjs
```

Expected: FAIL because the helper currently fetches the character URL and then navigates again, while the provider still uses userscript/proxy transports.

- [ ] **Step 4: Make hydrated extraction the character branch of the helper route**

For a validated request carrying `inspectCharacterId`, `/jannyai-browser-fetch` must skip its in-page `fetch` branch and call `extractHydratedJannyCharacter` directly. That routine:

1. navigates once to the allowlisted character URL;
2. validates the final Janny origin/path and waits for document readiness;
3. classifies Cloudflare challenge/login pages before parsing;
4. selects the `CharacterButtons` Astro island by `component-export` or `component-url`;
5. decodes only `character` and `imageUrl` from its `props` attribute;
6. requires the decoded ID to equal `inspectCharacterId`;
7. requires a nonempty `firstMessage` and at least one nonempty definition field among `personality`, `scenario`, and `exampleDialogs`; and
8. returns `{ character, imageUrl }` without cookies, storage, headers, or unrelated page state.

Return `{ status: 200, body: '', finalUrl, hydratedCharacter }` after a successful extraction. Unknown/missing island data becomes the existing page-shape error response; it must not trigger a second definition endpoint or transport.

- [ ] **Step 5: Replace all provider character-page transports with the single browser extraction**

In `janny-provider.js` remove:

- both bridge imports;
- `proxyEncode` and unused proxy imports;
- `fetchHtmlPage`, Puter, corsproxy.io, and ST-proxy helpers;
- the inline Astro HTML decoder/parser;
- inline session storage/exposure;
- both bridge initialization calls.

Implement:

```js
async function fetchCharacterDetails(characterId, slug) {
    const path = `/characters/${characterId}_${slug || 'character'}`;
    const result = await jannyBrowserFetch(path, { method: 'GET', inspectCharacterId: characterId });
    const hydrated = result.hydratedCharacter;
    if (!hydrated?.character || String(hydrated.character.id) !== String(characterId)) {
        const error = new Error('JannyAI loaded, but its character payload shape changed');
        error.code = 'JANNY_PAGE_SHAPE_CHANGED';
        throw error;
    }
    return hydrated;
}
```

Provider initialization must call `initJannyBrowserClient()`, configure the Task 4 session hooks, then call `initJannySession()`. Add `get minClHelperVersion() { return '1.13.0'; }`.

`fetchMetadata`, `fetchRemoteCard`, and `importCharacter` must rethrow stable `JANNY_*` errors. Remove the `importCharacter` MeiliSearch-hit fallback entirely; a listing hit may backfill tags, creator ID, and avatar only after complete hydrated definition data has been obtained.

- [ ] **Step 6: Run definition/provider tests**

Run:

```bash
node --check extras/cl-helper/index.js
node --check modules/providers/janny/janny-provider.js
node --test tests/janny-browser-helper-static.test.mjs tests/janny-definition-browser.test.mjs tests/janny-provider-session.test.mjs tests/janny-html.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit definition transport**

```bash
git add extras/cl-helper/index.js modules/providers/janny/janny-provider.js tests/janny-browser-helper-static.test.mjs tests/janny-definition-browser.test.mjs
git commit -m "feat: extract JannyAI definitions from hydrated pages"
```

---

### Task 7: Duplicate Janny browser settings and browser-owned account controls

**Files:**
- Modify: `app/library.html:1580-1650,2627-2677`
- Modify: `app/library.js:1939-1948,2524-2635,4816-5014`
- Modify: `app/library.css:9374-9381`
- Modify: `app/library-mobile.css:2765-2775`
- Replace: `tests/janny-settings-account.test.mjs`

**Interfaces:**
- Consumes: `window.jannyTestBrowserEndpoint`, `window.jannySetSession`, `window.jannyLogout`, `window.jannySessionStatus`, existing helper status APIs.
- Produces: Provider-local Janny browser controls bound to shared settings plus accurate redacted browser-session/renewal status.

- [ ] **Step 1: Replace the settings static tests**

Assert these exact Janny IDs exist:

```js
for (const id of [
    'jannyBrowserPluginBanner', 'jannyBrowserFields',
    'settingsJannyBrowserMode', 'jannyManagedRow', 'jannyManagedStatusRow',
    'jannyManagedStatus', 'jannyManagedStartBtn', 'jannyManagedStopBtn',
    'jannyEndpointHintRow', 'settingsJannyBrowserEndpoint',
    'testJannyBrowserBtn', 'jannyBrowserChecks',
    'settingsJannyToken', 'toggleJannyTokenVisibility',
    'saveJannyTokenBtn', 'clearJannyTokenBtn',
    'jannySettingsAccountStatus', 'jannySettingsAccountHint',
]) assert.match(html, new RegExp(`id="${id}"`));

assert.doesNotMatch(html, /cl-janny-bridge\.user\.js/);
assert.match(html, /Step 1: Browser/);
assert.match(html, /Step 2: Account Login/);
assert.match(html, /sb-eenzcbluoctduymzksoq-auth-token\.0/);
assert.match(js, /janitoraiBrowserMode/);
assert.match(js, /janitoraiBrowserEndpoint/);
assert.match(js, /window\.jannyTestBrowserEndpoint/);
assert.doesNotMatch(js, /clJannyBridge|bridge\.refresh/);
```

- [ ] **Step 2: Run the settings test and verify it fails**

Run: `node --test tests/janny-settings-account.test.mjs`

Expected: FAIL on missing browser IDs and obsolete userscript copy.

- [ ] **Step 3: Build the provider-local Janny browser subsection**

Duplicate the Janitor browser control structure under Janny-specific IDs. Copy must state:

- browser is required only for Cloudflare-gated pages/account actions, not MeiliSearch browsing;
- managed and external modes share JanitorAI's configured browser;
- Test measures JannyAI specifically;
- full `.0`/`.1` cookie pair is preferred and is transferred once into the browser;
- the browser profile, not Character Library settings, owns renewal;
- bare JWT is accepted but cannot renew.

Do not add Janny email/password fields.

- [ ] **Step 4: Bind Janny controls to shared settings and Janny routes**

Add Janny-specific functions mirroring Janitor's control behavior without changing the Janitor handlers. Use `getSetting('janitoraiBrowserMode') || 'managed'` as the mode source and implement `refreshJannyManagedStatus()`, `refreshJannySettingsUi()`, `applyJannyBrowserMode()`, and `renderJannyBrowserChecks(checks, fatalError)` as separate functions so no Janitor DOM IDs are reused.

```js
const jannyBrowserMode = () => getSetting('janitoraiBrowserMode') || 'managed';
```

Requirements:

- Both Janny select/input writes update `janitoraiBrowserMode` and `janitoraiBrowserEndpoint`.
- Each settings section re-reads values on open/toggle; it does not assume the duplicate controls stayed synchronized.
- Janny Start/Stop/Status call `/plugins/cl-helper/jannyai-managed/*`.
- Janny Test calls `window.jannyTestBrowserEndpoint` and renders Janny-specific checks.
- Save Login calls `window.jannySetSession`, reports whether browser installation succeeded, clears only the visible input, and never writes raw or parsed credentials to settings.
- Log Out awaits `window.jannyLogout`, reports browser-cookie cleanup separately, and preserves Cloudflare readiness.
- Account status awaits the helper's redacted browser result and shows email, expiry, and `hasRefresh`; a bare token gets a non-renewable warning.

- [ ] **Step 5: Extend desktop/mobile selectors to the Janny row**

Use grouped selectors:

```css
#janitoraiManagedStatusRow,
#jannyManagedStatusRow { /* existing declarations */ }

html.cl-mobile #janitoraiManagedStatusRow,
html.cl-mobile #jannyManagedStatusRow { /* existing declarations */ }

html.cl-mobile #janitoraiManagedStatusRow .settings-action-btn,
html.cl-mobile #jannyManagedStatusRow .settings-action-btn { /* existing declarations */ }
```

- [ ] **Step 6: Run settings and syntax tests**

Run:

```bash
node --check app/library.js
node --test tests/janny-settings-account.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit settings UI**

```bash
git add app/library.html app/library.js app/library.css app/library-mobile.css tests/janny-settings-account.test.mjs
git commit -m "feat: add JannyAI browser settings"
```

---

### Task 8: Account readiness, cache invalidation, and fail-closed browse UX

**Files:**
- Modify: `modules/providers/janny/janny-browse.js:610-640,92-105,1416-1543,1867-2050,2420-2428`
- Modify: `tests/janny-collections-ux-static.test.mjs`
- Modify: `tests/janny-compact-bookmark-ux-static.test.mjs`

**Interfaces:**
- Consumes: `probeJannyAccount()` browser-shaped status and stable Janny error codes.
- Produces: Browser/account gating with no userscript assumptions; cache reset entry point `window.jannyInvalidateAccountCache`.

- [ ] **Step 1: Add failing UX assertions**

Add static assertions that `janny-browse.js`:

```js
assert.match(js, /jannyAccountStatus = \{ browser: false, active: false/);
assert.match(js, /JANNY_BROWSER_UNAVAILABLE/);
assert.match(js, /JANNY_PAGE_SHAPE_CHANGED/);
assert.match(js, /jannyInvalidateAccountCache/);
assert.doesNotMatch(js, /bridge userscript|cl-janny-bridge|cl-janitor-bridge/);
assert.doesNotMatch(js, /refresh the userscript|direct Supabase|copy cf_clearance/i);
```

- [ ] **Step 2: Run focused UX tests and verify failures**

Run: `node --test tests/janny-collections-ux-static.test.mjs tests/janny-compact-bookmark-ux-static.test.mjs`

Expected: FAIL on bridge-shaped status and obsolete copy.

- [ ] **Step 3: Rework readiness and errors**

Change account status to:

```js
let jannyAccountStatus = { browser: false, active: false, cloudflare: false, reason: '', code: '' };
```

`ensureJannyAccountReady()` must distinguish:

- missing/outdated helper;
- browser endpoint unavailable;
- Cloudflare challenge;
- missing, expired, or rejected browser-owned account session.

Use `CoreAPI.openSettingsToSection('online', ...)` or the existing settings deep-link pattern to open the Janny section from actionable errors.

Add:

```js
function invalidateJannyAccountCache() {
    jannyBookmarksLoaded = false;
    jannyBookmarkIds = new Set();
    jannyOwnedCollectionsLoaded = false;
    jannyOwnedCollections = [];
    jannyModalCollectionIds = new Set();
    jannyModalCollectionChecksLoadedFor = '';
}
window.jannyInvalidateAccountCache = invalidateJannyAccountCache;
```

Call this after browser-session installation/logout and after definitive session rejection.

Update definition preview/import handling so `JANNY_CF_BLOCKED` and `JANNY_PAGE_SHAPE_CHANGED` keep import disabled and show distinct messages. Remove the listing-only fallback that could produce a stub when full page data is unavailable.

- [ ] **Step 4: Run browse tests and syntax check**

Run:

```bash
node --check modules/providers/janny/janny-browse.js
node --test tests/janny-collections-ux-static.test.mjs tests/janny-compact-bookmark-ux-static.test.mjs tests/janny-api-account.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit browse UX**

```bash
git add modules/providers/janny/janny-browse.js app/library.js tests/janny-collections-ux-static.test.mjs tests/janny-compact-bookmark-ux-static.test.mjs
git commit -m "fix: fail closed on JannyAI browser errors"
```

---

### Task 9: Remove obsolete bridges and rewrite current documentation

**Files:**
- Delete: `extras/cl-janny-bridge.user.js`
- Delete: `modules/providers/janny/janny-bridge.js`
- Delete: `tests/janny-bridge.test.mjs`
- Delete: `tests/janny-bridge-refresh-parity.test.mjs`
- Delete: `tests/janny-bridge-userscript-static.test.mjs`
- Modify: `README.md:580-635,872-945`
- Modify: `app/library.html:1580-1650`
- Modify: `modules/providers/janny/janny-html.js:1`
- Modify: `docs/superpowers/specs/2026-07-18-jannyai-bridge-transport-design.md:1-8`
- Modify: `docs/superpowers/plans/2026-07-18-jannyai-bridge-transport.md:1-8`
- Modify: `docs/superpowers/plans/2026-07-07-jannyai-account-sync.md:1-8`
- Create: `tests/janny-no-userscript-regression.test.mjs`

**Interfaces:**
- Consumes: Completed browser/session setup and current docs.
- Produces: No active Janny userscript runtime or setup instructions; historical bridge docs visibly superseded.

- [ ] **Step 1: Write the no-userscript regression test**

```js
// tests/janny-no-userscript-regression.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const activeFiles = [
    '../README.md',
    '../app/library.html',
    '../app/library.js',
    '../modules/providers/janny/janny-api.js',
    '../modules/providers/janny/janny-browse.js',
    '../modules/providers/janny/janny-provider.js',
];

test('removes the Janny userscript and active references to both bridge transports', () => {
    assert.equal(existsSync(new URL('../extras/cl-janny-bridge.user.js', import.meta.url)), false);
    assert.equal(existsSync(new URL('../modules/providers/janny/janny-bridge.js', import.meta.url)), false);
    for (const file of activeFiles) {
        const text = readFileSync(new URL(file, import.meta.url), 'utf8');
        assert.doesNotMatch(text, /cl-janny-bridge|JannyAI[^\n]{0,120}cl-janitor-bridge|userscript[^\n]{0,120}JannyAI/i, file);
    }
});

test('retains the shared Janitor bridge for DataCat only', () => {
    assert.equal(existsSync(new URL('../extras/cl-janitor-bridge.user.js', import.meta.url)), true);
    const datacat = readFileSync(new URL('../modules/providers/datacat/datacat-provider.js', import.meta.url), 'utf8');
    assert.match(datacat, /janitor-bridge/);
});

test('keeps MeiliSearch independent from the Janny browser helper', () => {
    const api = readFileSync(new URL('../modules/providers/janny/janny-api.js', import.meta.url), 'utf8');
    const start = api.indexOf('export async function meiliMultiSearch');
    const end = api.indexOf('export function resolveTagNames', start);
    const meiliBlock = api.slice(start, end);
    assert.match(api, /const JANNY_SEARCH_URL = 'https:\/\/search\.jannyai\.com\/multi-search'/);
    assert.match(meiliBlock, /fetch\(JANNY_SEARCH_URL/);
    assert.doesNotMatch(meiliBlock, /jannyBrowserFetch|jannyai-browser/);
});
```

- [ ] **Step 2: Run the regression test and verify it fails**

Run: `node --test tests/janny-no-userscript-regression.test.mjs`

Expected: FAIL because the obsolete files and active references still exist.

- [ ] **Step 3: Delete obsolete source and tests**

Use `git rm` for the five obsolete files listed above. Do not delete or modify `extras/cl-janitor-bridge.user.js` or DataCat bridge modules/tests.

- [ ] **Step 4: Rewrite active setup/help copy**

README and Help & Tips must describe:

- MeiliSearch browse works without the browser;
- character definitions and `jannyai.com` pages require the shared real-browser setup;
- Janny has its own Test button and provider-local controls;
- bookmarks/owned collections additionally require the preferred `.0`/`.1` Supabase session installed into the browser;
- JannyAI owns complete-session renewal inside the browser; bare JWTs do not renew;
- DataCat remains the only documented consumer of the shared Janitor userscript in this scope;
- Termux/mobile uses managed or external browser setup, not a userscript.

Update `janny-html.js`'s header to describe browser-fetched HTML rather than a moved userscript parser.

Add a prominent superseded notice to each historical bridge/account-sync design/plan named in the file list, linking to the 2026-09-01 spec and plan. Do not rewrite their historical body as if it were current instructions.

- [ ] **Step 5: Run regression and documentation checks**

Run:

```bash
node --test tests/janny-no-userscript-regression.test.mjs tests/janny-settings-account.test.mjs
rg -n "cl-janny-bridge|JannyAI.*cl-janitor-bridge|userscript.*JannyAI" README.md app modules/providers/janny
```

Expected: tests PASS; `rg` returns no active matches.

- [ ] **Step 6: Commit removal and docs**

```bash
git add README.md app/library.html modules/providers/janny/janny-html.js docs/superpowers/specs/2026-07-18-jannyai-bridge-transport-design.md docs/superpowers/plans/2026-07-18-jannyai-bridge-transport.md docs/superpowers/plans/2026-07-07-jannyai-account-sync.md tests/janny-no-userscript-regression.test.mjs
git add -u extras/cl-janny-bridge.user.js modules/providers/janny/janny-bridge.js tests
git commit -m "docs: retire JannyAI userscript setup"
```

---

### Task 10: Full automated and authorized live verification

**Files:**
- Modify only if verification exposes a defect; keep each fix in the owning source/test file.

**Interfaces:**
- Consumes: All completed tasks and the owner's authorized Janny session at runtime.
- Produces: Passing automated suite, verified real Cloudflare transport, restored remote account state, clean worktree.

- [ ] **Step 1: Run every automated test**

Run: `node --test tests/*.mjs`

Expected: all tests PASS with no skipped Janny browser/session tests.

- [ ] **Step 2: Run syntax checks on every changed executable module**

Run:

```bash
node --check extras/cl-helper/index.js
node --check extras/cl-helper/janny-browser-policy.js
node --check modules/providers/janny/janny-auth.js
node --check modules/providers/janny/janny-browser.js
node --check modules/providers/janny/janny-session.js
node --check modules/providers/janny/janny-api.js
node --check modules/providers/janny/janny-html.js
node --check modules/providers/janny/janny-provider.js
node --check modules/providers/janny/janny-browse.js
node --check app/library.js
```

Expected: all exit 0.

- [ ] **Step 3: Verify JanitorAI was not changed accidentally**

Run:

```bash
git diff 23ba100 -- modules/providers/janitorai modules/providers/janitor-session.js extras/cl-janitor-bridge.user.js modules/providers/datacat/janitor-bridge.js
```

Expected: no unintended JanitorAI/provider/session/bridge diff. Any intentional shared internal edits are confined to `extras/cl-helper/index.js` and preserve the existing route tests.

- [ ] **Step 4: Install/update helper `1.13.0` and run Janny browser checks**

Use Character Library's helper updater or copy all three bundled helper files (`package.json`, `index.js`, `janny-browser-policy.js`) into the installed plugin, restart SillyTavern, and verify `/plugins/cl-helper/health` reports `1.13.0`.

In Settings → Online → JannyAI:

- managed mode starts/reuses the same process shown by JanitorAI;
- external mode uses the same endpoint value shown by JanitorAI;
- Janny Test passes endpoint, browser, script, codecs, Cloudflare, clearance, and character-page checks;
- changing browser mode/endpoint in one provider is reflected when reopening the other section.

- [ ] **Step 5: Verify anonymous definitions before installing the account session**

With Janny account logged out but Cloudflare ready:

- browse/search through MeiliSearch without starting a new browser request;
- open a known public character preview;
- verify personality and first greeting are nonempty;
- verify preview/import remains blocked for a deliberately simulated 403 or page-shape response;
- do not save a local test card merely to validate parsing.

- [ ] **Step 6: Install the authorized full session and verify browser-owned account state**

Paste the complete authorized `.0`/`.1` cookie header through the masked Janny settings input. Do not paste it into a terminal or test fixture.

Verify:

- UI shows the browser-reported email and `hasRefresh` state;
- raw input clears after save;
- neither the raw cookie header nor parsed `jannyToken`/`jannyRefreshToken` values are persisted in settings;
- helper logs contain no token or cookie values;
- bookmarks and owned collections load.

- [ ] **Step 7: Exercise reversible account writes**

Before each write, record only object IDs and original membership state, never auth data.

1. Select a character not currently bookmarked, add it, confirm remotely, remove it, and confirm original state.
2. Create a uniquely named temporary private collection.
3. Edit its description.
4. Add one character and confirm membership.
5. Remove the character and confirm absence.
6. Delete the temporary collection and confirm it no longer appears.

Put cleanup in a `finally` path. If cleanup cannot complete, stop and report the exact temporary object name/ID to the user rather than touching unrelated account data.

- [ ] **Step 8: Exercise browser-owned recovery and logout semantics**

Use the automated 401 fixture to verify exactly one `/auth/profile` recovery navigation and one account retry. In the live browser, navigate between profile, bookmarks, and one character page, then confirm redacted session status and account APIs remain active. Do not call Supabase directly, force a refresh grant, or print/compare cookie values.

Log out once and verify:

- any inert legacy `jannyToken` and `jannyRefreshToken` settings are cleared;
- Janny account cookies are cleared from the browser;
- `cf_clearance` remains;
- anonymous character definition fetch still works.

Restore the latest valid authorized session through the settings UI if logout displaced the user's intended state.

- [ ] **Step 9: Commit any verification fixes separately**

If live verification exposed a defect, add a regression test first, make the minimum fix, rerun the focused and full suites, stage only the owning source file(s) and the new or changed regression test file(s), then commit:

```bash
git commit -m "fix: harden JannyAI browser verification"
```

If no fixes were required, do not create an empty commit.

- [ ] **Step 10: Record final evidence**

Run:

```bash
git status --short
git log --oneline --decorate -12
```

Expected: clean worktree and a sequence of focused commits matching Tasks 1-9, plus an optional live-verification fix commit.
