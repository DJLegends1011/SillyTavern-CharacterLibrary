# DataCat login: BotBooru-style parity

**Date:** 2026-06-16
**Branch:** `codex/datacat-account-sync` (then merge to `aio-v6.3.0`)
**Status:** Approved design

## Goal

Replace DataCat's Settings-centric account login (which includes a "Sign in with
Google" path) with a BotBooru-style flow: an in-browse toolbar auth button that
opens a login modal, hidden once authenticated. Remove the Google sign-in method
entirely. Because removing Google strands users who created their DataCat account
via Google (no email/password), the **manual account-token paste** becomes their
primary entry point and must be visible in both the modal and Settings.

## Reference implementation

BotBooru (`modules/providers/botbooru/botbooru-browse.js`):
- Toolbar auth button `botbooruAuthBtn` (icon-only) → opens `botbooruLoginModal`.
- Modal: username/password form, an "Or paste a token manually" `<details>`
  fallback, Login/Logout buttons, and a "Register" external link.
- `updateAuthButtonState()` toggles button visibility/appearance by auth state.
- `loginToBotbooru()` POSTs to cl-helper `/botbooru-login`; manual path saves a
  pasted token; both re-validate and refresh UI.

## Scope

### Remove (Google login method)
- `app/library.html`: `datacatAccountGoogleLoginBtn` button.
- `app/library.js`: the Google button handler and its show/hide lines in
  `renderDatacatAccountStatus`.
- `modules/providers/datacat/datacat-api.js`: `loginDatacatAccountWithGoogle`,
  `resolveDatacatGoogleAuthLocalhostUrl`, `getDatacatGoogleAuthOriginIssue`,
  `buildDataCatGoogleSigninBody` (and the `/dc-auth-google` caller).
- `modules/providers/datacat/datacat-provider.js`: `window.datacatLoginAccountWithGoogle`,
  `window.datacatResolveGoogleAuthLocalhostUrl`, `window.datacatGetGoogleAuthOriginIssue`,
  and the corresponding imports.
- `extras/cl-helper/index.js`: the `/dc-auth-google` route.
- `tests/datacat-utils.test.mjs`: the `buildDataCatGoogleSigninBody`,
  `resolveDatacatGoogleAuthLocalhostUrl`, and `getDatacatGoogleAuthOriginIssue`
  describe blocks (and their now-unused imports).

### Add (in-browse, BotBooru-style) — in `datacat-browse.js`
- A toolbar **auth button** in the DataCat browse view, mirroring `botbooruAuthBtn`
  placement/markup.
- A **login modal** with:
  - **Email/password** form → existing `loginDatacatAccount` (`/dc-auth-login`).
  - **"Or paste your account token"** `<details>` (account token only) reusing the
    existing token-connect logic. Includes a note: *"Made your DataCat account with
    Google? You can't use a password — paste your account token here instead,"* plus
    the existing "open DataCat to get your token" helper link.
  - **Login / Logout** buttons and a **"Register on DataCat"** external link.
  - Intro copy: *"Sign in to sync your DataCat 'Yours' saves."*
- `updateDatacatAuthButtonState()` to hide/show the button by auth state, called
  after login, logout, token-connect, and on init.

### Settings panel (slimmed) — `library.html` + `library.js`
- **Keep:** status badge, **logout**, and the **manual account-token field**
  (kept visible specifically for Google-account users).
- **Remove:** the Google button **and** the Settings email/password inputs +
  in-settings login button — email/password login now lives only in the in-browse
  modal. Settings becomes a status + token-fallback + logout surface only.

## Auth state & data flow
- Auth state is read from `getSetting('datacatAccountToken')` / `datacatAccountUser`
  (unchanged). Login/token-connect set these; logout clears them.
- The new modal and the existing Settings panel both reflect and mutate the same
  settings keys, so a single `updateDatacatAuthButtonState()` + the existing
  `renderDatacatAccountStatus()` keep both surfaces in sync.

## Error handling
- Reuse BotBooru's patterns: inline status line in the modal for failures
  (cl-helper missing → guide to token paste; bad credentials → show server error),
  spinner on the login button during the request, toast on success.

## Testing
- Remove the 3 Google-related test blocks.
- Existing `isDatacatYoursCollectableHit` / `isDatacatYoursSavedHit` /
  `buildDatacatYoursCharactersPath` tests remain green.
- Headless test run still requires the browser-global shim via `--import`
  (pre-existing; see memory note).
- Manual/live verification on **mobile** (primary usage) and desktop: button
  appears when signed out, opens modal, email/password login works, token paste
  works, button hides when signed in, logout restores it.

## Rollout
1. Implement + test on `codex/datacat-account-sync`; commit; push.
2. Merge into `aio-v6.3.0` with a `[datacat-account-sync]` prefixed `--no-ff`
   merge; push.

## Out of scope
- No change to the `/dc-auth-login` or token-connect backend behavior.
- No change to "Yours" sync logic or the collectable gate.
