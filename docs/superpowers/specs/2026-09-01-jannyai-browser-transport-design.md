# JannyAI real-browser transport and account session design

**Date:** 2026-09-01

**Branch:** `codex/jannyai-account-sync`

**Status:** Approved in brainstorming; awaiting written-spec review

**Supersedes:** The JannyAI userscript-bridge transport described in the 2026-07-18 design and plan

## Summary

JannyAI browsing currently has two independent paths:

- public catalog search through `search.jannyai.com` and its MeiliSearch API; and
- character pages, public collections, bookmarks, and owned collections through
  Cloudflare-gated `jannyai.com` routes.

The MeiliSearch path still works and does not need a browser. The `jannyai.com`
paths no longer work reliably through the two userscript bridges or server-side
proxy fallbacks: Cloudflare returns HTTP 403 before Character Library can read
the page or parse a definition.

JannyAI will therefore adopt the proven real-browser transport used by the
vanilla JanitorAI provider. It will share JanitorAI's managed/external browser
process, persistent profile, and endpoint configuration while keeping
provider-specific UI, warm-page state, helper routes, request policies, account
tokens, cookies, diagnostics, and tests.

The Janny userscript transport will be removed completely. JannyAI will also
stop using the shared Janitor userscript bridge for character definitions. That
shared script remains available only for unrelated upstream consumers such as
DataCat.

## Goals

1. Fetch Cloudflare-gated JannyAI character pages through a real browser and
   restore complete definition and greeting imports.
2. Preserve direct MeiliSearch catalog browsing without introducing a browser
   dependency or extra latency there.
3. Preserve the existing bookmark and collection features while replacing
   their authentication and transport layers.
4. Prefer a complete chunked JannyAI Supabase session and support automatic
   access-token refresh.
5. Continue accepting a bare access JWT as a non-refreshable fallback.
6. Reuse the existing JanitorAI browser process and configuration without
   changing JanitorAI's public routes, settings UI, or provider behavior.
7. Fail closed: never import a card whose definition or greeting is empty
   because a challenge, 403, or parser failure was mistaken for character data.
8. Remove active code, UI, help text, diagnostics, and tests for the obsolete
   Janny userscript transport.

## Non-goals

- Routing `search.jannyai.com` MeiliSearch requests through the browser.
- Refactoring JanitorAI onto new route names or a generic provider gateway.
- Adding JannyAI username/password or social-login automation in this version.
- Keeping a userscript fallback for desktop, remote, or mobile users. Termux
  users use the same managed/external browser setup required by JanitorAI.
- Automatically importing bookmarked or collected characters into the local
  SillyTavern library.
- Polling JannyAI continuously, resolving offline conflicts, or creating a
  general-purpose synchronization engine.

## Approved decisions

1. Use an isolated JannyAI facade over the existing shared browser lifecycle.
2. Keep JanitorAI's public interfaces and settings section untouched.
3. Add a duplicate browser subsection inside JannyAI rather than a merged
   JanitorAI/JannyAI settings surface.
4. Bind both provider sections to the same browser mode and endpoint values.
5. Keep separate per-provider warm pages and request allowlists.
6. Use the real browser as Cloudflare transport; use the Supabase token as the
   account identity.
7. Prefer the complete
   `sb-eenzcbluoctduymzksoq-auth-token.0` and `.1` cookie pair.
8. Store parsed access and refresh tokens, not the raw pasted cookie header.
9. Install a full Supabase session into the browser when both tokens are
   available, while still adding the bearer token to authenticated requests.
10. Allow anonymous definition imports with browser clearance alone; require an
    account only for bookmarks and owned collections.
11. Remove both Janny userscript dependencies rather than absorbing or
    extending either script.

## Architecture

```text
Janny catalog/search
    -> direct MeiliSearch request

Janny character pages and public collections
    -> Janny-specific cl-helper route
        -> shared managed/external browser
            -> Janny warm page and Cloudflare cookies

Janny account operations
    -> refreshable Supabase session in Character Library
        -> Janny-specific cl-helper route
            -> browser same-origin request
                -> Authorization bearer token
                -> Janny session cookies when available
```

### Shared browser lifecycle

The existing managed-browser process, persistent profile, browser discovery,
idle shutdown, external CDP support, and endpoint resolution remain the single
source of truth. JannyAI reuses those internal primitives without changing the
existing JanitorAI route contracts.

JannyAI maintains its own warm tab/page connected to the same browser process.
The Janny page is always scoped to `https://jannyai.com`; Janitor navigation or
page failure cannot replace or poison it. A failed Janny page is closed and
recreated without touching JanitorAI's warm page.

The managed browser continues to start lazily. Opening the Janny provider does
not start it merely to run MeiliSearch. A Cloudflare-gated page, account
operation, explicit Start action, or Janny browser test starts or attaches to
the browser.

### Provider-specific helper routes

JannyAI receives provider-specific `cl-helper` routes. Thin lifecycle aliases
operate on the same managed browser as JanitorAI:

- `POST /jannyai-managed/start`
- `POST /jannyai-managed/stop`
- `GET /jannyai-managed/status`

Janny-specific transport and session routes are:

- `POST /jannyai-browser-test`
- `POST /jannyai-browser-fetch`
- `POST /jannyai-browser-session`
- `POST /jannyai-browser-logout`

The lifecycle aliases delegate to the existing internal browser manager. They
do not create a second process or profile.

`/jannyai-browser-fetch` accepts an origin-relative path, method, optional
bearer token, and either a JSON or form body. It returns status, body, final URL,
and selected safe response metadata. It never accepts an arbitrary origin.

### Request policy

Every fetch request is normalized with `new URL(path, JANNY_ORIGIN)` before its
prefix is trusted. The resolved origin must be exactly
`https://jannyai.com`. Path traversal, alternate schemes, embedded credentials,
unexpected ports, and cross-origin redirects are rejected.

The allowlist covers only current provider behavior:

- `GET /characters/<uuid>_<slug>`
- `GET /collections` with only `page`, `sort`, and `q` query keys
- `GET /collectors/<name>` without query parameters
- `GET /collections/<uuid>_<slug>` without query parameters
- `GET /api/bookmark` without query parameters
- `POST /api/bookmark` with a bounded `{ characterIDs: <uuid[]> }` JSON body
- `DELETE /api/bookmark?ids=<uuid-csv>`
- `GET /api/get-characters?ids=<uuid-csv>`
- `GET /api/collections/mine`
- `GET /api/collections/<uuid>/characters`
- `POST /api/collections/<uuid>/characters` with a
  `{ characterId: <uuid> }` JSON body
- `DELETE /api/collections/<uuid>/characters?characterId=<uuid>`
- `POST /collections/form/add-collection`
- `POST /collections/form/edit-collection`
- `POST /collections/form/delete-collection`

Methods, query keys, UUIDs, content types, request-body types, and body sizes
are validated independently. Redirect success is accepted only when the final
URL remains on the Janny origin and matches an expected collection route.

The browser executes same-origin requests with `credentials: include`. An
authenticated call also receives `Authorization: Bearer <current-access-token>`.
The token is sent in the request body from Character Library to its own
CSRF-protected helper route and is never placed in a URL or echoed back.

## Authentication and session lifecycle

### Accepted input

The primary login input is a copied cookie header containing the full chunked
JannyAI Supabase session:

- `sb-eenzcbluoctduymzksoq-auth-token.0`
- `sb-eenzcbluoctduymzksoq-auth-token.1`

The parser orders numeric chunks, requires a contiguous sequence beginning at
chunk zero, concatenates them, URL-decodes the result, handles the Supabase
`base64-` representation, parses the session JSON, and extracts access and
refresh tokens. It also continues to accept unchunked session JSON and a bare
access JWT.

A bare JWT is valid login input but is explicitly marked non-refreshable. The
settings UI displays its expiry and warns that a fresh login value will be
required after it expires.

### Stored settings

- Existing `jannyToken` remains the access-token setting for migration.
- New `jannyRefreshToken` stores the rotating refresh token when supplied.
- The raw pasted cookie header is never persisted.
- JannyAI email and password are not collected or stored.

### Validation and refresh

A stateful Janny session module mirrors `janitor-session.js` while using
JannyAI's Supabase project:

- auth base: `https://eenzcbluoctduymzksoq.supabase.co/auth/v1`
- a pinned public Supabase anon-key constant, verified against JannyAI's public
  client configuration during implementation rather than scraped at runtime
- `/user` verification for a newly pasted access token
- `/token?grant_type=refresh_token` for refresh rotation

JWT issuer and expiry are checked locally before network validation. A token
from a different Supabase project is rejected.

`getValidJannyToken()` returns the current access token when it has more than
two minutes remaining. Otherwise it enters a single shared refresh operation.
Concurrent requests await that operation so a single-use rotating refresh
token cannot be consumed twice.

On successful refresh, the new access and refresh tokens are saved atomically
before requests resume. On a definitive 400/401 refresh failure, both stored
tokens are cleared. Network errors, 429s, and server errors are transient and
preserve the stored session for retry.

An authenticated account request that receives 401 forces one refresh and one
retry. It never loops indefinitely.

### Browser session installation

When a complete session is saved or refreshed, Character Library calls
`/jannyai-browser-session` with the latest access and refresh tokens.
`cl-helper` constructs the standard Janny Supabase auth-cookie payload and
installs it for the Janny origin, replacing stale unchunked or numbered chunks.

This keeps cookie/form-based routes and browser-hydrated pages consistent with
the bearer identity. Account API requests still carry the bearer header so
their correctness does not rely solely on cookie behavior.

When only a bare access JWT exists, the browser request uses the bearer header
without claiming that a durable browser session was installed.

### Logout

Logout performs both actions:

1. Clear `jannyToken` and `jannyRefreshToken` from Character Library settings.
2. Delete Janny account/session cookies from the browser profile.

Cloudflare cookies such as `cf_clearance` and `__cf_bm` are preserved. JannyAI
can therefore remain anonymously reachable immediately after logout.

## Definition extraction

The existing MeiliSearch result remains the catalog/listing record. Opening a
preview or importing a character obtains its full page through the browser.

Extraction is a fail-closed ladder:

1. Warm or recreate the Janny browser page and establish Cloudflare access.
2. Fetch the allowlisted character URL inside the browser.
3. Reject non-2xx responses, challenge pages, login pages, and malformed HTML.
4. Pass valid HTML to the existing Astro-island parser.
5. If valid HTML lacks the expected serialized character payload, navigate the
   warm page to the character URL and inspect only known Astro state, hydrated
   DOM data, and same-origin character-data responses associated with the
   requested UUID.
6. Return a structured character only when its identity matches the requested
   UUID and required definition data is present.
7. Otherwise return a `JANNY_PAGE_SHAPE_CHANGED` error and block import.

The hydrated fallback is not an arbitrary browser evaluator exposed to the
client. It is a fixed helper routine that reads only the expected character
shape and never returns cookies, local storage, authorization headers, or
unrelated network traffic.

The provider distinguishes:

- Cloudflare rejection before the page loads;
- browser/helper unavailability;
- account-token rejection;
- a valid page whose schema changed; and
- a genuinely absent field reported by JannyAI.

No challenge response or missing parser result may fall back to importing the
MeiliSearch listing as a complete card.

## Account data flow

Bookmarks and collections remain live, on-demand remote account views rather
than background synchronization.

### Reads

- Account status uses an authenticated bookmark request after local/Supabase
  validation.
- Bookmarks and owned collections load lazily when their UI is opened.
- Bookmarked character IDs are hydrated in bounded chunks.
- Collection membership is fetched only when needed and cached for the current
  page session.

### Writes

- Bookmark add/remove is sent immediately, then the in-memory set is updated
  after success.
- Collection create/edit/delete and membership changes are sent immediately.
- A failed mutation does not update the local cache as though it succeeded.
- A 401 receives one refresh/retry before the UI reports failure.
- Login, logout, and session replacement invalidate cached account state.

There is no offline mutation queue or conflict resolver.

## Settings UI

The existing JanitorAI settings section remains unchanged. The JannyAI section
contains its own browser subsection that mirrors the JanitorAI controls:

- managed or external browser mode;
- external endpoint field when applicable;
- managed-browser start, stop, and status;
- Janny-specific Test action and readiness results.

Both sections read and write the existing `janitoraiBrowserMode` and
`janitoraiBrowserEndpoint` settings through a shared browser-configuration
adapter. Opening either settings section re-reads those settings, so a change
made in one is immediately reflected in the other. The duplicate UI does not
create duplicate browser configuration.

The Janny test reports separate checks for:

- `cl-helper` reachability;
- browser/CDP connectivity;
- Cloudflare access to `jannyai.com`; and
- receipt of a usable Janny character page.

The Janny account subsection contains:

- a masked session/token input;
- Save Login and Log Out actions;
- parsed account email when available;
- access-token expiry;
- automatic-renewal availability; and
- a warning for a bare, non-refreshable JWT.

The UI states are explicit:

- **Browser unavailable:** Cloudflare-gated pages and account features cannot
  run. MeiliSearch catalog browsing remains available.
- **Browser ready, no account:** public character definitions and public
  collections work; bookmarks and owned collections do not.
- **Browser ready, account ready:** all supported features work.
- **Refreshable expiry:** refresh silently, then update the displayed expiry.
- **Definitive token rejection:** request a fresh complete cookie pair.
- **Page-shape change:** identify parser incompatibility rather than blaming
  Cloudflare or login.

All messages that instruct users to install a Janny userscript, refresh a
userscript bridge, or merely log into an unrelated browser tab are removed.

## Error model

Provider and helper errors carry stable codes so UI copy does not infer causes
from arbitrary strings:

- `JANNY_HELPER_UNAVAILABLE`
- `JANNY_BROWSER_UNAVAILABLE`
- `JANNY_BROWSER_TIMEOUT`
- `JANNY_CF_BLOCKED`
- `JANNY_LOGIN_REQUIRED`
- `JANNY_TOKEN_EXPIRED`
- `JANNY_TOKEN_REJECTED`
- `JANNY_RATE_LIMITED`
- `JANNY_PAGE_SHAPE_CHANGED`
- `JANNY_REQUEST_BLOCKED`
- `JANNY_HTTP_ERROR`

Transport timeouts are bounded. An aborted preview/import propagates caller
cancellation rather than being relabeled as a browser failure.

## Security and privacy

1. Janny browser routes remain behind SillyTavern's normal plugin API and CSRF
   protection.
2. The helper accepts no arbitrary origin and normalizes every path before
   allowlist evaluation.
3. Account tokens appear only in request bodies and browser request headers,
   never in URLs.
4. Helper responses never echo tokens, cookies, storage, or raw browser
   debugging state.
5. Logs redact authorization headers, session cookie names/values, request
   bodies containing credentials, and returned Supabase sessions.
6. Browser extraction returns only the requested character's structured data
   and safe page diagnostics.
7. The existing warning for externally exposed unauthenticated CDP endpoints
   remains applicable; this design does not widen that endpoint.
8. Live verification may use the repository owner's authorized Janny session,
   but no credential is written to source, design documents, fixtures, commits,
   screenshots, or captured command output.

## Removal and migration

### Remove

- `extras/cl-janny-bridge.user.js`
- `modules/providers/janny/janny-bridge.js`
- Janny provider imports and initialization of both account and definition
  userscript bridges
- bridge availability/status UI and mobile variants
- bridge-specific tests and shims
- active README, Help & Tips, error, and installation text describing a Janny
  userscript
- obsolete code paths that save only an unverified access token because a
  bridge is absent

The shared Janitor userscript and its DataCat consumers remain unchanged.
Historical bridge design documents may remain only when clearly marked as
superseded; they must not be linked as current setup instructions.

### Migrate

- Existing `jannyToken` values remain usable as bare access-token sessions.
- `jannyRefreshToken` starts empty until the user saves a complete cookie pair.
- Existing Janitor browser mode and endpoint settings are reused as-is.
- Users do not need to configure the duplicated Janny browser section when the
  Janitor browser already works.
- The Janny provider declares the new minimum `cl-helper` version that contains
  its browser routes.

There is no userscript fallback after migration. Missing helper/browser support
produces a direct configuration message.

## Testing

### Automated tests

Session tests cover:

- numbered chunk ordering and concatenation;
- full cookie headers, URL encoding, `base64-` sessions, raw session JSON, and
  bare JWTs;
- malformed input, wrong issuer, and expired tokens;
- access/refresh persistence and logout;
- refresh rotation, concurrent refresh serialization, transient errors, and
  definitive revocation;
- one retry after authenticated 401.

Helper and policy tests cover:

- allowed host, path, method, query, UUID, content type, and body shapes;
- rejection of alternate origins, ports, traversal, encoded traversal,
  cross-origin redirects, unexpected query keys, oversized IDs, and bodies;
- session-cookie installation and replacement;
- logout preserving Cloudflare cookies;
- managed/external endpoint resolution without a second browser process;
- isolated Janny warm-page recreation.

Definition tests cover:

- existing Astro serialization fixtures;
- valid HTML with expected definition fields;
- hydrated-browser fallback data;
- requested UUID mismatch;
- challenge/login/malformed bodies;
- valid page with changed schema producing `JANNY_PAGE_SHAPE_CHANGED`;
- refusal to import a listing-only card as complete.

Static and regression tests cover:

- no Janny source, UI, README, or active help reference to either userscript
  transport;
- no Janny import of `janny-bridge.js` or `janitor-bridge.js`;
- direct MeiliSearch remaining browser-independent;
- JanitorAI public routes and provider code remaining behaviorally unchanged;
- secrets absent from logs and returned diagnostics.

### Authorized live verification

Live checks use the owner's authorized Janny session without printing or
persisting its contents:

1. Start or attach to the shared browser.
2. Pass the Janny-specific browser and Cloudflare checks.
3. Fetch a public character anonymously and verify nonempty definition and
   greeting data.
4. Save the `.0`/`.1` session, install it into the browser, and confirm account
   identity.
5. Read bookmarks and owned collections.
6. Add and remove a test bookmark, restoring the original state.
7. Create, edit, add a character to, remove the character from, and delete a
   temporary test collection without modifying existing collections.
8. Exercise one refresh-token rotation, atomically store the new pair, and
   reinstall it in the browser.
9. Verify logout clears Janny account state while Cloudflare access remains,
   then restore the current valid session if the test displaced it.

Live mutations are reversible, inspect the original state first, and clean up
in a `finally` path where practical.

## Success criteria

- MeiliSearch browsing works without starting the browser.
- A managed or external browser that passes the JanitorAI-style handshake also
  passes the Janny-specific Cloudflare test.
- Public character previews and imports contain definitions and greetings when
  JannyAI exposes them to a normal browser.
- A challenge, 403, or changed page shape cannot produce an apparently
  successful empty import.
- A complete `.0`/`.1` session supports automatic token rotation.
- A bare JWT works until expiry and is clearly identified as non-refreshable.
- Bookmarks and all existing owned-collection operations work through the
  browser and survive a forced access-token refresh.
- Janny logout clears account state but not Cloudflare clearance.
- Janny has no runtime or user-facing dependency on either userscript bridge.
- JanitorAI behavior and public interfaces remain unchanged.
- The shared browser process/profile and settings are not duplicated.
