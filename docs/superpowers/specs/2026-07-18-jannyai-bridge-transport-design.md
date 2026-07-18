# JannyAI Account Sync via Userscript Bridge — Design

**Date:** 2026-07-18
**Branch:** `codex/jannyai-account-sync`
**Status:** Approved by user

## Background

The branch's JannyAI account sync (bookmarks + collections) currently works by
capturing the user's full jannyai.com cookie string (`cf_clearance` + the chunked
Supabase `sb-eenzcbluoctduymzksoq-auth-token.0`/`.1` cookies), persisting it in
settings, and replaying requests server-side through cl-helper
(`extras/cl-helper/janny-account.js`) with UA spoofing, IPv4/IPv6 dual-family
dialing, and optional FlareSolverr. This fights Cloudflare by recreating the
browser's identity on the server, and it is fragile: cf_clearance is IP-family
bound, rotates, and upstream v6.7.0 removed the FlareSolverr routes from
cl-helper entirely.

Upstream v6.7.0 (d795c9b) solved the same class of problem for JanitorAI's
Hampter feeds with a companion userscript (`extras/cl-janitor-bridge.user.js`):
`GM_xmlhttpRequest` is CORS-exempt and carries the browser's own cookies for the
target domain, so the request passes Cloudflare as the real user. Confirmed
working on the user's mobile setup (Firefox for Android + Tampermonkey), which
is their primary environment.

This design replaces the entire cookie-relay transport with the same bridge
pattern, scoped to jannyai.com.

## Decisions (user-approved)

1. **Revert scope:** delete the cookie capture/persist UI, the cl-helper
   `janny-account.js` relay and its routes, and `extras/android-webview-bridge/`
   (APK). Keep all bookmark/collection/browse features; only the transport
   changes.
2. **Bridge shape:** a **separate** userscript `extras/cl-janny-bridge.user.js`.
   Upstream's `cl-janitor-bridge.user.js` stays byte-identical for clean merges.
   Users install both scripts.
3. **Login model:** zero-paste. Being logged into jannyai.com in the same
   browser is the login; no token fields, nothing stored.

## Components

### 1. Userscript: `extras/cl-janny-bridge.user.js`

Structurally mirrors `cl-janitor-bridge.user.js`: postMessage handshake
(ping/ready), `event.origin` checks, activates only on the CL page (path regex
or the existing `<meta name="character-library">` marker), `@connect jannyai.com`,
`@noframes`.

Differences from the janitor bridge:

- **Method+path allowlist** instead of GET-only single prefix. Permitted, all on
  `https://jannyai.com` only:
  - `GET | POST | DELETE  /api/bookmark`
  - `GET                  /api/collections*`
  - `POST | DELETE        /api/collections/<id>/characters`
  - `POST                 /collections/form/*` (create/edit/delete; form-encoded)
  Anything else is refused with a blocked reply.
- **Body + content type support:** JSON (`application/json`) for the API
  endpoints, `application/x-www-form-urlencoded` for the `/collections/form/*`
  POSTs. The bridge passes through the body CL provides; it never constructs
  requests on its own.
- **Redirect-aware replies:** collection form-POSTs answer 302 on success.
  GM follows redirects; the reply includes `status` and GM's `finalUrl` so the
  client can detect success either way (302 seen directly, or 200 after a
  followed redirect to the collection page).
- **Distinct message tags:** page→script `source: 'character-library-janny'`,
  script→page `source: 'cl-janny-bridge'`. The janitor bridge ignores these
  messages entirely (it filters on `source: 'character-library'`), so both
  scripts coexist without cross-talk.

Security posture matches the janitor bridge: hard host check via `new URL()`,
origin-guarded messaging, no other hosts, and the userscript manager enforces
the boundary again via `@connect`.

### 2. Page-side client: `modules/providers/janny/janny-bridge.js`

New module mirroring `modules/providers/datacat/janitor-bridge.js` (untouched):

- ping/ready handshake on load, re-ping on demand
- `isJannyBridgeAvailable()` — sync availability check
- `jannyBridgeFetch(method, url, { body, contentType, timeoutMs })` — resolves
  `{ ok, status, body, finalUrl }`, request/response correlated by unique id,
  filtered on `source: 'cl-janny-bridge'`.

### 3. Transport rewire: `modules/providers/janny/janny-api.js`

Every account call currently routed through `jannyAccountProxy` / cl-helper
switches to `jannyBridgeFetch`:

- bookmarks: `GET/POST/DELETE /api/bookmark`
- collections: list/detail `GET /api/collections*`, character add/remove
  `POST/DELETE /api/collections/<id>/characters`, create/edit/delete via
  `/collections/form/*`
- session status: replaced by a bridge probe — a cheap authenticated GET
  (candidate: `GET /api/bookmark`; **exact endpoint verified live during
  implementation**). 200 → logged in; 401/403 JSON → logged out; Cloudflare
  HTML → challenged (rare via the bridge).

The 1024-char cl-helper path cap and its `?ids=` batching workaround go away
with the relay; batching may be kept only if jannyai.com itself imposes limits
(verified live).

### 4. Deletions (the revert)

- `extras/cl-helper/janny-account.js` and every `janny-*` route registered in
  `extras/cl-helper/index.js`; cl-helper version bump
- `setJannySessionCookie` / `clearJannySession` / `getJannySessionStatus` /
  `validateJannySession` / `jannyAccountProxy` and all FlareSolverr option
  plumbing in `janny-api.js`
- cookie persistence + auto-restore in settings (`library.js`), the cookie
  capture UI in `library.html` (desktop) and the mobile drawer variants
  (`library-mobile.js` / `library-mobile.css` / `browse-shared.css` as applicable)
- `extras/android-webview-bridge/` including the APK
- README/help text describing cookie capture

Features (bookmark sync UI, collections UX, Following, browse) are not removed.

### 5. Settings UI

The JannyAI `<details>` section gains a settings-group mirroring the layout of
DataCat's "JanitorAI Login (Hampter pagination)" group — title row with icon,
hint rows, status — but with **no inputs**:

- **Bridge row:** detected / not installed. Not-installed state hints:
  install `extras/cl-janny-bridge.user.js` in Tampermonkey or Violentmonkey
  (works on Firefox for Android + Tampermonkey on mobile).
- **Account row:** logged in / not logged in. Logged-out hint: "log into
  jannyai.com in this same browser."
- **Refresh button** re-runs the handshake + probe.
- Existing blocked-notice deep-link pattern points at a matching Help & Tips
  entry, which is updated to describe the bridge instead of cookie capture.

Per project convention, the group nests inside the JannyAI provider section.

### 6. Error handling

- **Bridge absent:** account features render the install-userscript state;
  anonymous browse is unaffected.
- **Bridge present, 401:** "log into jannyai.com in this browser" state.
- **Cloudflare challenge via bridge:** surfaced through the existing
  blocked-notice pattern (should be rare — the request is the real browser).
- **Form-POST success:** accepted on direct 302 or on followed-redirect 200
  whose `finalUrl` matches the expected collection page shape.
- Bridge replies time out (20s, matching the janitor bridge) rather than hang.

### 7. Testing

- `tests/janny-account.test.mjs` rewritten against `janny-bridge.js` +
  `janny-api.js` with a fake postMessage bridge (window shim preloaded via
  `--import`, matching the existing harness pattern).
- `tests/janny-settings-account.test.mjs` updated for the status-only UI.
- Static UX tests updated where they referenced cookie UI ids.
- **Live verification before completion** on the real setup (PC + Firefox
  Android/Tampermonkey): login probe, bookmark add/remove, collection create,
  char add/remove, collection delete — account writes are never trusted from
  code reading alone.

## Out of scope

- Any change to upstream's `cl-janitor-bridge.user.js` or datacat modules
- DataCat/Hampter behavior (already handled upstream)
- JannyAI anonymous browse paths that never touched the relay
