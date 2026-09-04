# JanitorAI Favorites and Experimental Meili Latest

Date: 2026-08-08

Branch: `codex/janitorai-favorites-meili-latest`

Base: `main` (`v7.0.4` at design time)

## Objective

Complete JanitorAI's compact account feature set by adding account-backed character favorites, then add one isolated experimental listing source: JannyAI MeiliSearch ordered newest-first.

The work is intentionally narrow. Favorites are required and production-facing. Meili Latest is an explicitly labeled experiment in a separate commit. DataCat Freshest is excluded.

## Commit Boundary

The implementation is split into two independently reviewable commits:

1. JanitorAI account favorites.
2. Experimental JanitorAI `Latest (Meili)` listing source.

Reverting the second commit must leave favorites fully functional.

## Scope

### Required: JanitorAI account favorites

- A complete paginated `My Favorites` feed.
- A desktop inline heart, current-account favorite state, and authoritative favorite count when Janitor exposes one in the Janitor preview modal.
- A mobile Favorite/Unfavorite action exposed through the existing pancake action menu.
- Authenticated favorite-state reads and favorite/unfavorite writes.
- Session-level favorite membership caching with explicit invalidation.
- Correct removal from the active favorites feed after a successful unfavorite.

### Experimental: Meili Latest

- A separate `Experimental` optgroup in Janitor's existing sort selector.
- Exactly one option: `Latest (Meili)`.
- Newest-first listing via the existing JannyAI MeiliSearch helper.
- Janitor-native preview, favorite, import, link, and update behavior after a listing is selected.

### Out of scope

- DataCat Freshest or any new DataCat dependency.
- Local SillyTavern favorite synchronization.
- Grid-card hearts or bulk favorite actions.
- Background favorite polling or scheduled reconciliation.
- Collections, folders, Janitor chats, personas, presets, uploaded-character management, or profile editing.
- Generic provider-auth refactoring.
- Changes to Janitor's existing Hampter sorts.

## Existing Architecture Reused

Janitor already has a persistent Supabase session, rotating refresh token, one shared in-flight refresh, a retry after authenticated 401 responses, classified rate-limit/Cloudflare errors, and a real-browser request transport through `hampterFetch`. Favorites must use this path rather than introduce a second auth or browser layer.

Chub supplies the account-wide membership-cache/feed pattern. Botbooru supplies the per-character authoritative-state/toggle pattern. Janitor combines the useful parts of both while keeping its state local to `janitorai-browse.js`.

## Endpoint Discovery Contract

Implementation begins with a read-only discovery spike against Janitor's first-party client/API behavior. The spike must establish, from authoritative Janitor behavior:

- Favorites-list route, HTTP method, pagination inputs, and response envelope.
- Per-character favorite-state route if one exists.
- Favorite and unfavorite mutation route(s), HTTP methods, body shape, and response envelope.
- Whether favorite counts appear in browse hits, detail payloads, favorite-state responses, or toggle responses.
- Whether favorite membership or IDs appear in decoded JWT claims or the Supabase `/auth/v1/user` account payload.

Only claim names and response field names/shapes may be recorded. Tokens, account values, credentials, and personal favorite data must never be logged or committed.

No guessed route ships. If Janitor exposes no stable per-character state endpoint, the paginated favorites feed is the membership source. If it exposes no authoritative new state in the toggle response, the implementation verifies the mutation with the state endpoint or a targeted favorites refresh before updating the UI. If no Janitor response exposes a total favorite count, the UI shows the heart without a fabricated numeric count.

JWT or account-payload favorite data, if present, may seed the cache but is never authoritative because it can remain stale until the session refreshes. Server favorite endpoints and verified mutation results determine current state.

## Favorite API Boundary

`janitorai-api.js` gains small normalized functions whose consumers do not depend on Janitor's raw response envelopes:

- Fetch one page of account favorites and return normalized Janitor hits plus pagination state.
- Fetch one character's current-account favorite state and count when the endpoint exists.
- Set a character's favorite state and return the authoritative resulting state and count.

All calls use `hampterFetch`, so they inherit token refresh, browser transport, abort handling, rate-limit pacing, and error codes. The helper browser route already permits authenticated GET and POST requests. If the verified Janitor API requires another method, cl-helper is widened only to that exact method and favorite route family rather than becoming a general request forwarder.

## Favorite State Model

`janitorai-browse.js` owns:

- `jaFilterFavorites`: whether `My Favorites` is the active browse data source.
- Favorite-feed page/has-more state.
- A `Set<string>` of known favorited Janitor UUIDs.
- A membership-loaded timestamp or generation marker.
- Optional per-hit `_isFavorited` and normalized favorite-count fields.

The cache is session-scoped. It is cleared when Janitor logout occurs, an account identity change is detected, a session is definitively dead, or the provider view is fully reset. Successful toggles update it immediately. Favorite pages add every returned UUID to it.

Late responses are discarded using the existing Janitor load-token and abort-controller model. Favorites, Hampter, and Meili may never append into one another's results.

## Favorite Feed and Filters

Janitor's Features dropdown gains a `Personal (requires login)` section containing `My Favorites`. It sits above the existing Library section.

Enabling `My Favorites`:

1. Requires a valid Janitor session. Signed-out use reverts the checkbox and directs the user to the existing Janitor settings/login UI.
2. Resets normal listing pagination and loads the account's favorites endpoint.
3. Uses the endpoint's real pagination metadata, or full-page length when the endpoint exposes no total.
4. Applies NSFW, Hide Owned, Hide Possible, and persistent excluded-tag behavior.
5. Passes search and tag filters to the server only when the verified endpoint supports them; otherwise it applies them client-side and continues paging until a visible page or exhaustion, so Load More does not appear broken after filtering.

Disabling `My Favorites` clears favorite-feed paging, returns to the previously selected normal listing source, and performs one clean reload.

Unfavoriting while `My Favorites` is active removes the card only after the remote mutation succeeds. Empty-state copy distinguishes an empty account favorites list from a page emptied by active filters.

## Preview Favorite Interaction

The Janitor preview metadata row gains a compact element with the shared `.browse-fav-toggle` class, a heart icon, and the current total favorite count when Janitor provides one.

On preview open:

1. Reset stale favorite classes/loading state.
2. If signed out, leave the control available with login guidance.
3. Resolve membership from a known per-hit state or the session cache.
4. If membership remains unknown and a per-character endpoint exists, fetch it once.
5. Ignore the result if the modal moved to another character while the request was in flight.

On toggle:

1. Refuse duplicate clicks while loading.
2. Require a valid Janitor session.
3. Send the desired resulting state rather than blindly assuming a local toggle whenever the API supports explicit state.
4. Update the heart, count, hit object, membership set, and active favorites feed only after the server confirms or the post-write verification succeeds.
5. Preserve the prior UI state and show the existing classified Janitor error on failure.

## Mobile Behavior

Mobile uses the same state and handlers as desktop.

- `My Favorites` appears through Janitor's registered Features control in the existing mobile filter sheet.
- `Latest (Meili)` appears in the existing mobile sort selector under `Experimental`.
- The inline desktop heart carries `.browse-fav-toggle`. The shared mobile action-menu builder detects it and creates a Favorite/Unfavorite pancake-menu action beside Open and Import.
- The action-menu label and icon are derived from the heart's current `favorited` class every time the menu opens.
- No separate mobile favorite handler or duplicated account state is introduced.

## Experimental Meili Latest

Janitor's sort list retains all current Hampter options unchanged and adds the persisted value `meili_latest`:

```text
Experimental
  Latest (Meili)
```

The source uses `meiliMultiSearch` from Janny's shared API helper with:

- `createdAtStamp:desc` as the only sort.
- Current search text.
- Current SFW/NSFW mode.
- Compatible numeric tag filters.
- Meili's own page and total-page fields.

A small Janitor-owned adapter normalizes each hit to Janitor's existing shape:

- `character_id`
- `name`
- `avatar`
- `description`
- `creator_name` and `creator_id`
- normalized tag objects
- `created_at`
- `is_nsfw`
- `total_tokens`

Missing Meili chat/message counts default to zero rather than borrowing DataCat fields.

Meili is listings-only. Opening a result fetches its authoritative Janitor detail by UUID. Import, hidden-definition recovery, favorites, linking, and card updates remain Janitor-native. A Meili failure produces source-specific error UI and never silently falls back to Hampter or DataCat.

## Source Switching

The listing source is derived from `jaFilterFavorites` and the selected sort:

1. Favorites when `jaFilterFavorites` is enabled.
2. Meili when `Latest (Meili)` is selected.
3. Hampter otherwise.

Every source transition aborts the current request, increments the load generation, clears rendered-count/page state for the destination, and reloads once. Provider deactivation and DOM recreation clear source-specific transient state. Persisted provider defaults accept the Meili option while it exists and fall back to `popular` for unknown or retired sort values.

## Error Handling

- `HAMPTER_LOGIN_REQUIRED`: disable/revert `My Favorites` and direct to Janitor settings.
- `HAMPTER_TOKEN_EXPIRED`: allow the existing refresh-and-retry; if refresh is definitively dead, clear favorite caches and direct to login.
- `HAMPTER_RATE_LIMITED`: retain current content and state; show the existing retry guidance.
- Browser/Cloudflare failure: retain prior favorite state and use the existing browser-check guidance.
- Favorite state unavailable: show an unfrozen, retryable control rather than marking false.
- Mutation response ambiguous: verify remotely before changing local state.
- Meili failure: show a Meili-specific error with Retry; do not alter Hampter/favorites state.

## Automated Tests

Tests cover:

- Favorite request paths, methods, auth transport, response normalization, and pagination.
- No logging of token/account values during claim-shape inspection.
- Membership cache seeding, lookup, invalidation, and authoritative mutation updates.
- Removal after unfavorite in the active favorites feed.
- Signed-out and definitively expired-session behavior.
- Modal race protection when selection changes during a state request.
- `.browse-fav-toggle` markup required by the mobile pancake menu.
- Meili request shape with exactly `createdAtStamp:desc`.
- Meili-to-Janitor normalization and independent pagination.
- Hampter, Meili, and favorites source transitions rejecting late prior-source responses.
- Persisted-sort validation and fallback.

## Manual Verification

Desktop and mobile checks cover:

- Signed-in and signed-out favorite use.
- Empty and multi-page favorites feeds.
- Desktop inline heart/count.
- Mobile Features sheet and pancake-menu Favorite/Unfavorite action.
- Unfavorite removal from `My Favorites`.
- Logout and account-change cache invalidation.
- Experimental sort grouping on desktop and mobile.
- Meili search, NSFW, tags, Load More, preview, and import.
- Rapid source/provider switching without mixed or stale results.
- Narrow mobile layouts.

## Completion Criteria

The required commit is complete when a signed-in Janitor account can browse its entire favorites list and favorite/unfavorite any previewed Janitor character on desktop and mobile, with server-authoritative state and correct session/error handling.

The experimental commit is complete when `Latest (Meili)` behaves as an isolated paginated Janitor listing source and can be reverted without changing favorite support.
