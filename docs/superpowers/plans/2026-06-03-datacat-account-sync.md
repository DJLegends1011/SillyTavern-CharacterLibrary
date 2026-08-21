# DataCat Account Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional DataCat account login, account-backed extraction, and remote "Yours" save/unsave sync while preserving the current anonymous DataCat flow.

**Architecture:** Keep DataCat's anonymous session as the fallback path. Add account-aware session helpers in `cl-helper`, expose narrow account/collection routes to the frontend, and make the DataCat provider UI call those routes for login and save state. Treat DataCat's `/api/characters/{id}/collect` endpoint as the remote favorite toggle and `/api/characters/{id}/folders` as the membership/status source.

**Tech Stack:** Plain browser JavaScript modules, SillyTavern extension settings, ESM `cl-helper` plugin code, Node built-in test runner for pure helper tests, `node --check` for syntax verification.

---

## File Map

- Create `extras/cl-helper/datacat-utils.js`: pure DataCat token/header/user/ID helpers that can be unit tested without starting SillyTavern.
- Create `tests/datacat-utils.test.mjs`: Node test coverage for helper behavior.
- Modify `extras/cl-helper/index.js`: account token state, auth routes, account-aware extraction, collect/status proxy routes.
- Modify `modules/providers/datacat/datacat-api.js`: frontend wrappers for account login/status/restore/logout and save/unsave/status calls.
- Modify `modules/providers/datacat/datacat-provider.js`: bind saved account getters and expose window functions used by settings.
- Modify `modules/providers/datacat/datacat-browse.js`: save-state cache, card save button, preview save button, optimistic remote toggle.
- Modify `modules/providers/datacat/datacat-browse.css`: DataCat save button states.
- Modify `app/library.html`: DataCat account settings UI.
- Modify `app/library.js`: new settings defaults and settings event handlers.
- Modify `README.md`: document optional DataCat account sync and the scope exclusions for Vault/Cart.

---

### Task 1: Pure DataCat Helper Tests

**Files:**
- Create: `tests/datacat-utils.test.mjs`
- Create: `extras/cl-helper/datacat-utils.js`

- [ ] **Step 1: Write the failing helper tests**

Create `tests/datacat-utils.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildDataCatHeaders,
    chooseDataCatToken,
    isDataCatCharacterId,
    normalizeDcCredential,
    sanitizeDataCatUser,
} from '../extras/cl-helper/datacat-utils.js';

test('normalizeDcCredential trims strings and rejects invalid values', () => {
    assert.equal(normalizeDcCredential('  abc123  '), 'abc123');
    assert.equal(normalizeDcCredential(''), null);
    assert.equal(normalizeDcCredential('   '), null);
    assert.equal(normalizeDcCredential(null), null);
    assert.equal(normalizeDcCredential('x'.repeat(4097)), null);
});

test('chooseDataCatToken prefers account token when requested and available', () => {
    assert.deepEqual(
        chooseDataCatToken({ accountToken: 'acct', anonymousToken: 'anon', preferAccount: true }),
        { token: 'acct', source: 'account' },
    );
    assert.deepEqual(
        chooseDataCatToken({ accountToken: 'acct', anonymousToken: 'anon', preferAccount: false }),
        { token: 'anon', source: 'anonymous' },
    );
    assert.deepEqual(
        chooseDataCatToken({ accountToken: '', anonymousToken: 'anon', preferAccount: true }),
        { token: 'anon', source: 'anonymous' },
    );
});

test('buildDataCatHeaders includes session, device, and JSON headers safely', () => {
    const headers = buildDataCatHeaders({
        sessionToken: 'session-token',
        deviceToken: 'device-token',
        json: true,
    });
    assert.equal(headers.Accept, 'application/json');
    assert.equal(headers.Origin, 'https://datacat.run');
    assert.equal(headers.Referer, 'https://datacat.run/');
    assert.equal(headers['X-Session-Token'], 'session-token');
    assert.equal(headers['X-Device-Token'], 'device-token');
    assert.equal(headers['Content-Type'], 'application/json');
});

test('sanitizeDataCatUser returns only display-safe account fields', () => {
    assert.deepEqual(
        sanitizeDataCatUser({
            uuid: 'u-1',
            id: 'id-ignored',
            email: 'person@example.com',
            username: 'datacatfan',
            role: 'user',
            session: { token: 'secret' },
            passwordHash: 'secret',
        }),
        {
            uuid: 'u-1',
            email: 'person@example.com',
            username: 'datacatfan',
            role: 'user',
        },
    );
});

test('isDataCatCharacterId accepts DataCat UUID-like IDs only', () => {
    assert.equal(isDataCatCharacterId('123e4567-e89b-12d3-a456-426614174000'), true);
    assert.equal(isDataCatCharacterId('abc12345'), true);
    assert.equal(isDataCatCharacterId('../bad'), false);
    assert.equal(isDataCatCharacterId('not a uuid'), false);
});
```

- [ ] **Step 2: Run the tests and verify they fail because the helper file is missing**

Run: `node --test tests/datacat-utils.test.mjs`

Expected: FAIL with an import error for `extras/cl-helper/datacat-utils.js`.

- [ ] **Step 3: Implement the helper file**

Create `extras/cl-helper/datacat-utils.js`:

```js
export const DATACAT_ORIGIN = 'https://datacat.run';
export const DATACAT_TOKEN_MAX_LENGTH = 4096;

export function normalizeDcCredential(value, { maxLength = DATACAT_TOKEN_MAX_LENGTH } = {}) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > maxLength) return null;
    return trimmed;
}

export function isDataCatCharacterId(value) {
    const text = normalizeDcCredential(value, { maxLength: 80 });
    return !!text && /^[a-f0-9-]{8,64}$/i.test(text);
}

export function chooseDataCatToken({ accountToken = null, anonymousToken = null, preferAccount = true } = {}) {
    const account = normalizeDcCredential(accountToken);
    const anonymous = normalizeDcCredential(anonymousToken);
    if (preferAccount && account) return { token: account, source: 'account' };
    if (anonymous) return { token: anonymous, source: 'anonymous' };
    if (account) return { token: account, source: 'account' };
    return { token: null, source: null };
}

export function buildDataCatHeaders({ sessionToken, deviceToken = null, json = false } = {}) {
    const token = normalizeDcCredential(sessionToken);
    const device = normalizeDcCredential(deviceToken);
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Origin': DATACAT_ORIGIN,
        'Referer': `${DATACAT_ORIGIN}/`,
    };
    if (token) headers['X-Session-Token'] = token;
    if (device) headers['X-Device-Token'] = device;
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
}

export function sanitizeDataCatUser(user = null) {
    if (!user || typeof user !== 'object') return null;
    const uuid = normalizeDcCredential(user.uuid || user.id, { maxLength: 128 });
    const email = normalizeDcCredential(user.email, { maxLength: 320 });
    const username = normalizeDcCredential(user.username, { maxLength: 80 });
    const role = normalizeDcCredential(user.role, { maxLength: 40 });
    return {
        uuid,
        email,
        username,
        role,
    };
}
```

- [ ] **Step 4: Run the helper tests and verify they pass**

Run: `node --test tests/datacat-utils.test.mjs`

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit helper tests and helpers**

```bash
git add extras/cl-helper/datacat-utils.js tests/datacat-utils.test.mjs
git commit -m "test: cover datacat account helpers"
```

---

### Task 2: cl-helper Account Routes

**Files:**
- Modify: `extras/cl-helper/index.js`
- Test: `tests/datacat-utils.test.mjs`

- [ ] **Step 1: Update imports and DataCat session state**

In `extras/cl-helper/index.js`, add this import near the existing Node imports:

```js
import {
    buildDataCatHeaders,
    chooseDataCatToken,
    isDataCatCharacterId,
    normalizeDcCredential,
    sanitizeDataCatUser,
} from './datacat-utils.js';
```

Replace the DataCat state and header helper:

```js
let dcSessionToken = null;
let dcDeviceToken = null;
let dcAccountToken = null;
let dcAccountUser = null;

function dcHeaders(token, options = {}) {
    return buildDataCatHeaders({
        sessionToken: token,
        deviceToken: options.deviceToken || null,
        json: options.json === true,
    });
}

function getDcActiveToken({ preferAccount = true } = {}) {
    return chooseDataCatToken({
        accountToken: dcAccountToken,
        anonymousToken: dcSessionToken,
        preferAccount,
    });
}

function requireDcAccount(res) {
    if (!dcAccountToken) {
        res.status(401).json({ error: 'No DataCat account session configured' });
        return false;
    }
    return true;
}
```

- [ ] **Step 2: Preserve device token during anonymous identify**

In `/dc-init`, replace the local `deviceToken` setup with:

```js
const deviceToken = dcDeviceToken || randomUUID();
```

After a successful identify response, store the device token:

```js
dcSessionToken = data.sessionToken;
dcDeviceToken = data.deviceToken || data.newDeviceToken || deviceToken;
console.log('[cl-helper] DC anonymous session initialized');
return res.json({ ok: true, token: dcSessionToken, deviceToken: dcDeviceToken });
```

- [ ] **Step 3: Add account verification helper inside the DataCat section**

Add this function before `registerDataCatRoutes(router)`:

```js
async function verifyDcAccountToken(token) {
    const value = normalizeDcCredential(token);
    if (!value) return { valid: false, reason: 'missing token', user: null };
    try {
        const response = await fetch(`${DATACAT_BASE}/api/auth/verify`, {
            method: 'POST',
            headers: buildDataCatHeaders({ sessionToken: value, deviceToken: dcDeviceToken, json: true }),
            body: JSON.stringify({ token: value }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success || !data?.valid || !data?.user) {
            return { valid: false, reason: data?.reason || data?.error || `HTTP ${response.status}`, user: null };
        }
        return { valid: true, user: sanitizeDataCatUser(data.user) };
    } catch (err) {
        return { valid: false, reason: err.message, user: null };
    }
}
```

- [ ] **Step 4: Add account auth routes**

Inside `registerDataCatRoutes(router)`, after `/dc-validate`, add:

```js
    router.post('/dc-auth-login', async (req, res) => {
        const email = normalizeDcCredential(req.body?.email, { maxLength: 320 });
        const password = normalizeDcCredential(req.body?.password, { maxLength: 512 });
        if (!email || !password) {
            return res.status(400).json({ error: 'email and password are required' });
        }

        try {
            const body = { email, password };
            if (dcDeviceToken) body.anonToken = dcDeviceToken;
            const response = await fetch(`${DATACAT_BASE}/api/auth/login`, {
                method: 'POST',
                headers: buildDataCatHeaders({ sessionToken: dcSessionToken, deviceToken: dcDeviceToken, json: true }),
                body: JSON.stringify(body),
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || !data?.success || !data?.session?.token) {
                return res.status(response.status || 401).json({ error: data?.error || data?.message || 'DataCat login failed' });
            }

            dcAccountToken = data.session.token;
            if (data.newDeviceToken) dcDeviceToken = data.newDeviceToken;
            dcAccountUser = sanitizeDataCatUser(data.user || data.session?.user || null);
            console.log('[cl-helper] DC account session stored');
            res.json({ ok: true, accountToken: dcAccountToken, deviceToken: dcDeviceToken, user: dcAccountUser });
        } catch (err) {
            console.error('[cl-helper] DC account login error:', err.message);
            res.status(502).json({ error: 'Failed to reach DataCat auth server' });
        }
    });

    router.post('/dc-auth-set', async (req, res) => {
        const token = normalizeDcCredential(req.body?.accountToken || req.body?.token);
        const deviceToken = normalizeDcCredential(req.body?.deviceToken);
        if (!token) return res.status(400).json({ error: 'accountToken is required' });
        if (deviceToken) dcDeviceToken = deviceToken;
        const check = await verifyDcAccountToken(token);
        if (!check.valid) return res.status(401).json({ valid: false, reason: check.reason || 'invalid account token' });
        dcAccountToken = token;
        dcAccountUser = check.user;
        res.json({ ok: true, valid: true, user: dcAccountUser, deviceToken: dcDeviceToken });
    });

    router.get('/dc-auth-status', async (_req, res) => {
        if (!dcAccountToken) return res.json({ valid: false, reason: 'no account token stored', user: null });
        const check = await verifyDcAccountToken(dcAccountToken);
        if (check.valid) {
            dcAccountUser = check.user;
            return res.json({ valid: true, user: dcAccountUser, deviceToken: dcDeviceToken });
        }
        dcAccountToken = null;
        dcAccountUser = null;
        res.json({ valid: false, reason: check.reason || 'invalid account token', user: null });
    });

    router.post('/dc-auth-logout', async (_req, res) => {
        const token = dcAccountToken;
        dcAccountToken = null;
        dcAccountUser = null;
        if (token) {
            try {
                await fetch(`${DATACAT_BASE}/api/auth/logout`, {
                    method: 'POST',
                    headers: buildDataCatHeaders({ sessionToken: token, deviceToken: dcDeviceToken, json: true }),
                    body: JSON.stringify({ token }),
                });
            } catch (err) {
                console.warn('[cl-helper] DC logout request failed:', err.message);
            }
        }
        res.json({ ok: true });
    });
```

- [ ] **Step 5: Add remote Yours status and toggle routes**

Inside `registerDataCatRoutes(router)`, add before `/dc-proxy/*`:

```js
    router.get('/dc-yours/:characterId/status', async (req, res) => {
        if (!requireDcAccount(res)) return;
        const characterId = String(req.params.characterId || '').trim();
        if (!isDataCatCharacterId(characterId)) {
            return res.status(400).json({ error: 'Invalid DataCat character ID' });
        }
        try {
            const response = await fetch(`${DATACAT_BASE}/api/characters/${encodeURIComponent(characterId)}/folders`, {
                headers: buildDataCatHeaders({ sessionToken: dcAccountToken, deviceToken: dcDeviceToken }),
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || !data?.success) {
                return res.status(response.status || 502).json({ error: data?.error || data?.message || 'Failed to load DataCat save status' });
            }
            const folderIds = Array.isArray(data.folderIds) ? data.folderIds : [];
            res.json({ ok: true, collected: data.collected === true, folderIds });
        } catch (err) {
            res.status(502).json({ error: 'Failed to reach DataCat' });
        }
    });

    async function setDcCollected(req, res, shouldCollect) {
        if (!requireDcAccount(res)) return;
        const characterId = String(req.params.characterId || '').trim();
        if (!isDataCatCharacterId(characterId)) {
            return res.status(400).json({ error: 'Invalid DataCat character ID' });
        }
        try {
            const response = await fetch(`${DATACAT_BASE}/api/characters/${encodeURIComponent(characterId)}/collect`, {
                method: shouldCollect ? 'POST' : 'DELETE',
                headers: buildDataCatHeaders({ sessionToken: dcAccountToken, deviceToken: dcDeviceToken, json: true }),
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || !data?.success) {
                return res.status(response.status || 502).json({ error: data?.error || data?.message || 'Failed to update DataCat Yours' });
            }
            res.json({ ok: true, collected: shouldCollect });
        } catch (err) {
            res.status(502).json({ error: 'Failed to reach DataCat' });
        }
    }

    router.post('/dc-yours/:characterId', (req, res) => setDcCollected(req, res, true));
    router.delete('/dc-yours/:characterId', (req, res) => setDcCollected(req, res, false));
```

- [ ] **Step 6: Make extraction prefer account token only when requested**

At the top of `/dc-extract`, replace the `dcSessionToken` guard with:

```js
        const preferAccount = req.body?.useAccount !== false;
        const active = getDcActiveToken({ preferAccount });
        if (!active.token) {
            return res.status(401).json({ error: 'No DataCat session token configured' });
        }
```

In the public feed session resolution, use the active token:

```js
        if (wantPublicFeed) {
            sessionId = await getPublicSessionId(active.token);
        }
```

In the extraction fetch headers, replace `dcHeaders(dcSessionToken)` with:

```js
                    ...buildDataCatHeaders({
                        sessionToken: active.token,
                        deviceToken: dcDeviceToken,
                        json: true,
                    }),
```

- [ ] **Step 7: Keep read-only proxy account-aware without breaking anonymous**

In `/dc-proxy/*`, replace the token guard and fetch headers with:

```js
        const active = getDcActiveToken({ preferAccount: true });
        if (!active.token) {
            return res.status(401).json({ error: 'No DataCat session token configured' });
        }
```

and:

```js
                headers: buildDataCatHeaders({
                    sessionToken: active.token,
                    deviceToken: dcDeviceToken,
                }),
```

- [ ] **Step 8: Run helper tests and syntax check cl-helper**

Run:

```bash
node --test tests/datacat-utils.test.mjs
node --check extras/cl-helper/datacat-utils.js
node --check extras/cl-helper/index.js
```

Expected: helper tests pass and both syntax checks exit 0.

- [ ] **Step 9: Commit cl-helper account routes**

```bash
git add extras/cl-helper/index.js extras/cl-helper/datacat-utils.js tests/datacat-utils.test.mjs
git commit -m "feat: add datacat account routes"
```

---

### Task 3: Frontend DataCat Account API

**Files:**
- Modify: `modules/providers/datacat/datacat-api.js`
- Modify: `modules/providers/datacat/datacat-provider.js`

- [ ] **Step 1: Add saved account getter plumbing**

In `modules/providers/datacat/datacat-api.js`, near `_getSavedToken`, add:

```js
let _getSavedAccountToken = null;
let _getSavedDeviceToken = null;

export function setSavedAccountTokenGetter(fn) { _getSavedAccountToken = fn; }
export function setSavedDeviceTokenGetter(fn) { _getSavedDeviceToken = fn; }
```

- [ ] **Step 2: Add a shared cl-helper JSON request helper**

In `modules/providers/datacat/datacat-api.js`, after `checkDcPluginAvailable()`, add:

```js
async function dcHelperJson(path, { method = 'GET', body = null } = {}) {
    if (!_apiRequest) throw new Error('DataCat: apiRequest not bound');
    const resp = method === 'GET'
        ? await _apiRequest(`${CL_HELPER_PLUGIN_BASE}${path}`)
        : await _apiRequest(`${CL_HELPER_PLUGIN_BASE}${path}`, method, body || undefined);
    let data = null;
    try { data = await resp.json(); } catch { data = null; }
    if (!resp.ok) {
        throw new Error(data?.error || data?.message || `DataCat helper returned ${resp.status}`);
    }
    return data;
}
```

- [ ] **Step 3: Add account auth helper exports**

In `modules/providers/datacat/datacat-api.js`, after `clearDcSession()`, add:

```js
export async function restoreDatacatAccount(accountToken = null, deviceToken = null) {
    const token = accountToken || _getSavedAccountToken?.() || null;
    const device = deviceToken || _getSavedDeviceToken?.() || null;
    if (!token) return { valid: false, reason: 'no account token stored', user: null };
    try {
        return await dcHelperJson('/dc-auth-set', {
            method: 'POST',
            body: { accountToken: token, deviceToken: device },
        });
    } catch (err) {
        return { valid: false, reason: err.message, user: null };
    }
}

export async function loginDatacatAccount(email, password) {
    return dcHelperJson('/dc-auth-login', {
        method: 'POST',
        body: { email, password },
    });
}

export async function validateDatacatAccount() {
    try {
        return await dcHelperJson('/dc-auth-status');
    } catch (err) {
        return { valid: false, reason: err.message, user: null };
    }
}

export async function logoutDatacatAccount() {
    try {
        await dcHelperJson('/dc-auth-logout', { method: 'POST' });
        return true;
    } catch {
        return false;
    }
}
```

- [ ] **Step 4: Add Yours helper exports**

In `modules/providers/datacat/datacat-api.js`, after the account helpers, add:

```js
export async function fetchDatacatYoursStatus(characterId) {
    if (!characterId) return { ok: false, collected: false, folderIds: [] };
    try {
        return await dcHelperJson(`/dc-yours/${encodeURIComponent(characterId)}/status`);
    } catch (err) {
        return { ok: false, collected: false, folderIds: [], error: err.message };
    }
}

export async function setDatacatYoursSaved(characterId, saved) {
    if (!characterId) return { ok: false, collected: false, error: 'missing character id' };
    try {
        return await dcHelperJson(`/dc-yours/${encodeURIComponent(characterId)}`, {
            method: saved ? 'POST' : 'DELETE',
        });
    } catch (err) {
        return { ok: false, collected: !saved, error: err.message };
    }
}
```

- [ ] **Step 5: Bind getters and expose window functions from the provider**

In `modules/providers/datacat/datacat-provider.js`, extend the import list with:

```js
    setSavedAccountTokenGetter,
    setSavedDeviceTokenGetter,
    restoreDatacatAccount,
    loginDatacatAccount,
    validateDatacatAccount,
    logoutDatacatAccount,
```

In `DatacatProvider.init(coreAPI)`, add:

```js
        setSavedAccountTokenGetter(() => coreAPI.getSetting('datacatAccountToken') || null);
        setSavedDeviceTokenGetter(() => coreAPI.getSetting('datacatDeviceToken') || null);
```

Near the existing `window.datacatValidateSession` functions, add:

```js
window.datacatRestoreAccount = async () => {
    const pluginOk = await checkDcPluginAvailable();
    if (!pluginOk) return { valid: false, reason: 'cl-helper plugin not available', user: null };
    return restoreDatacatAccount();
};

window.datacatLoginAccount = async (email, password) => {
    const pluginOk = await checkDcPluginAvailable();
    if (!pluginOk) throw new Error('cl-helper plugin not available');
    return loginDatacatAccount(email, password);
};

window.datacatValidateAccount = async () => {
    const pluginOk = await checkDcPluginAvailable();
    if (!pluginOk) return { valid: false, reason: 'cl-helper plugin not available', user: null };
    return validateDatacatAccount();
};

window.datacatLogoutAccount = async () => {
    return logoutDatacatAccount();
};
```

- [ ] **Step 6: Syntax check provider modules**

Run:

```bash
node --check modules/providers/datacat/datacat-api.js
node --check modules/providers/datacat/datacat-provider.js
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit frontend API helpers**

```bash
git add modules/providers/datacat/datacat-api.js modules/providers/datacat/datacat-provider.js
git commit -m "feat: add datacat account frontend api"
```

---

### Task 4: Settings UI and Persistence

**Files:**
- Modify: `app/library.html`
- Modify: `app/library.js`

- [ ] **Step 1: Add DataCat account settings defaults**

In `app/library.js`, extend `DEFAULT_SETTINGS` next to the existing DataCat settings:

```js
    datacatAccountToken: null,
    datacatDeviceToken: null,
    datacatAccountUser: null,
    datacatUseAccountForExtraction: true,
    datacatSyncYours: true,
```

- [ ] **Step 2: Add the account settings markup**

In `app/library.html`, inside `#datacatSettingsFields` after the anonymous session buttons row and before the Extraction group, add:

```html
                                <div class="settings-group">
                                    <div class="settings-group-title"><i class="fa-solid fa-user"></i> DataCat Account</div>
                                    <div class="settings-row">
                                        <label>Status:</label>
                                        <div class="settings-input-group">
                                            <span id="datacatAccountStatus" class="settings-status-badge inactive"><i class="fa-solid fa-circle"></i> Signed out</span>
                                        </div>
                                    </div>
                                    <div class="settings-row datacat-account-login-row">
                                        <label>Email:</label>
                                        <div class="settings-input-group">
                                            <input type="email" id="settingsDatacatAccountEmail" class="glass-input" autocomplete="username" placeholder="you@example.com">
                                        </div>
                                    </div>
                                    <div class="settings-row datacat-account-login-row">
                                        <label>Password:</label>
                                        <div class="settings-input-group">
                                            <input type="password" id="settingsDatacatAccountPassword" class="glass-input" autocomplete="current-password" data-sensitive="true" placeholder="DataCat password">
                                        </div>
                                    </div>
                                    <div class="settings-row" style="gap: 8px;">
                                        <button id="datacatAccountLoginBtn" class="settings-action-btn">
                                            <i class="fa-solid fa-right-to-bracket"></i> Login
                                        </button>
                                        <button id="datacatAccountLogoutBtn" class="settings-action-btn danger" style="display: none;">
                                            <i class="fa-solid fa-right-from-bracket"></i> Logout
                                        </button>
                                        <a href="https://datacat.run/register" target="_blank" rel="noopener noreferrer" class="settings-action-btn">
                                            <i class="fa-solid fa-user-plus"></i> Register
                                        </a>
                                    </div>
                                    <div class="settings-row">
                                        <label class="settings-checkbox-label">
                                            <input type="checkbox" id="datacatUseAccountExtractionCheckbox">
                                            <span>Use account for extraction</span>
                                        </label>
                                    </div>
                                    <div class="settings-row">
                                        <label class="settings-checkbox-label">
                                            <input type="checkbox" id="datacatSyncYoursCheckbox">
                                            <span>Sync save buttons to DataCat Yours</span>
                                        </label>
                                    </div>
                                    <div class="settings-row">
                                        <span class="settings-hint">Passwords are sent once through cl-helper to DataCat. Character Library stores the returned account session token, not your password. Vault and Cart are not part of this branch.</span>
                                    </div>
                                </div>
```

- [ ] **Step 3: Add account status helpers in settings JS**

In `app/library.js`, near the existing DataCat session management block, add:

```js
    const datacatAccountStatus = document.getElementById('datacatAccountStatus');
    const datacatAccountEmailInput = document.getElementById('settingsDatacatAccountEmail');
    const datacatAccountPasswordInput = document.getElementById('settingsDatacatAccountPassword');
    const datacatAccountLoginBtn = document.getElementById('datacatAccountLoginBtn');
    const datacatAccountLogoutBtn = document.getElementById('datacatAccountLogoutBtn');
    const datacatUseAccountExtractionCheckbox = document.getElementById('datacatUseAccountExtractionCheckbox');
    const datacatSyncYoursCheckbox = document.getElementById('datacatSyncYoursCheckbox');

    function renderDatacatAccountStatus(result = null) {
        if (!datacatAccountStatus) return;
        const user = result?.user || getSetting('datacatAccountUser') || null;
        const valid = result?.valid === true || !!getSetting('datacatAccountToken');
        if (valid && user) {
            const label = user.username || user.email || 'Signed in';
            datacatAccountStatus.className = 'settings-status-badge active';
            datacatAccountStatus.innerHTML = `<i class="fa-solid fa-circle"></i> ${escapeHtml(label)}`;
            if (datacatAccountLoginBtn) datacatAccountLoginBtn.style.display = 'none';
            if (datacatAccountLogoutBtn) datacatAccountLogoutBtn.style.display = '';
            return;
        }
        datacatAccountStatus.className = 'settings-status-badge inactive';
        datacatAccountStatus.innerHTML = '<i class="fa-solid fa-circle"></i> Signed out';
        if (datacatAccountLoginBtn) datacatAccountLoginBtn.style.display = '';
        if (datacatAccountLogoutBtn) datacatAccountLogoutBtn.style.display = 'none';
    }

    async function updateDatacatAccountStatus({ restore = false } = {}) {
        if (!datacatAccountStatus) return;
        const token = getSetting('datacatAccountToken');
        if (!token || !window.datacatRestoreAccount) {
            renderDatacatAccountStatus({ valid: false });
            return;
        }
        datacatAccountStatus.className = 'settings-status-badge inactive';
        datacatAccountStatus.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
        const result = restore ? await window.datacatRestoreAccount() : await window.datacatValidateAccount?.();
        if (result?.valid || result?.ok) {
            if (result.user) setSetting('datacatAccountUser', result.user);
            if (result.deviceToken) setSetting('datacatDeviceToken', result.deviceToken);
            renderDatacatAccountStatus({ valid: true, user: result.user || getSetting('datacatAccountUser') });
        } else {
            renderDatacatAccountStatus({ valid: false });
        }
    }
```

- [ ] **Step 4: Wire settings events**

In the same DataCat settings block, add:

```js
    if (datacatUseAccountExtractionCheckbox) {
        datacatUseAccountExtractionCheckbox.checked = getSetting('datacatUseAccountForExtraction') !== false;
        datacatUseAccountExtractionCheckbox.addEventListener('change', () => {
            setSetting('datacatUseAccountForExtraction', datacatUseAccountExtractionCheckbox.checked);
        });
    }

    if (datacatSyncYoursCheckbox) {
        datacatSyncYoursCheckbox.checked = getSetting('datacatSyncYours') !== false;
        datacatSyncYoursCheckbox.addEventListener('change', () => {
            setSetting('datacatSyncYours', datacatSyncYoursCheckbox.checked);
        });
    }

    if (datacatAccountLoginBtn) {
        datacatAccountLoginBtn.onclick = async () => {
            const email = (datacatAccountEmailInput?.value || '').trim();
            const password = datacatAccountPasswordInput?.value || '';
            if (!email || !password) {
                showToast('Enter your DataCat email and password', 'warning');
                return;
            }
            datacatAccountLoginBtn.disabled = true;
            datacatAccountLoginBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Logging in...';
            try {
                const result = await window.datacatLoginAccount?.(email, password);
                if (!result?.ok || !result?.accountToken) throw new Error(result?.error || 'Login failed');
                setSetting('datacatAccountToken', result.accountToken);
                setSetting('datacatDeviceToken', result.deviceToken || null);
                setSetting('datacatAccountUser', result.user || null);
                if (datacatAccountPasswordInput) datacatAccountPasswordInput.value = '';
                showToast('DataCat account connected', 'success');
                renderDatacatAccountStatus({ valid: true, user: result.user });
            } catch (err) {
                showToast(`DataCat login failed: ${err.message}`, 'error');
                renderDatacatAccountStatus({ valid: false });
            } finally {
                datacatAccountLoginBtn.disabled = false;
                datacatAccountLoginBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Login';
            }
        };
    }

    if (datacatAccountLogoutBtn) {
        datacatAccountLogoutBtn.onclick = async () => {
            await window.datacatLogoutAccount?.();
            setSetting('datacatAccountToken', null);
            setSetting('datacatAccountUser', null);
            showToast('DataCat account disconnected', 'info');
            renderDatacatAccountStatus({ valid: false });
        };
    }

    updateDatacatAccountStatus({ restore: true });
```

- [ ] **Step 5: Syntax check settings files**

Run:

```bash
node --check app/library.js
```

Expected: command exits 0. `app/library.html` is verified manually by loading Settings after implementation.

- [ ] **Step 6: Commit settings UI**

```bash
git add app/library.html app/library.js
git commit -m "feat: add datacat account settings"
```

---

### Task 5: DataCat Browse Save/Unsave Sync

**Files:**
- Modify: `modules/providers/datacat/datacat-api.js`
- Modify: `modules/providers/datacat/datacat-browse.js`
- Modify: `modules/providers/datacat/datacat-browse.css`

- [ ] **Step 1: Import save helpers**

In `modules/providers/datacat/datacat-browse.js`, extend the import from `datacat-api.js` with:

```js
    fetchDatacatYoursStatus,
    setDatacatYoursSaved,
```

- [ ] **Step 2: Add save-state caches**

Near the existing DataCat state variables, add:

```js
const datacatYoursStateById = new Map();
const datacatYoursPendingIds = new Set();

function isDatacatYoursSyncEnabled() {
    return !!(getSetting('datacatAccountToken') && getSetting('datacatSyncYours') !== false);
}

function normalizeDatacatCollected(hit) {
    return hit?.isCollected === true || hit?.viewer_is_collected === true || hit?.is_collected === true;
}

function getDatacatYoursState(characterId, hit = null) {
    const id = String(characterId || '').trim();
    if (!id) return false;
    if (datacatYoursStateById.has(id)) return datacatYoursStateById.get(id) === true;
    return normalizeDatacatCollected(hit);
}

function setDatacatYoursState(characterId, saved) {
    const id = String(characterId || '').trim();
    if (!id) return;
    datacatYoursStateById.set(id, saved === true);
    for (const gridId of ['datacatGrid', 'datacatFollowingGrid']) {
        const grid = document.getElementById(gridId);
        const card = grid?.querySelector(`[data-datacat-id="${id}"]`);
        const btn = card?.querySelector('.datacat-yours-btn');
        if (!btn) continue;
        btn.classList.toggle('saved', saved === true);
        btn.title = saved ? 'Saved to DataCat Yours' : 'Save to DataCat Yours';
        btn.innerHTML = saved ? '<i class="fa-solid fa-star"></i>' : '<i class="fa-regular fa-star"></i>';
    }
    const modalBtn = document.getElementById('datacatYoursBtn');
    if (modalBtn?.dataset?.datacatId === id) {
        modalBtn.classList.toggle('saved', saved === true);
        modalBtn.innerHTML = saved ? '<i class="fa-solid fa-star"></i> Saved' : '<i class="fa-regular fa-star"></i> Save';
    }
}
```

- [ ] **Step 3: Render save button on cards**

In `createDatacatCard(hit)`, after `const cardClass = ...`, add:

```js
    const canSyncYours = isDatacatYoursSyncEnabled();
    const savedToYours = getDatacatYoursState(charId, hit);
    const yoursBtn = canSyncYours
        ? `<button type="button" class="datacat-yours-btn${savedToYours ? ' saved' : ''}" data-datacat-yours-id="${escapeHtml(String(charId))}" title="${savedToYours ? 'Saved to DataCat Yours' : 'Save to DataCat Yours'}">${savedToYours ? '<i class="fa-solid fa-star"></i>' : '<i class="fa-regular fa-star"></i>'}</button>`
        : '';
```

Then inside `.browse-card-image`, after `${nsfwBadge}`, render:

```js
                ${yoursBtn}
```

- [ ] **Step 4: Add modal save button**

In `renderModals()`, inside `.modal-controls` before `datacatOpenInBrowserBtn`, add:

```html
                    <button id="datacatYoursBtn" class="action-btn secondary datacat-yours-modal-btn" title="Save to DataCat Yours" style="display: none;">
                        <i class="fa-regular fa-star"></i> Save
                    </button>
```

In `openPreviewModal(hit)`, after `const openBtn = ...`, add:

```js
    const yoursBtn = document.getElementById('datacatYoursBtn');
    if (yoursBtn) {
        const canSyncYours = isDatacatYoursSyncEnabled();
        yoursBtn.style.display = canSyncYours ? '' : 'none';
        yoursBtn.dataset.datacatId = String(charId || '');
        yoursBtn.disabled = false;
        setDatacatYoursState(charId, getDatacatYoursState(charId, hit));
        if (canSyncYours) {
            fetchDatacatYoursStatus(charId).then(result => {
                if (result?.ok) setDatacatYoursState(charId, result.collected === true);
            }).catch(() => {});
        }
    }
```

- [ ] **Step 5: Add toggle function**

In `modules/providers/datacat/datacat-browse.js`, before `initDatacatView()`, add:

```js
async function toggleDatacatYours(characterId, hit = null) {
    const id = String(characterId || '').trim();
    if (!id) return;
    if (!isDatacatYoursSyncEnabled()) {
        showToast('Sign in to DataCat in Settings to sync Yours', 'warning');
        return;
    }
    if (datacatYoursPendingIds.has(id)) return;
    const wasSaved = getDatacatYoursState(id, hit);
    const nextSaved = !wasSaved;
    datacatYoursPendingIds.add(id);
    setDatacatYoursState(id, nextSaved);
    try {
        const result = await setDatacatYoursSaved(id, nextSaved);
        if (!result?.ok) throw new Error(result?.error || 'DataCat save failed');
        setDatacatYoursState(id, result.collected === true);
        showToast(result.collected ? 'Saved to DataCat Yours' : 'Removed from DataCat Yours', 'success');
    } catch (err) {
        setDatacatYoursState(id, wasSaved);
        showToast(`DataCat Yours sync failed: ${err.message}`, 'error');
    } finally {
        datacatYoursPendingIds.delete(id);
    }
}
```

- [ ] **Step 6: Wire card and modal click handlers**

In the main grid delegated click handler, before creator-link handling, add:

```js
            const yoursBtn = e.target.closest('.datacat-yours-btn');
            if (yoursBtn) {
                e.preventDefault();
                e.stopPropagation();
                const charId = yoursBtn.dataset.datacatYoursId;
                const hit = charId ? datacatCharacters.find(c => String(getCharId(c)) === charId) : null;
                toggleDatacatYours(charId, hit);
                return;
            }
```

In `_handleFollowingCardClick(e)`, add the same block at the top, but search `datacatFollowingCharacters`.

In `ensureModalEventsAttached()`, add:

```js
    on('datacatYoursBtn', 'click', () => {
        const btn = document.getElementById('datacatYoursBtn');
        const charId = btn?.dataset?.datacatId;
        const hit = charId ? (
            datacatCharacters.find(c => String(getCharId(c)) === charId)
            || datacatFollowingCharacters.find(c => String(getCharId(c)) === charId)
            || datacatSelectedChar
        ) : null;
        toggleDatacatYours(charId, hit);
    });
```

- [ ] **Step 7: Add save button CSS**

In `modules/providers/datacat/datacat-browse.css`, add:

```css
.datacat-yours-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 3;
    width: 30px;
    height: 30px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.58);
    color: rgba(255, 255, 255, 0.85);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 0.15s ease, color 0.15s ease, background 0.15s ease;
}

.datacat-yours-btn:hover {
    transform: scale(1.05);
    background: rgba(0, 0, 0, 0.78);
}

.datacat-yours-btn.saved,
.datacat-yours-modal-btn.saved {
    color: var(--cl-favorite-gold, #ffd43b);
}
```

- [ ] **Step 8: Syntax check browse modules**

Run:

```bash
node --check modules/providers/datacat/datacat-api.js
node --check modules/providers/datacat/datacat-browse.js
```

Expected: both commands exit 0.

- [ ] **Step 9: Commit browse save sync**

```bash
git add modules/providers/datacat/datacat-api.js modules/providers/datacat/datacat-browse.js modules/providers/datacat/datacat-browse.css
git commit -m "feat: sync datacat yours saves"
```

---

### Task 6: Extraction Account Preference

**Files:**
- Modify: `modules/providers/datacat/datacat-api.js`
- Modify: `modules/providers/datacat/datacat-browse.js`
- Modify: `modules/providers/datacat/datacat-provider.js`

- [ ] **Step 1: Pass account preference through `submitExtraction()`**

Change the signature in `modules/providers/datacat/datacat-api.js`:

```js
export async function submitExtraction(janitorUrl, { publicFeed = true, alwaysReextract = false, useAccount = true } = {}) {
```

Change the request body:

```js
const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/dc-extract`, 'POST', { url: janitorUrl, publicFeed, alwaysReextract, useAccount });
```

- [ ] **Step 2: Use settings in browse extraction calls**

In `modules/providers/datacat/datacat-browse.js`, replace each `submitExtraction(..., { publicFeed: ... })` call with:

```js
submitExtraction(sourceUrl, {
    publicFeed: getSetting('datacatPublicFeed') === true,
    useAccount: getSetting('datacatUseAccountForExtraction') !== false,
})
```

For calls that already pass `alwaysReextract`, preserve it:

```js
submitExtraction(upstreamUrl, {
    publicFeed,
    alwaysReextract: true,
    useAccount: CoreAPI.getSetting('datacatUseAccountForExtraction') !== false,
})
```

- [ ] **Step 3: Use settings in provider refresh re-extraction**

In `modules/providers/datacat/datacat-provider.js`, update `refreshRemoteData()`'s `submitExtraction` call to include:

```js
useAccount: CoreAPI.getSetting('datacatUseAccountForExtraction') !== false,
```

- [ ] **Step 4: Syntax check extraction callers**

Run:

```bash
node --check modules/providers/datacat/datacat-api.js
node --check modules/providers/datacat/datacat-browse.js
node --check modules/providers/datacat/datacat-provider.js
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit extraction preference**

```bash
git add modules/providers/datacat/datacat-api.js modules/providers/datacat/datacat-browse.js modules/providers/datacat/datacat-provider.js
git commit -m "feat: use datacat account for extraction"
```

---

### Task 7: Documentation and Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update DataCat README docs**

In the DataCat section of `README.md`, add this paragraph after the extraction explanation:

```markdown
**Account sync (optional):** Sign into DataCat in Settings > Online > DataCat to use your DataCat account session for extraction and to sync save/unsave actions from Character Library to DataCat's **Yours** collection. Anonymous browsing and extraction still work without login. Vault uploads and Cart mirroring are not managed by Character Library yet.
```

- [ ] **Step 2: Run all available checks**

Run:

```bash
node --test tests/datacat-utils.test.mjs
node --check extras/cl-helper/datacat-utils.js
node --check extras/cl-helper/index.js
node --check modules/providers/datacat/datacat-api.js
node --check modules/providers/datacat/datacat-provider.js
node --check modules/providers/datacat/datacat-browse.js
node --check app/library.js
```

Expected: all commands exit 0.

- [ ] **Step 3: Manual desktop verification**

With SillyTavern running and `extras/cl-helper` installed:

1. Open Character Library on desktop.
2. Enable DataCat if needed.
3. Confirm anonymous browse still loads cards before login.
4. Go to Settings > Online > DataCat.
5. Login with a DataCat email/password account.
6. Confirm status shows the DataCat username or email.
7. Open a DataCat card and click Save.
8. Refresh `https://datacat.run/characters/mine` in a desktop browser.
9. Confirm the saved character appears in DataCat "Yours".
10. Click Save again in CL to unsave.
11. Refresh DataCat "Yours" and confirm the character is removed.

Expected: all steps pass.

- [ ] **Step 4: Manual mobile verification**

With the same branch installed:

1. Open Character Library on mobile.
2. Confirm DataCat browse cards render without layout overlap from the star button.
3. Login from Settings > Online > DataCat.
4. Save and unsave a card from the grid.
5. Save and unsave a card from the preview modal.
6. Confirm toasts are visible and the button state changes immediately.
7. Refresh DataCat mobile web "Yours" and confirm the account sync.

Expected: all steps pass.

- [ ] **Step 5: Commit docs**

```bash
git add README.md
git commit -m "docs: document datacat account sync"
```

- [ ] **Step 6: Final git status**

Run: `git status --short --branch`

Expected: branch `codex/datacat-account-sync` has no modified tracked files. The existing `.codex-remote-attachments/` screenshot folder may remain untracked and should not be committed.

---

## Self-Review Notes

- Spec coverage: login, token restore, account extraction, remote "Yours" save/unsave, signed-out states, tests, and Vault/Cart non-goals are covered.
- Endpoint confidence: DataCat's live app uses `/api/auth/login`, `/api/auth/verify`, `/api/auth/logout`, `/api/characters/{id}/collect`, and `/api/characters/{id}/folders`. This plan uses those exact routes through `cl-helper`.
- Type consistency: account token settings are `datacatAccountToken`, device token setting is `datacatDeviceToken`, extraction preference is `datacatUseAccountForExtraction`, and save sync preference is `datacatSyncYours`.
- Scope control: DataCat folders beyond membership status, Vault, Cart, Google sign-in, and upload flows are excluded from this implementation plan.
