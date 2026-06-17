# BotBooru — Provider Anatomy

> Reference notes for the "how to add a provider" guide. All file:line citations are to the
> `codex/provider-guide-docs` branch. Three frontend modules plus one cl-helper route:
> - `modules/providers/botbooru/botbooru-api.js` — network/auth/data layer (shared)
> - `modules/providers/botbooru/botbooru-provider.js` — the `ProviderBase` subclass (linking, import, update checks)
> - `modules/providers/botbooru/botbooru-browse.js` — the `BrowseView` subclass (UI, filters, modals)
> - `extras/cl-helper/index.js` — server-side login proxy

## 1. Overview

Botbooru is a **cl-helper-proxied, public-first provider with token-only favorites**. It is a
full provider: it subclasses `ProviderBase` (`botbooru-provider.js:56`) and `BrowseView`
(`botbooru-browse.js:325`), declares `hasView` (`botbooru-provider.js:85`), `hasAuth`
(`:351`), `supportsImport` (`:599`), `supportsGallery` (`:687`), and `supportsBulkLink`
(`:559`). Identity: `id() => 'botbooru'`, `name() => 'Botbooru'`, icon `fa-solid fa-robot`,
`iconUrl` from `${BOTBOORU_BASE}/favicon.ico`, and `beta() => true` with an `enableWarning`
(`botbooru-provider.js:59-65`).

Public-first: SFW browsing and importing work **anonymously**; NSFW and personal features
(favorites, following, weighted tags) require a Botbooru account token. The card data layer is
unusually thin because `/download/json/{id}` already returns a ready `chara_card_v2` envelope —
there is **no field-mapping layer**, the provider validates rather than rebuilds
(`botbooru-api.js:152-168`, `botbooru-provider.js:1-7`).

`BOTBOORU_BASE = 'https://botbooru.com'` (`botbooru-api.js:18`). The singleton instance is the
default export (`botbooru-provider.js:760-761`); `botbooru-api.js` must be initialized once via
`initBotbooruApi({ getSetting, debugLog })` from `BotbooruProvider.init()`
(`botbooru-provider.js:69-73`, `botbooru-api.js:32-35`).

## 2. Server plugin (cl-helper)

**Yes — one route.** `registerBotbooruRoutes(router)` (`extras/cl-helper/index.js:572`,
registered at `:1853`) adds:

- **`POST /botbooru-login`** — body `{ username, password }`. It re-serializes the credentials
  as `application/x-www-form-urlencoded` and POSTs to `BOTBOORU_AUTH_URL =
  'https://botbooru.com/auth/token'` (`index.js:570, 595-601`), then pipes the upstream status,
  content-type, and body straight back to the client (`:603-607`).

Why it exists (**not generic CORS**, a subtler reason): Botbooru's `/auth/token` endpoint
requires a form-encoded body, but **ST's built-in `/proxy/` re-serializes request bodies as
JSON, which this endpoint rejects with 422** (`index.js:577-578`). The route is **stateless** —
the token is returned to the client and nothing is stored server-side (`:579-580`). It also
validates presence and caps username/password at 256 chars (`:585-592`) and returns 502 on
upstream failure (`:608-611`).

Note: this is the **only** server-side need. Every *data* request avoids CORS a different way —
see §4.

## 3. Authentication / login

**Auth model: anonymous browse + token-only everything-personal.** `hasAuth() => true`
(`botbooru-provider.js:351`); `isAuthenticated()` is simply `!!getSetting('botbooruToken')`
(`:353-355`). The token is a **JWT bearer token** (valid ~90 days) stored in the
`botbooruToken` setting (`getSettings()` declares it as a `password`-type setting,
`botbooru-provider.js:391-400`). `getAuthHeaders()` returns
`{ Authorization: 'Bearer <token>' }` when set (`:361-364`); the shared header builder is
`getBotbooruHeaders(includeAuth)` in `botbooru-api.js:50-57`, which only adds the
`Authorization` header when a token exists.

Two login paths, both ending in `setSettings({ botbooruToken, ... })`:

1. **Username/password via cl-helper** — `loginToBotbooru()` (`botbooru-browse.js:1342`) POSTs
   to `${CL_HELPER_PLUGIN_BASE}/botbooru-login` via `apiRequest` (`:1355`). A 404 means the
   plugin is missing and the UI tells the user to paste a token manually (`:1356-1358`). On
   success it stores `data.access_token` (`:1368`).
2. **Manual token paste** — `saveBotbooruManualToken()` (`botbooru-browse.js:1389`) strips a
   leading `Bearer ` and validates the token against `/auth/me` (`fetchBotbooruMe`,
   `botbooru-api.js:471-479`) before keeping it (`:1402-1412`). The login modal exposes this as
   a `<details>` fallback ("paste the JWT from botbooru.com's local storage, key
   `access_token`") (`botbooru-browse.js:768-779`).

`openAuthUI()` opens the login modal (`botbooru-provider.js:357-359` → `openBotbooruLoginModal`,
`botbooru-browse.js:1322`). Logout is `clearBotbooruToken()` (`:1415`), which nulls the token
and several derived flags (`botbooruNsfwAccountSynced`, `botbooruNsfw`,
`botbooruUseTagWeights`).

**NSFW account sync** is part of auth: enabling NSFW pushes the account-side master switches via
`ensureNsfwAccountFlags()` → `patchBotbooruAccount({ show_nsfw, show_nsfl })`
(`botbooru-browse.js:1455-1463`, `botbooru-api.js:488-500`). Without `show_nsfw` on the account,
the server returns SFW-only regardless of the request param (`botbooru-api.js:481-487`).

## 4. Data source

JSON REST API rooted at `https://botbooru.com`. **Botbooru sends no CORS headers**, so every
*data* request rides `fetchWithProxy` (`botbooru-api.js:7-12`): the first direct attempt
rejects, the origin is cached, and ST's `/proxy/` carries everything after — crucially
`Authorization` survives the proxy (`:7-9`). (Contrast §2: only the form-encoded login can't go
through `/proxy/`.)

Key endpoints (all in `botbooru-api.js`):

- `GET /posts/?...` — browse/search list (`fetchBotbooruPosts`, `:90-112`)
- `GET /post/{id}` — full detail, LRU-cached (3 entries, 10-min TTL) (`fetchBotbooruPost`, `:118-146`)
- `GET /download/json/{id}` — ready V2 card envelope (`fetchBotbooruCard`, `:158-168`)
- `GET /download/png/{id}` — published card PNG (avatar + embedded data) (`getBotbooruDownloadUrl`, `:73-75`)
- `GET /images/preview/480/{filename}?v={rev}` — grid/preview thumbnail (`getBotbooruPreviewUrl`, `:68-70`)
- `GET /tags/` (~1.6MB, lazy once-per-session) and `GET /tags/related/?q=` (`:183-215`)
- `GET /api/users/{id}` and `/following`, `/favorites` (`:252-461`)
- `GET /auth/me`, `PATCH /auth/me`, `/auth/me/follows/tags`, `/auth/me/tag-weights` (`:317-500`)
- `GET/POST /interactions/{id}/favorites|favorite` (`:412-439`)
- `POST /posts/{id}/track-download?kind=` (fire-and-forget) (`:507-512`)

**Canonical ID** is the numeric **post id** (a string/number). It is stored under
`data.extensions.botbooru.id` and the cross-provider path key `fullPath` is `String(id)`
(`botbooru-provider.js:100-116`). Site-downloaded cards instead carry the site's own namespace
`{schema_version, post_id, post_url}`; `getLinkInfo` accepts `post_id` as a fallback so
sideloaded cards are recognized without a manual relink (`:97-100`).

## 5. Browse & filtering

`renderFilterBar()` (`botbooru-provider.js:87` → `botbooru-browse.js:512-646`) builds:

- **Mode toggle** (`.chub-view-btn[data-botbooru-view]`): Browse / Following. Following requires
  a token (`:519`, `:1081-1092`).
- **Sort presets** `#botbooruSortPreset` (`:526-550`) keyed into `BB_SORT_PRESETS`
  (`:107-123`): `latest`, `curated`, `random`, `hot_{day,week,month,all}` (sort `favorites` +
  `time_window`), `views_*`, `dl_*`. Each preset is `{ sort, timeWindow?, curatedSort? }`.
- **Timeline sort** `#botbooruTimelineSortHeader` (Following mode only) (`:553-562`).
- **Curated sub-sort** `#botbooruCuratedSort` (`recent`/`score`/`followed`) — only sent when the
  account runs weighted-tag mode (`getSetting('botbooruUseTagWeights') === true`), server
  ignores it otherwise (`:565-569`, `:2084-2085`).
- **Curated freshness** `#botbooruCuratedFreshBtn` → `curated_include_updated=false` (`:573`,
  `:2086`).
- **Tags dropdown** `#botbooruTagsBtn` (`:578-611`): tri-state tag filters (`bbTagFilters:
  Map<name,'include'|'exclude'>`, `:143`) — includes merge into `q`, excludes are
  client-side/negated (`-tag`); plus Advanced Options: Min Tokens (`min_tokens`), Count lorebook
  tokens (`include_lorebook_tokens`), Uploaded after/before (`uploaded_after`/`uploaded_before`).
- **Features dropdown** `#botbooruFiltersBtn` (`:614-629`): My Favorites (login-gated, switches
  data source), Hide Owned, Hide Possible Matches, Hide AI-generated (`hide_ai=true`, server-side).
- **NSFW toggle** `#botbooruNsfwToggle` (`:632-634`): label "SFW Only" by default.
- **Auth** `#botbooruAuthBtn` and **Refresh** `#refreshBotbooruBtn`.

**NSFW / `sfw_only` handling** is the key gating pattern: SFW is the fresh-install default
(`bbNsfwEnabled = false`, `:79`). In `loadBotbooruPosts`, `if (!bbNsfwEnabled) params.sfwOnly =
true` (`:2097`), and `fetchBotbooruPosts` only sets the query param when truthy: `if
(params.sfwOnly) qs.set('sfw_only', 'true')` (`botbooru-api.js:94`). Enabling NSFW in the UI
requires a token *and* an account-side sync (`ensureNsfwAccountFlags`, `:1204-1218`). Anonymous
requests are SFW-only server-side regardless; the param is authoritative only for logged-in
accounts whose `show_nsfw` is on (`:2095-2097`). NSFL is a separate `botbooruShowNsfl` setting
that only rides the account `show_nsfl` flag (`:1459`) — no per-request param; NSFL cards get a
distinct `.botbooru-nsfl-badge` (`:2571`).

Data sources swap by mode: My Favorites uses `fetchBotbooruFavorites` (`:1981-2031`), uploader
view uses `fetchBotbooruUser` (`:2035-2066`), default uses `/posts/` (`:2068-2100`). Images
load through a rate-limit-aware concurrency queue (4 concurrent, paced, exponential backoff) to
avoid the host's 429s (`:201-272`).

## 6. Preview / detail modal

`previewModalId() => 'botbooruCharModal'` (`botbooru-browse.js:398`). The modal HTML is
`_renderPreviewModal()` (`:797-932`), rendered via `renderModals()` (`:734-736`). It uses the
shared `browse-char-modal` / `modal-glass` shell. Opened by `openBotbooruCharPreview(post)`
(`:2664`, also exposed as `window.openBotbooruCharPreview` at `:3229`); closed by
`closeBotbooruCharPreview` / `closePreview()` (`:440-442`).

Populated element IDs (`:797-931`): `#botbooruCharAvatar`, `#botbooruCharName`,
`#botbooruCharCreator` (Writer tag), `#botbooruCharUploader` + external profile link, stats
`#botbooruCharViews`/`Downloads`/`FavoriteCount`, the inline favorite heart
`#botbooruCharFavoriteBtn` (`.botbooru-fav-btn-inline`), `#botbooruCharTagline`,
`#botbooruCharTokens`/`Date`, optional badges (greetings, lorebook, fork, origin link), tag
chips `#botbooruCharTags`, and collapsible card sections (Creator's Notes, Description,
Personality, Scenario, Example Dialogs, First Message, Alternate Greetings) plus a
`#botbooruCharGallerySection` (max-3 mini-gallery). Controls: Open-on-Botbooru
`#botbooruOpenInBrowserBtn`, Import `#botbooruDownloadBtn`, close `#botbooruCharClose`.

The preview detail (`/post/{id}`) is held in `bbSelectedDetail` and reused by the import
duplicate check (`:98`, `:3108`). A stale-result guard `bbPreviewToken` discards out-of-order
fetches since the api helpers have no abort signal (`:99`).

For *linked* characters in the local library, `supportsInAppPreview() => true`
(`botbooru-provider.js:163`); `buildPreviewObject()` fetches `/post/{id}` and stitches an
`avatar_url`, then `openPreview()` calls `window.openBotbooruCharPreview`
(`botbooru-provider.js:165-180`).

## 7. Import & card mapping

`supportsImport() => true` (`botbooru-provider.js:599`). `importCharacter(idHandle, hitData,
options)` (`:608-683`):

1. Extract numeric id; fetch the V2 card via `fetchBotbooruCard` (`/download/json/{id}`) — it is
   already a `chara_card_v2` envelope, **so there is no source→V2 field mapping**; the provider
   validates `card.data.name` exists (`botbooru-api.js:159-167`).
2. Fetch `/post/{id}` for fields only present there (uploader name, slug, filename, tagline)
   (`:618`).
3. **Creator credit precedence**: Writer-category tag (`getBotbooruWriterTag`,
   `botbooru-api.js:223-225`) → `post.uploader_name` → the card json's own `creator` (a last
   resort, often a junk reupload-source link) (`:624-626`).
4. **`stripForeignProviderNamespaces(card)`** (`botbooru-provider.js:47-54`) deletes foreign
   link namespaces (`chub`, `janny`, `chartavern`, `pygmalion`, `wyvern`, `datacat`) — Botbooru
   cards are largely reuploads that still carry their origin's extensions, and leaving them would
   make CL auto-link the import to the **wrong** provider. Provenance is recorded display-only in
   `extensions.botbooru.origin/sauce`.
5. Stamp `data.extensions.botbooru` with `{ id, slug, filename, rev, uploaderId, uploaderName,
   origin, sauce, pageName, tagline, linkedAt }` (`:630-645`).
6. Image: prefer the card PNG (`/download/png/{id}`), fall back to the preview thumbnail
   (`:649-659`); finalize via shared `importFromPng(...)` with `providerCharId`/`fullPath` =
   numeric id (`:663-672`).
7. On success, fire `trackBotbooruDownload(id, 'png')` unless `botbooruTrackDownloads === false`
   (`:674-677`, `botbooru-api.js:507-512`).

`normalizeRemoteCard` wraps a bare `data` object in a V2 envelope if needed
(`botbooru-provider.js:294-298`). The browse-side import wrapper `downloadBotbooruCharacter()`
runs the pre-import duplicate check and import-summary/gallery flow (`botbooru-browse.js:3096`).
`enrichLocalImport()` heals partial/site namespaces and resolves gallery state for
already-on-disk cards (`botbooru-provider.js:184-242`).

## 8. Linking & update checks

Link info lives under `data.extensions.botbooru`:
- `getLinkInfo(char)` (`botbooru-provider.js:93-117`) — reads `bb.id` (or `bb.post_id` for
  site-downloaded cards); returns `{ providerId, id, fullPath: String(id), slug, filename, rev,
  uploaderId, uploaderName, linkedAt }`.
- `setLinkInfo(char, linkInfo)` (`:119-149`) — enriches the sparse `{id, fullPath, pageName}`
  from the shared link modal using the cached post detail (`_cachedLinkNode`).
- `getCharacterUrl(linkInfo) => ${BASE}/character/{id}` (`:151-155`) — note the **page** URL is
  `/character/{id}` while the API is `/post/{id}`.
- `openLinkUI` → `CoreAPI.openProviderLinkModal` (`:157-159`); `supportsBulkLink => true`
  (`:559`), `openBulkLinkUI` → `CoreAPI.openBulkAutoLinkModal` (`:561-563`).

Remote fetch / update checks:
- `fetchMetadata(handle)` resolves a parsed post id to its `/post/{id}` detail and caches it for
  `setLinkInfo` (`:251-256`).
- `fetchRemoteCard(linkInfo)` (`:263-292`) fetches the V2 card, mirrors the import-time creator
  resolution and `stripForeignProviderNamespaces`, and mirrors the post's `tagline` into
  `extensions.botbooru.tagline` so update checks can diff it.
- `getComparableFields()` (`:302-313`) returns a single optional field:
  `extensions.botbooru.tagline` ("Botbooru Tagline"). The card body itself is the published
  download, so the only botbooru-specific diff is the tagline.
- `fetchLinkStats(linkInfo)` (`:322-335`) returns `{ stat1: downloads, stat2: favorite_count,
  stat3: token_count }` and caches the post in `_cachedLinkNode`.
- `getListingName(hitData) => hitData.character_name` (`:347`).

## 9. Save / favorites / bookmarks

**No save-card / bookmark feature** in the CL sense (no `supportsSaveCard`/save-to-collection
hook). Instead Botbooru exposes **token-only favorites** that mirror the site's own hearts:

- Toggle from the preview modal: `toggleBotbooruCharFavorite()` (`botbooru-browse.js:3058-3090`)
  → `toggleBotbooruFavorite(postId)` = `POST /interactions/{id}/favorite` (no body; response is
  the authoritative new `{favorited, count}`) (`botbooru-api.js:427-439`). State read via
  `fetchBotbooruFavoriteState` = `GET /interactions/{id}/favorites` (`:412-421`). All
  login-gated — a missing token opens the login modal (`botbooru-browse.js:3061-3065`).
- **My Favorites view**: the Features dropdown `#botbooruFilterFavorites` swaps the browse data
  source to `fetchBotbooruFavorites` = `GET /api/users/{me}/favorites` (a bare array of
  `kind:"character"` items, string tags) (`botbooru-api.js:447-461`, browse `:1981-2031`).

**Following hooks** (server-backed user follows): `supportsFollowingManager() => true`
(`botbooru-browse.js:342`); `getFollowedCreators` / `followCreator` / `unfollowCreator` /
`browseCreatorFromManager` (`:344-394`) wrap `fetchBotbooruFollowing` (`GET
/api/users/{me}/following`) and `setBotbooruFollow` (`POST`/`DELETE
/api/users/{id}/follow`) (`botbooru-api.js:279-310`). There is **no followed-feed param** on
`/posts/`, so the Following timeline merges each followed uploader's latest uploads client-side
(`botbooru-browse.js:84-96`). Follows take a profile URL or numeric id since there is no user
search (`:354-378`).

**Followed tags & tag weights** are two account "save" surfaces that boost the curated sort:
followed tags (`listFollowedTags`/`followTag`/`unfollowTag`, `botbooru-provider.js:422-482`,
endpoint `/auth/me/follows/tags`) and weighted-tag mode (`listTagWeights`/`setTagWeight`/...,
`:486-555`, endpoint `/auth/me/tag-weights`). The account `use_tag_weights` switch decides which
list is active and is mirrored into the `botbooruUseTagWeights` setting (`:537-555`). The
provider also implements `searchTags` autocomplete over the lazy tag DB (`:452-478`).

## 10. Gallery

`supportsGallery() => true` (`botbooru-provider.js:687`). `fetchGalleryImages(linkInfo)`
(`:694-710`) reads `post.mini_gallery.images`, keeps entries with `status === 'approved'` and a
`download_url`, and returns `{ url: BASE+download_url, id, nsfw: false }` — capped at the
post's max 3 mini-gallery images. The per-image API carries no NSFW flag, so `nsfw` is hardcoded
`false` (rides the post-level rating). Import decides `hasGallery` the same way: any approved
mini-gallery image (`:661`, `enrichLocalImport` `:211`). In the preview modal the gallery renders
into `#botbooruCharGalleryGrid` with a full-size viewer (`botbooru-browse.js:1280-1290`).

## 11. URL handling

- `canHandleUrl(url)` (`botbooru-provider.js:368-376`) — true when the hostname matches
  `^(www\.)?botbooru\.com$` (case-insensitive). Accepts bare hosts (prepends `https://`).
- `parseUrl(url)` (`:378-387`) — matches `^/(?:character|posts?)/(\d+)` and returns the captured
  numeric post id. Site pages use `/character/{id}`; the API-shaped `/post/{id}` and
  `/posts/{id}` are tolerated.

Examples:
- `https://botbooru.com/character/12345` → `"12345"`
- `botbooru.com/post/12345` → `"12345"`
- `https://www.botbooru.com/posts/678` → `"678"`
- `https://botbooru.com/account` → `null` (no id)

The parsed id flows into `fetchMetadata` (link-by-URL) and `importCharacter` (which also
re-extracts `\d+` defensively, `:610`).

## 12. Notable patterns worth copying

Copy Botbooru as a baseline when the new provider:

- **Serves ready V2 cards** (e.g. a `/download/json` or equivalent that already returns
  `chara_card_v2`). Botbooru shows how to skip the field-mapping layer entirely and just
  validate (`botbooru-api.js:152-168`).
- **Is public-first with optional token auth** — anonymous SFW browse/import plus token-gated
  NSFW/personal features. The `sfwOnly`→`sfw_only` param-only-when-true gating
  (`botbooru-api.js:94`, browse `:2097`) and the `botbooruToken`-keyed `isAuthenticated`
  (`botbooru-provider.js:353-355`) are the reusable shapes.
- **Needs a tiny cl-helper route only for a request the ST `/proxy/` can't carry** (here, a
  form-encoded login; ST re-serializes bodies as JSON). Everything else uses `fetchWithProxy`
  for CORS — copy this split so you don't put data behind the plugin unnecessarily
  (`index.js:572-613` vs `botbooru-api.js:7-12`).
- **Hosts reupload cards that carry foreign link namespaces** — reuse
  `stripForeignProviderNamespaces` so imports don't auto-link to the wrong provider, mirrored in
  both `importCharacter` and `fetchRemoteCard` (`botbooru-provider.js:47-54, 277`).
- **Offers server-backed social features** (favorites, user-following, followed/weighted tags)
  via `supportsFollowingManager` + a token-only favorites toggle and a "My Favorites" data-source
  swap (`botbooru-browse.js:342-394, 3058-3090`).
- **Talks to a rate-limited image host** — the paced concurrency queue with exponential backoff
  (`botbooru-browse.js:201-272`) is a drop-in pattern for any provider whose CDN 429s on bursts.
