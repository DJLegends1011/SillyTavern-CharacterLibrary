# DataCat Login BotBooru-Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DataCat's Settings-based account login (incl. "Sign in with Google") with a BotBooru-style in-browse toolbar button + login modal (email/password + manual account-token fallback), removing Google sign-in everywhere.

**Architecture:** Mirror BotBooru's auth UX (`botbooruAuthBtn` + `botbooruLoginModal` + `updateAuthButtonState()`) inside the DataCat browse view. Strip the Google method from the backend (cl-helper route), api/provider layers, Settings UI, and tests. Settings keeps only status + manual token + logout.

**Tech Stack:** Vanilla JS ES modules, SillyTavern extension; Node `node:test` for the pure-function units; cl-helper Express plugin (`extras/cl-helper`).

**Spec:** `docs/superpowers/specs/2026-06-16-datacat-login-botbooru-parity-design.md`

**Branch:** `codex/datacat-account-sync` → then merge to `aio-v6.3.0`.

---

## Testing notes (read first)

- The DataCat unit tests import provider modules that touch `window`/`document` at top level. Run headless with the browser-global shim:
  `node --import "file:///C:/tmp/dcshim.mjs" --test "<repo>/tests/datacat-utils.test.mjs"`
  (The shim defines `window`/`document` stubs; do NOT set `globalThis.navigator` — read-only in Node 24.)
- UI tasks (modal/button/wiring) are not unit-testable headless; they use **live verification on mobile and desktop** (user primarily uses mobile).
- `<repo>` = `C:/Users/DJLegnds/Downloads/SillyTavern/extension/SillyTavern-CharacterLibrary`. Run git with `git -C "<repo>"`.

---

## File Structure

- `extras/cl-helper/index.js` — remove `/dc-auth-google` route + `buildDataCatGoogleSigninBody` import. Keep `/dc-auth-login`.
- `extras/cl-helper/datacat-utils.js` — remove `buildDataCatGoogleSigninBody`.
- `modules/providers/datacat/datacat-api.js` — remove `loginDatacatAccountWithGoogle`, `resolveDatacatGoogleAuthLocalhostUrl`, `getDatacatGoogleAuthOriginIssue`.
- `modules/providers/datacat/datacat-provider.js` — remove the 3 Google `window.*` exports + their imports.
- `app/library.html` — remove Google button, Settings email/password rows, in-settings Login button. Add nothing (modal lives in datacat-browse.js).
- `app/library.js` — remove Google handler + email/password refs/handlers; keep token-connect/logout/status/open-login.
- `modules/providers/datacat/datacat-browse.js` — ADD: toolbar auth button, login modal markup, event wiring, `updateDatacatAuthButtonState()`.
- `tests/datacat-utils.test.mjs` — remove the 3 Google describe blocks + unused imports.

---

## Task 1: Remove Google from cl-helper backend + datacat-utils + test

**Files:**
- Modify: `extras/cl-helper/index.js` (route `/dc-auth-google` ~line 1169; import ~line 18)
- Modify: `extras/cl-helper/datacat-utils.js` (`buildDataCatGoogleSigninBody`)
- Test: `tests/datacat-utils.test.mjs` (`buildDataCatGoogleSigninBody` describe block ~lines 106-121)

- [ ] **Step 1: Remove the Google test block (failing-state first)**

In `tests/datacat-utils.test.mjs`, delete the entire `describe('buildDataCatGoogleSigninBody', ...)` block (the `it('builds the DataCat Google sign-in payload...')` and `it('rejects invalid Firebase ID tokens')` cases), and remove `buildDataCatGoogleSigninBody` from the import list at the top.

- [ ] **Step 2: Run suite — expect FAIL (import of removed symbol not yet done / still referenced)**

Run: `node --import "file:///C:/tmp/dcshim.mjs" --test "<repo>/tests/datacat-utils.test.mjs"`
Expected: FAIL — `datacat-utils.js` still exports the symbol but `index.js` import will break once removed; confirm the suite still loads, then proceed. (If green here, that's fine — the removal below is the real change.)

- [ ] **Step 3: Remove the function and its caller**

- In `extras/cl-helper/datacat-utils.js`, delete the `export function buildDataCatGoogleSigninBody(...)` definition.
- In `extras/cl-helper/index.js`, remove `buildDataCatGoogleSigninBody,` from the import block (~line 18) and delete the whole `router.post('/dc-auth-google', ...)` handler (from `router.post('/dc-auth-google'` through its closing `});`).

- [ ] **Step 4: Sanity-check cl-helper parses**

Run: `node -e "require('<repo>/extras/cl-helper/index.js')"` (expect no syntax error; module may warn about missing ST context — that's fine, we only care about parse).
If it executes router setup lazily, instead run: `node --check "<repo>/extras/cl-helper/index.js"` and `node --check "<repo>/extras/cl-helper/datacat-utils.js"`. Expected: no output (parse OK).

- [ ] **Step 5: Run suite — expect PASS**

Run: `node --import "file:///C:/tmp/dcshim.mjs" --test "<repo>/tests/datacat-utils.test.mjs"`
Expected: PASS (Google test gone; all remaining pass).

- [ ] **Step 6: Commit**

```bash
git -C "<repo>" add extras/cl-helper/index.js extras/cl-helper/datacat-utils.js tests/datacat-utils.test.mjs
git -C "<repo>" commit -m "refactor(datacat): drop Google sign-in backend route + helper"
```

---

## Task 2: Remove Google from datacat-api.js + its tests

**Files:**
- Modify: `modules/providers/datacat/datacat-api.js` (`loginDatacatAccountWithGoogle` ~347-349; `resolveDatacatGoogleAuthLocalhostUrl` ~110-121; `getDatacatGoogleAuthOriginIssue` ~123-135; `isDatacatLoopbackHost` helper ~106-108 if now unused)
- Test: `tests/datacat-utils.test.mjs` (`resolveDatacatGoogleAuthLocalhostUrl` + `getDatacatGoogleAuthOriginIssue` describe blocks ~123-163)

- [ ] **Step 1: Remove the two Google describe blocks + imports**

In `tests/datacat-utils.test.mjs`, delete `describe('resolveDatacatGoogleAuthLocalhostUrl', ...)` and `describe('getDatacatGoogleAuthOriginIssue', ...)`, and remove `getDatacatGoogleAuthOriginIssue` and `resolveDatacatGoogleAuthLocalhostUrl` from the import from `datacat-api.js`.

- [ ] **Step 2: Remove the functions from datacat-api.js**

Delete `export async function loginDatacatAccountWithGoogle(...)`, `export function resolveDatacatGoogleAuthLocalhostUrl(...)`, and `export function getDatacatGoogleAuthOriginIssue(...)`. Also delete the `isDatacatLoopbackHost` helper IF it has no remaining references (grep first: `grep -n isDatacatLoopbackHost modules/providers/datacat/datacat-api.js` — if only the two deleted functions used it, remove it).

- [ ] **Step 3: Grep for stale references**

Run: `grep -rn "loginDatacatAccountWithGoogle\|resolveDatacatGoogleAuthLocalhostUrl\|getDatacatGoogleAuthOriginIssue" "<repo>/modules" "<repo>/app"`
Expected: only matches remaining are in `datacat-provider.js` (handled in Task 3) and `app/library.js` (handled in Task 4). No others.

- [ ] **Step 4: Run suite — expect PASS**

Run: `node --import "file:///C:/tmp/dcshim.mjs" --test "<repo>/tests/datacat-utils.test.mjs"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "<repo>" add modules/providers/datacat/datacat-api.js tests/datacat-utils.test.mjs
git -C "<repo>" commit -m "refactor(datacat): remove Google auth api functions + tests"
```

---

## Task 3: Remove Google from datacat-provider.js

**Files:**
- Modify: `modules/providers/datacat/datacat-provider.js` (imports ~19-20, 37; window exports ~574-581)

- [ ] **Step 1: Remove window exports**

Delete these lines:
```js
window.datacatLoginAccountWithGoogle = async (firebaseIdToken) => {
    const pluginOk = await checkDcPluginAvailable();
    if (!pluginOk) return { ok: false, error: 'cl-helper plugin not available' };
    return loginDatacatAccountWithGoogle(firebaseIdToken);
};

window.datacatResolveGoogleAuthLocalhostUrl = resolveDatacatGoogleAuthLocalhostUrl;
window.datacatGetGoogleAuthOriginIssue = getDatacatGoogleAuthOriginIssue;
```

- [ ] **Step 2: Remove the now-unused imports**

In the import block from `./datacat-api.js`, remove `loginDatacatAccountWithGoogle`, `resolveDatacatGoogleAuthLocalhostUrl`, and `getDatacatGoogleAuthOriginIssue`.

- [ ] **Step 3: Parse check**

Run: `node --check "<repo>/modules/providers/datacat/datacat-provider.js"`
Expected: no output (OK).

- [ ] **Step 4: Commit**

```bash
git -C "<repo>" add modules/providers/datacat/datacat-provider.js
git -C "<repo>" commit -m "refactor(datacat): drop Google window exports from provider"
```

---

## Task 4: Slim the Settings account panel (remove Google + email/password)

**Files:**
- Modify: `app/library.html` (account-sync group ~2600-2644)
- Modify: `app/library.js` (refs ~1657-1665; handlers/status ~3736-3900)

- [ ] **Step 1: Edit library.html**

In the `Account Sync` settings-group, remove these elements:
- the Email `settings-row` (`settingsDatacatAccountEmail`)
- the Password `settings-row` (`settingsDatacatAccountPassword`)
- the `datacatAccountLoginBtn` button
- the `datacatAccountGoogleLoginBtn` button

Keep: `datacatAccountStatus`, the Account Token row (`settingsDatacatAccountToken`), `datacatAccountTokenConnectBtn`, `datacatAccountOpenLoginBtn`, `datacatAccountLogoutBtn`. Add a short helper line under the token field:
```html
<p class="settings-hint">Made your DataCat account with Google? Paste your account token here to connect.</p>
```

- [ ] **Step 2: Edit library.js — remove dead refs/handlers**

- Remove the `datacatAccountEmailInput`, `datacatAccountPasswordInput`, `datacatAccountLoginBtn`, `datacatAccountGoogleLoginBtn` `getElementById` lookups (~1658-1662).
- Remove the `datacatAccountLoginBtn.onclick = ...` handler block (~3883+) and any `datacatAccountGoogleLoginBtn.onclick` handler.
- In `renderDatacatAccountStatus`, remove every `datacatAccountLoginBtn` / `datacatAccountGoogleLoginBtn` / `datacatAccountEmailInput` / `datacatAccountPasswordInput` reference (the show/hide lines ~3744-3769 and the clearing ~3439-3440).
- Keep token-connect, logout, open-login, and status logic intact.

- [ ] **Step 3: Grep for stale references**

Run: `grep -rn "datacatAccountGoogleLoginBtn\|datacatAccountLoginBtn\|settingsDatacatAccountEmail\|settingsDatacatAccountPassword" "<repo>/app"`
Expected: no matches.

- [ ] **Step 4: Live check (desktop)**

Load the extension, open Settings → DataCat → Account Sync. Expected: no Email/Password/Google/Login controls; status badge, Account Token field + Connect, Open DataCat Login, Logout all present and functional (token connect still works).

- [ ] **Step 5: Commit**

```bash
git -C "<repo>" add app/library.html app/library.js
git -C "<repo>" commit -m "refactor(datacat): slim Settings account panel (remove Google + email/password)"
```

---

## Task 5: Add the in-browse auth button + state toggle

**Files:**
- Modify: `modules/providers/datacat/datacat-browse.js` (controls/toolbar render — the same bar holding the sort + tags buttons; init/wiring near `ensureModalEventsAttached`)

- [ ] **Step 1: Add the auth button to the toolbar render**

In the DatacatBrowseView controls/toolbar markup (mirror where BotBooru renders `botbooruAuthBtn`), add:
```html
<button id="datacatAuthBtn" class="glass-btn icon-only" title="DataCat account login">
    <i class="fa-solid fa-user-lock"></i>
</button>
```
Place it alongside the existing DataCat toolbar buttons (e.g., next to the sort/tags controls).

- [ ] **Step 2: Add `updateDatacatAuthButtonState()`**

Add near the other DataCat browse helpers (mirror BotBooru's `updateAuthButtonState`):
```js
function updateDatacatAuthButtonState() {
    const btn = document.getElementById('datacatAuthBtn');
    if (!btn) return;
    btn.classList.toggle('hidden', !!getSetting('datacatAccountToken'));
}
```

- [ ] **Step 3: Call it on init**

Where the DataCat browse view initializes its toolbar/listeners, call `updateDatacatAuthButtonState()` once after render so the button is hidden if already signed in.

- [ ] **Step 4: Parse check**

Run: `node --check "<repo>/modules/providers/datacat/datacat-browse.js"`
Expected: no output (OK).

- [ ] **Step 5: Commit**

```bash
git -C "<repo>" add modules/providers/datacat/datacat-browse.js
git -C "<repo>" commit -m "feat(datacat): add in-browse auth button + state toggle"
```

---

## Task 6: Add the DataCat login modal markup

**Files:**
- Modify: `modules/providers/datacat/datacat-browse.js`

- [ ] **Step 1: Add a `_renderDatacatLoginModal()` returning this markup, and inject it into the DOM during init (append to body, mirror BotBooru modal injection)**

```html
<div id="datacatLoginModal" class="modal-overlay hidden">
  <div class="modal-glass browse-login-modal">
    <div class="modal-header">
      <h2><i class="fa-solid fa-user-lock"></i> DataCat Account</h2>
      <button class="close-btn" id="datacatLoginClose">&times;</button>
    </div>
    <div class="browse-login-body">
      <p class="browse-login-info">
        <i class="fa-solid fa-star" style="color: var(--accent);"></i>
        <strong>Sign in to sync your DataCat "Yours" saves.</strong> Browsing and importing work without an account.
      </p>

      <div class="browse-login-form" id="datacatLoginForm">
        <div class="form-group">
          <label for="datacatEmailInput">Email</label>
          <input type="email" id="datacatEmailInput" class="glass-input" placeholder="you@example.com" autocomplete="username">
        </div>
        <div class="form-group">
          <label for="datacatPasswordInput">Password</label>
          <input type="password" id="datacatPasswordInput" class="glass-input" placeholder="Password" autocomplete="current-password">
        </div>
        <div class="browse-login-status" id="datacatLoginStatus" style="display:none;"></div>
      </div>

      <details style="margin-top: 15px; background: rgba(255,255,255,0.03); padding: 10px; border-radius: var(--radius-lg);">
        <summary style="cursor: pointer; color: var(--accent);">
          <i class="fa-solid fa-key"></i> Or paste your account token
        </summary>
        <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--glass-border); font-size: 0.9rem; color: var(--text-secondary);">
          <p style="margin: 0 0 8px;"><strong>Made your DataCat account with Google?</strong> You can't use a password — paste your account token here instead. Use "Open DataCat" to grab it.</p>
          <input type="password" id="datacatManualTokenInput" class="glass-input" placeholder="Paste DataCat account token..." autocomplete="off">
          <div style="display:flex; gap:8px; margin-top:8px;">
            <button id="datacatSaveTokenBtn" class="action-btn secondary"><i class="fa-solid fa-save"></i> Save Token</button>
            <a href="https://datacat.run/" target="_blank" class="action-btn secondary"><i class="fa-solid fa-up-right-from-square"></i> Open DataCat</a>
          </div>
        </div>
      </details>

      <div class="browse-login-actions">
        <button id="datacatLoginBtn" class="action-btn primary"><i class="fa-solid fa-right-to-bracket"></i> Login</button>
        <button id="datacatLogoutBtn" class="action-btn secondary" style="display:none;"><i class="fa-solid fa-right-from-bracket"></i> Logout</button>
        <a href="https://datacat.run/" target="_blank" class="action-btn secondary"><i class="fa-solid fa-external-link"></i> Register on DataCat</a>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Register overlay (mirror BotBooru)**

After injecting, register with the overlay system like BotBooru does:
```js
window.registerOverlay?.({ id: 'datacatLoginModal', tier: 6, close: () => document.getElementById('datacatLoginModal')?.classList.add('hidden') });
```

- [ ] **Step 3: Parse check**

Run: `node --check "<repo>/modules/providers/datacat/datacat-browse.js"`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git -C "<repo>" add modules/providers/datacat/datacat-browse.js
git -C "<repo>" commit -m "feat(datacat): add login modal markup"
```

---

## Task 7: Wire the modal (open/close, login, token, logout)

**Files:**
- Modify: `modules/providers/datacat/datacat-browse.js`
- Uses existing: `loginDatacatAccount` (api), the settings keys `datacatAccountToken` / `datacatAccountUser`, and `restoreDatacatAccount` for token connect.

- [ ] **Step 1: Open/close wiring**

```js
function openDatacatLoginModal() {
    const modal = document.getElementById('datacatLoginModal');
    if (!modal) return;
    const hasToken = !!getSetting('datacatAccountToken');
    const logoutBtn = document.getElementById('datacatLogoutBtn');
    if (logoutBtn) logoutBtn.style.display = hasToken ? '' : 'none';
    setDatacatLoginStatus(hasToken ? 'Signed in.' : '', false);
    modal.classList.remove('hidden');
}
function setDatacatLoginStatus(msg, isError) {
    const el = document.getElementById('datacatLoginStatus');
    if (!el) return;
    if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = 'block';
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.toggle('success', !isError);
}
```
Wire: `datacatAuthBtn` click → `openDatacatLoginModal()`; `datacatLoginClose` click and overlay backdrop click → add `.hidden`.

- [ ] **Step 2: Email/password login**

```js
async function doDatacatLogin() {
    const email = document.getElementById('datacatEmailInput')?.value?.trim();
    const password = document.getElementById('datacatPasswordInput')?.value || '';
    if (!email || !password) { setDatacatLoginStatus('Enter email and password', true); return; }
    const btn = document.getElementById('datacatLoginBtn');
    const orig = btn?.innerHTML;
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Logging in...'; }
    try {
        const result = await window.datacatLoginAccount(email, password);
        if (!result?.ok && !result?.accountToken) { setDatacatLoginStatus(result?.error || 'Login failed', true); return; }
        if (result.accountToken) setSetting('datacatAccountToken', result.accountToken);
        if (result.user) setSetting('datacatAccountUser', result.user);
        const pw = document.getElementById('datacatPasswordInput'); if (pw) pw.value = '';
        updateDatacatAuthButtonState();
        window.renderDatacatAccountStatus?.({ valid: true, user: result.user });
        showToast('Signed in to DataCat!', 'success');
        document.getElementById('datacatLoginModal')?.classList.add('hidden');
    } catch (e) {
        setDatacatLoginStatus(`Login failed: ${e.message}`, true);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = orig; }
    }
}
```
Wire `datacatLoginBtn` click → `doDatacatLogin()`; Enter key in the form → same.

> NOTE for implementer: confirm the exact success shape of `window.datacatLoginAccount` / `loginDatacatAccount` (it returns the cl-helper `/dc-auth-login` JSON). Match the property names used by the existing Settings login handler in `library.js` (it already consumes this result around line 3878-3890) — reuse that exact success/branch logic rather than guessing field names.

- [ ] **Step 3: Manual account-token save (account token only)**

```js
async function saveDatacatManualToken() {
    const input = document.getElementById('datacatManualTokenInput');
    const token = input?.value?.trim();
    if (!token) { showToast('Paste your account token first', 'warning'); return; }
    setSetting('datacatAccountToken', token);
    const result = await window.datacatRestoreAccount?.();
    if (result?.valid || result?.ok) {
        if (result.user) setSetting('datacatAccountUser', result.user);
        updateDatacatAuthButtonState();
        window.renderDatacatAccountStatus?.({ valid: true, user: result.user });
        if (input) input.value = '';
        showToast('Token connected!', 'success');
        document.getElementById('datacatLoginModal')?.classList.add('hidden');
    } else {
        setSetting('datacatAccountToken', null);
        updateDatacatAuthButtonState();
        showToast('Token did not validate', 'error');
    }
}
```
Wire `datacatSaveTokenBtn` click → `saveDatacatManualToken()`.

> NOTE for implementer: reuse the existing token-connect path in `library.js` (`datacatAccountTokenConnectBtn` handler / `restoreDatacatAccount`) for the canonical validation logic; the above mirrors it. Keep one source of truth — if `library.js` exposes a reusable `window.datacat*` for connect, call that instead of re-implementing.

- [ ] **Step 4: Logout**

```js
async function doDatacatLogout() {
    setSetting('datacatAccountToken', null);
    setSetting('datacatAccountUser', null);
    await window.datacatLogoutAccount?.();   // if such a window helper exists; else clear settings only
    updateDatacatAuthButtonState();
    window.renderDatacatAccountStatus?.({ valid: false });
    showToast('Signed out of DataCat', 'success');
    document.getElementById('datacatLoginModal')?.classList.add('hidden');
}
```
Wire `datacatLogoutBtn` click → `doDatacatLogout()`.

> NOTE for implementer: check whether a `window.datacatLogoutAccount` / `/dc-auth-logout` wrapper exists (api has `dc-auth-logout`); if so call it. Otherwise clearing the settings keys + `renderDatacatAccountStatus` is sufficient and matches the Settings logout button behavior — reuse that handler's logic.

- [ ] **Step 5: Parse check**

Run: `node --check "<repo>/modules/providers/datacat/datacat-browse.js"`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git -C "<repo>" add modules/providers/datacat/datacat-browse.js
git -C "<repo>" commit -m "feat(datacat): wire login modal (email/password, token, logout)"
```

---

## Task 8: Live verification (desktop + mobile)

**No files. Manual QA against a running ST. Mobile is primary (see memory).**

- [ ] **Desktop:** DataCat browse shows the auth button when signed out → click opens modal → email/password login succeeds → button hides, Settings status flips to signed-in → reopen via Settings logout restores button. Token-paste path: paste a valid account token → connects, button hides. Invalid token → error, button stays.
- [ ] **Mobile (primary):** Repeat on a narrow viewport. Confirm the auth button is reachable in the mobile toolbar/kebab and the login modal renders as expected (not clipped, dismissable). If the button is hidden behind the mobile bottom-nav/kebab, surface it the same way other browse toolbar buttons are surfaced on mobile (`library-mobile.js`).
- [ ] Confirm no console errors referencing removed Google symbols.
- [ ] Confirm the "Yours" star sync still works after signing in via the new modal.

- [ ] **Commit any mobile-surface fixes**

```bash
git -C "<repo>" add -A
git -C "<repo>" commit -m "fix(datacat): surface auth button + modal on mobile"
```

---

## Task 9: Push branch + merge to AIO

- [ ] **Step 1: Push the feature branch**

```bash
git -C "<repo>" push origin codex/datacat-account-sync
```

- [ ] **Step 2: Merge into aio-v6.3.0 with prefixed --no-ff merge**

```bash
git -C "<repo>" checkout aio-v6.3.0
git -C "<repo>" merge --no-ff codex/datacat-account-sync -m "[datacat-account-sync] Merge BotBooru-style login (remove Google) into aio-v6.3.0"
```
Resolve any conflicts favoring the new design. Expected files in the merge: the ones listed in File Structure.

- [ ] **Step 3: Verify + push AIO**

Run: `node --import "file:///C:/tmp/dcshim.mjs" --test "<repo>/tests/datacat-utils.test.mjs"` (expect PASS), then:
```bash
git -C "<repo>" push origin aio-v6.3.0
git -C "<repo>" checkout codex/datacat-account-sync
```

---

## Self-Review notes

- **Spec coverage:** Google removal (Tasks 1-4), in-browse button+modal+state (Tasks 5-7), Settings slim-down keeping token fallback for Google users (Task 4 + modal copy in Task 6), mobile verification (Task 8), AIO rollout (Task 9). All spec sections covered.
- **Implementer judgment calls flagged inline** (exact `loginDatacatAccount` result shape, token-connect/logout reuse) point to the existing `library.js` handlers as the source of truth to avoid divergent logic.
- **TDD limited to pure functions** (Tasks 1-2) due to the headless DOM constraint; UI uses live verification per the testing notes.
