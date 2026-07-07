# JannyAI Account Sync Design (Phase A)

## Summary

Add optional JannyAI account support to the existing anonymous JannyAI provider so a signed-in user can save/unsave characters to their online JannyAI bookmarks from Character Library, browse their bookmarked set inside CL, and filter browse results to "My Bookmarks" — mirroring the account-sync pattern already shipped for DataCat, and the favorites-filter/save-button patterns already shipped for ChubAI and Botbooru.

This is **Phase A**. Collections (browse collections, download cards from collections, create collections and add bookmarked cards) is **Phase B** and gets its own spec + branch.

Branch: `jannyai-account-sync`.

## Goals

- Keep anonymous JannyAI browsing/extraction working exactly as today (MeiliSearch search + Cloudflare-proxy HTML scraping).
- Add a "Connect JannyAI" flow that rides the user's existing browser login session (no password exists to forward).
- Let the user save/unsave a JannyAI character to their online bookmarks from CL, on desktop and mobile.
- Reflect current saved state on cards/previews from the account's live bookmark list.
- Surface the user's JannyAI bookmarks as a browsable data source inside CL ("My Bookmarks").
- Add a "My Bookmarks" filter to JannyAI browse, matching Chub/Botbooru.
- Enforce a safety cap so CL never pushes the account past the count that breaks the JannyAI bookmark page.
- Surface clear signed-out / connected / expired / error states.

## Non-Goals

- No JannyAI Collections in this branch (Phase B).
- No "AI Tinder" integration.
- No replacement of SillyTavern's local favorite system or global favorites filter.
- Do not require a JannyAI login for anonymous browsing/importing.
- Do not store a JannyAI password (there is none — auth is OAuth/magic-link → session cookie).

## Current State

`modules/providers/janny/` is anonymous-only:

- `janny-api.js` — constants, tag map, MeiliSearch token scraping, `fetchWithProxy` re-export.
- `janny-provider.js` — Cloudflare-protected HTML fetch via corsproxy.io / Puter / ST `/proxy` fallback chain; character page URL `https://jannyai.com/characters/{uuid}_{slug}`.
- `janny-browse.js` — browse/search UI and character modal.

No account, no cl-helper usage. By contrast, DataCat account sync routes authenticated calls through the **cl-helper** SillyTavern server plugin (`extras/cl-helper/index.js`), which stores a session credential and makes requests server-side (bypassing browser CORS).

### Confirmed JannyAI API contract (live recon, logged in via Discord)

Site is Astro-based, Cloudflare-fronted. Auth is a **browser session cookie + Cloudflare `cf_clearance`**, sent same-origin only. There is **no bearer token / `X-Session-Token`** like DataCat. Login options are Discord/Google/Twitter OAuth or email magic-link (no email/password).

- `GET  https://jannyai.com/api/bookmark` → user's saved character IDs (JSON).
- `GET  https://jannyai.com/api/get-characters?ids=<csv-uuids>` → batch character details.
- `POST https://jannyai.com/api/bookmark` body `{"characterIds":["<uuid>"]}` (content-type `text/plain` to dodge CORS preflight) → save (batch-capable).
- `DELETE https://jannyai.com/api/bookmark?ids=<csv-uuids>` → remove (batch-capable).

**Hard constraint:** past ~220 saved bookmarks the JannyAI bookmark page renders fully invisible (breaks). CL must never push the account over a safe cap.

**Open item (resolve during implementation, 10-second devtools check):** whether the session cookie is `HttpOnly`. This only affects handoff ergonomics (bookmarklet vs. manual paste), not the architecture — the design works either way.

## Architecture

### cl-helper (`extras/cl-helper/index.js`)

Add JannyAI account state and routes, mirroring the DataCat `/dc-*` shape. The stored credential is the browser cookie string (not a token):

- State: `jyCookie` (session cookie string the user handed off), `jyUserAgent` (UA to send so Cloudflare `cf_clearance` validates), `jyConnected` (derived).
- `POST /jy-connect` — accepts `{ cookie, userAgent }`, stores them, validates by calling `GET https://jannyai.com/api/bookmark` server-side with the cookie + UA, returns `{ connected, bookmarkCount }` or an error state.
- `GET  /jy-status` — re-validates the stored cookie via a cheap authed call; returns `connected | expired | error` + `bookmarkCount`.
- `POST /jy-clear` — clears stored cookie/UA.
- `ALL  /jy-proxy/*` — forwards a JannyAI API path server-side, injecting `Cookie: <jyCookie>` and `User-Agent: <jyUserAgent>`. Used for `/api/bookmark` (GET/POST/DELETE) and `/api/get-characters`. Server-side = no browser CORS; same egress machine as the browser = same IP for `cf_clearance`.

Anonymous JannyAI browsing does **not** route through cl-helper and is unchanged.

### Frontend API (`modules/providers/janny/janny-api.js`)

Add account helpers that call cl-helper (with the same `_apiRequest`-bound / `/api/plugins/...` fallback shape DataCat uses):

- `connectJanny(cookie)` → `POST /jy-connect` (sends `navigator.userAgent`).
- `jannyAuthStatus()` → `GET /jy-status`.
- `disconnectJanny()` → `POST /jy-clear`.
- `fetchJannyBookmarkIds()` → `GET /jy-proxy/api/bookmark`; populates a module-level `jannyBookmarkIds` Set.
- `saveJannyBookmark(ids)` → `POST /jy-proxy/api/bookmark` `{ characterIds }`.
- `removeJannyBookmark(ids)` → `DELETE /jy-proxy/api/bookmark?ids=<csv>`.
- `fetchJannyBookmarkCharacters(ids)` → batched `GET /jy-proxy/api/get-characters?ids=<csv>` (chunk to a safe URL length).
- `JANNY_BOOKMARK_CAP` (default 220, configurable via setting).

`jannyBookmarkIds` is the single source of truth for card state and cap checks; refreshed on connect, after any save/remove, and on entering the My Bookmarks view.

### Save/unsave controls (`janny-browse.js`) — desktop + mobile

- Character modal gets an inline toggle `#jannyCharBookmarkBtn` with class `browse-fav-toggle` (required so `library-mobile.js` auto-derives the mobile action) and a `.favorited` (bookmarked) state class. **Glyph: bookmark icon (`fa-bookmark` / 🔖)** to match JannyAI's own bookmark likeness, not the heart used by Chub/Botbooru favorites.
- Handler `toggleJannyCharBookmark`:
  1. If not connected → toast prompting Connect JannyAI; abort.
  2. If adding and `jannyBookmarkIds.size >= cap` → block + warning toast; abort.
  3. Optimistic toggle → call save/remove → reconcile `jannyBookmarkIds` and button state → toast on failure with rollback.
- Mobile: because the modal button carries `.browse-fav-toggle`, `library-mobile.js:~3825` surfaces a "Bookmark / Remove bookmark" action automatically. Label/icon text adjusted to read "Bookmark" rather than "Favorite" for JannyAI.

### Mirror + "My Bookmarks" filter (`janny-browse.js`)

- State `jannyFilterBookmarks` + filter checkbox `#jannyFilterBookmarks` (labeled "🔖 My Bookmarks"), gated on connected state (toast "Connect JannyAI to view your bookmarks" otherwise), matching Chub/Botbooru filter wiring.
- Botbooru-style **data-source** behavior: enabling My Bookmarks switches browse to fetch `fetchJannyBookmarkIds()` → `fetchJannyBookmarkCharacters()` in batches → render as CL cards, rather than filtering the MeiliSearch result set. Paginate over the ID list.
- Resetting/clearing filters returns to normal search, mirroring `resetBotbooruFavoritesFilter()`.

### Settings

- `jannyConnected` (derived/display only), `jannyBookmarkCap` (default 220). No cookie stored in CL settings/localStorage — the cookie lives only in cl-helper memory (matching DataCat's "never persist the secret in CL settings" stance).

## Data Flow

1. User logs into jannyai.com in their browser (Discord/OAuth/magic-link).
2. User clicks "Connect JannyAI" in CL, hands off the session cookie (paste field; optional bookmarklet if cookie is JS-readable).
3. `connectJanny` → cl-helper stores cookie+UA, validates via `GET /api/bookmark`, returns bookmark count.
4. Browse/cards read `jannyBookmarkIds` for state. Save/unsave → `/jy-proxy` → JannyAI, then reconcile the Set.
5. My Bookmarks view fetches IDs → batched `get-characters` → CL cards.
6. Cap guard consults `jannyBookmarkIds.size` before every add.

## Error Handling

- Not connected: account actions no-op with a toast prompting connect; anonymous browse unaffected.
- Expired/invalid cookie (`/jy-status` = expired, or a proxied call returns 401/403/Cloudflare challenge): mark disconnected, toast "JannyAI session expired — reconnect", keep anonymous browse working.
- cl-helper missing: account UI hidden/disabled with an explanatory tooltip (same detection DataCat uses); anonymous browse unaffected.
- Cap reached: block add, warning toast; never partial/silent over-cap.
- Save/remove failure: roll back optimistic UI, toast the error.

## Testing

- cl-helper unit tests (`tests/janny-account-*.test.mjs`, following `tests/datacat-*.test.mjs`): cookie replay header injection, `/jy-status` state mapping (connected/expired/error), cap-guard math.
- Frontend: bookmark-Set reconciliation and cap-check logic.
- Manual E2E against a live session: connect → save → unsave → state reflects on card → My Bookmarks view lists them → filter toggle → mobile bookmark button → expired-session handling. Never exceed the ~220 cap during testing (test by remove→re-add of an existing bookmark).

## Rollout / Sequencing

1. cl-helper `/jy-*` routes + proxy.
2. `janny-api.js` account helpers + bookmark Set + cap constant.
3. Connect JannyAI UI + status/expired states.
4. Save/unsave modal button (bookmark glyph, `.browse-fav-toggle`) + mobile derivation.
5. My Bookmarks data-source view + filter checkbox.
6. Cap guard.
7. Tests + manual verification.
