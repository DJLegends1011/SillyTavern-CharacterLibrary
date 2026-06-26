# DataCat Account Sync Design

## Summary

Add optional DataCat account support to the existing DataCat provider without changing the current anonymous "just works" flow. A signed-in user can extract characters under their DataCat account and use Character Library controls to save or unsave DataCat characters in the remote DataCat "Yours" collection.

This first branch intentionally excludes DataCat Vault uploads/private storage and Cart mirroring. Those surfaces are visible in the DataCat web app, but they are larger workflows and should stay separate from the account sync foundation.

## Goals

- Keep anonymous DataCat browsing and extraction working exactly as it does today.
- Add a DataCat account login path that stores only reusable DataCat tokens, not passwords.
- Let extraction requests use the authenticated DataCat session when available, so extracted characters appear under the user's account context.
- Treat DataCat "Yours" as the remote favorite/save collection for Character Library.
- Add CL-side save/unsave controls for DataCat cards and previews that sync to the DataCat account.
- Surface clear signed-out, signed-in, unavailable, and sync-error states.

## Non-Goals

- Do not implement DataCat Vault upload/private storage in this branch.
- Do not implement DataCat Cart in this branch.
- Do not replace SillyTavern's local favorite system or global favorites filter.
- Do not require a DataCat login for users who only want anonymous browsing/importing.
- Do not store DataCat account passwords in CL settings, localStorage, or cl-helper memory.

## Current State

The DataCat provider currently creates an anonymous session through `cl-helper`:

- `extras/cl-helper/index.js` calls `POST https://datacat.run/api/liberator/identify` with a generated device token.
- DataCat returns a `sessionToken`.
- `cl-helper` stores that token in memory as `dcSessionToken`.
- `app/library.js` also persists the token as `datacatToken` in CL settings and localStorage backup.
- DataCat API calls go through `cl-helper` as `X-Session-Token`.
- Extraction uses `POST /api/character/smart-extract-v2` or `POST /api/saucepan-extract/run` with the stored session token.

The live DataCat app shows a richer identity model:

- Anonymous device token: `liberator_device_token`.
- Account session token: `liberator_session_token`.
- Auth endpoints: `/api/auth/login`, `/api/auth/register`, `/api/auth/google-signin`, `/api/auth/verify`, `/api/auth/logout`.
- User context endpoints: `/api/liberator/identify`, `/api/liberator/me`, `/api/users`.
- Collection/folder endpoints: `/api/user-folders`, `/api/user-folders/{folderId}/items/{characterId}`, `/api/characters/{characterId}/folders`.

Screenshots confirm DataCat's account scopes are "Public", "Yours", "Vault", and "Cart". For this branch, "Yours" is the remote favorite/save target.

## Architecture

### cl-helper

Add account-aware DataCat session state alongside the existing anonymous token:

- `dcAnonymousToken`: current anonymous session token, equivalent to today's `dcSessionToken`.
- `dcDeviceToken`: the active anonymous/device token used for identity and account merge.
- `dcAccountToken`: authenticated account session token, when signed in.
- `dcAccountUser`: verified account profile summary, when available.
- `dcUseAccount`: derived from whether `dcAccountToken` validates.

Add new routes:

- `POST /dc-auth-login`: accepts `{ email, password }`, forwards to `https://datacat.run/api/auth/login`, includes the current device token as `anonToken` when present, stores returned `session.token`, stores returned device token if DataCat provides one, returns a sanitized account summary.
- `POST /dc-auth-logout`: clears account token/profile from cl-helper and calls DataCat logout when possible.
- `GET /dc-auth-status`: validates the account token with `/api/auth/verify` and returns signed-in state.
- `GET /dc-me`: fetches `/api/liberator/me` using account-aware headers.
- `GET /dc-yours`: fetches account-owned/saved DataCat characters using the verified "Yours" endpoint path.
- `POST /dc-yours/:characterId`: saves a DataCat character into "Yours".
- `DELETE /dc-yours/:characterId`: removes a DataCat character from "Yours".
- `GET /dc-yours/:characterId/status`: checks whether a character is already in "Yours".

The implementation must verify the exact "Yours" folder semantics before coding the save/delete routes. Current evidence points to DataCat user folders and character folder membership, but the endpoint contract should be confirmed against a real account session during implementation.

Existing `/dc-init`, `/dc-validate`, `/dc-clear-token`, `/dc-extract`, and `/dc-proxy/*` continue to exist. Account-aware requests choose headers in this order:

1. If an account token is valid, send `X-Session-Token: dcAccountToken` plus `X-Device-Token: dcDeviceToken` when available.
2. Otherwise, use the anonymous token exactly as today.

### Frontend API Utilities

Extend `modules/providers/datacat/datacat-api.js` with account helpers:

- `loginDatacatAccount(email, password)`.
- `logoutDatacatAccount()`.
- `validateDatacatAccount()`.
- `fetchDatacatMe()`.
- `fetchDatacatYoursPage(opts)`.
- `fetchDatacatSaveStatus(characterId)`.
- `saveDatacatCharacter(characterId)`.
- `unsaveDatacatCharacter(characterId)`.

Keep anonymous session utilities intact. `submitExtraction()` gains an option such as `{ useAccount: true }`, defaulting to true when a valid account session exists and false otherwise.

### Settings

Add a DataCat Account section under Settings > Online > DataCat:

- Signed-out state: email/password fields, Login button, link to DataCat register page.
- Signed-in state: username/email, Validate, Logout.
- Toggle: "Use DataCat account for extraction" default true when signed in.
- Toggle: "Sync DataCat saves to Yours" default true when signed in.

Password fields are transient. CL never persists the password. The account token is sensitive and should be treated like other provider tokens in CL settings.

### Browse UI

Add DataCat remote save controls:

- Card-level save indicator/action when DataCat account sync is enabled.
- Preview modal save/unsave button.
- Optional "Yours" view or filter in the DataCat provider when signed in.

States:

- Signed out: show save button disabled or prompt "Sign in to sync with DataCat".
- Unknown save state: render a neutral loading/syncing indicator.
- Saved: show filled/starred or "Yours" state.
- Unsaved: show empty save action.
- Sync failed: rollback optimistic state and show a toast.

## Data Flow

### Login

1. User enters DataCat email/password in CL settings.
2. Frontend calls `POST /dc-auth-login`.
3. `cl-helper` forwards the credentials to DataCat `/api/auth/login`.
4. `cl-helper` stores only returned token/device/user metadata.
5. Frontend persists `datacatAccountToken`, `datacatDeviceToken`, and summary metadata in CL settings.
6. Frontend refreshes DataCat session status and save states.

### Extraction

1. User extracts a JanitorAI or Saucepan character as today.
2. `submitExtraction()` includes the account-use preference.
3. `cl-helper` sends account headers when a valid account session exists.
4. DataCat extraction should associate the result with the account context.
5. If account validation fails, CL falls back to anonymous extraction only when the user has not explicitly required account extraction.

### Save to Yours

1. User clicks save/favorite on a DataCat card or preview.
2. Frontend optimistically marks the item as saved.
3. `cl-helper` calls the verified DataCat "Yours" collection endpoint.
4. On success, CL keeps the saved state and updates any "Yours" view cache.
5. On failure, CL rolls back and shows a specific error.

## Error Handling

- Missing cl-helper: account controls show "cl-helper required".
- Invalid account token: clear account state after confirmation or mark signed out with a re-login prompt.
- DataCat API shape changed: show "DataCat account sync unavailable" and keep anonymous provider behavior working.
- Account extraction fails but anonymous works: tell the user whether CL fell back or stopped, based on their setting.
- Save/unsave conflict: refetch membership state and render the server truth.
- Network timeout: keep UI usable, retry status checks on next provider activation.

## Testing

Manual verification:

- Existing anonymous DataCat browse still initializes and loads cards.
- Existing anonymous extraction still works with no account token.
- Login validates with a DataCat email/password account and does not persist the password.
- Logout clears account state and returns to anonymous behavior.
- Account extraction appears in DataCat "Yours" for the signed-in account.
- Save/unsave from CL updates DataCat "Yours" after refreshing datacat.run.
- Signed-out save action prompts for login instead of failing silently.
- Invalid/expired account token is detected and recoverable.

Automated or scripted checks where practical:

- Unit-like tests for account header selection in `cl-helper`.
- Route validation tests that reject malformed character IDs and non-DataCat proxy targets.
- Frontend helper tests for save-state normalization and optimistic rollback.
- Syntax checks for edited JavaScript files.

## Risks

- DataCat endpoints are not formally documented and may change without notice.
- "Yours" appears to be implemented through folders/collections, but the exact default folder behavior must be confirmed during implementation.
- Account session tokens are sensitive. The feature should avoid logging token values and should keep password handling transient.
- Google sign-in exists on DataCat, but the first branch should focus on email/password token login because it is compatible with `cl-helper` and does not require embedding Firebase auth.

## Acceptance Criteria

- Users who never sign in see no regression in DataCat browsing/import/extraction.
- A signed-in DataCat account can be validated from CL settings.
- Account extraction uses the account session by default and can be disabled.
- A DataCat card can be saved and unsaved from CL, and the change appears in DataCat's "Yours" account view.
- Account-only UI communicates when login or cl-helper is required.
- Vault and Cart are not exposed as half-finished features in this branch.
