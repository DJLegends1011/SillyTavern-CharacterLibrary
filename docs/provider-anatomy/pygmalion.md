# Pygmalion — Provider Anatomy

Reference anatomy of the **pygmalion** provider, captured for the "how to add a provider" guide. All citations are to files under `modules/providers/pygmalion/` and `extras/cl-helper/index.js`.

Files:
- `modules/providers/pygmalion/pygmalion-api.js` — network/API layer (endpoints, RPC URL builder, JWT helpers, plugin-availability check).
- `modules/providers/pygmalion/pygmalion-provider.js` — the `ProviderBase` subclass (identity, import, linking, auth surface, settings).
- `modules/providers/pygmalion/pygmalion-browse.js` — the `BrowseView` subclass (grid, filter bar, preview modal, login modal, following timeline, token/auto-refresh management).
- `modules/providers/pygmalion/pygmalion-browse.css` — login/follow-button styling only.

## 1. Overview

Provider kind: a **public-read, optional-login** remote character source backed by a Connect RPC (JSON-over-HTTP) API at `server.pygmalion.chat`. It is a full provider with its own browse view (`get hasView()` returns `true`, `pygmalion-provider.js:157`) and a custom `BrowseView` subclass `PygmalionBrowseView` (`pygmalion-browse.js:2311`).

Identity (`pygmalion-provider.js:134-146`):
- `id` = `'pygmalion'`, `name` = `'Pygmalion'`, `icon` = `'fa-solid fa-fire'`.
- `iconUrl` = `${PYGMALION_SITE_BASE}/icons/favicon-32x32.png`.
- `linkStatFields`: stat1 Downloads (`fa-download`), stat2 Stars (`fa-star`), stat3 Tokens (`fa-coins`).

API base constants (`pygmalion-api.js:14-17`):
- `PYGMALION_API_BASE = 'https://server.pygmalion.chat/galatea.v1.PublicCharacterService'`
- `PYGMALION_USER_API_BASE = 'https://server.pygmalion.chat/galatea.v1.UserService'`
- `PYGMALION_SITE_BASE = 'https://pygmalion.chat'`
- `PYGMALION_ASSETS_BASE = 'https://assets.pygmalion.chat'`

The header comment (`pygmalion-api.js:3-5`) states the model directly: "Public endpoints - no auth required for character search/detail. Authenticated endpoints - require Bearer token for follow/user operations." This is the baseline being documented: **public browse works with no credentials; login is only needed for NSFW/sensitive results and for user-scoped features (Following).**

**Verification of the "login needs server-side exchange/headers" claim:** TRUE. The browser never talks to Pygmalion's auth server directly. Login posts email+password to the cl-helper server plugin route `/plugins/cl-helper/pyg-login`, and the plugin forwards them server-side to `https://auth.pygmalion.chat/session` with `Origin`/`Referer` headers the browser cannot legally set (see §2). So Pygmalion is the canonical "public browse, but login requires server-side exchange/headers" baseline.

## 2. Server plugin (cl-helper)

**cl-helper usage: YES — used solely for the login token exchange.** All character read/search/detail and authenticated UserService calls go directly to `server.pygmalion.chat` from the client via `fetchWithProxy`; cl-helper is involved only in obtaining the session JWT.

Plugin base path: `CL_HELPER_PLUGIN_BASE = '/plugins/cl-helper'` (`provider-utils.js:14`, re-exported from `pygmalion-api.js:11-12`).

Availability probe — `checkPluginAvailable(apiRequest)` (`pygmalion-api.js:307-318`) GETs `${CL_HELPER_PLUGIN_BASE}/health` and returns true when the JSON body has `ok === true`. The login modal uses this to show "cl-helper plugin detected" vs. "not found" (`pygmalion-browse.js:1542-1556`).

Login route — `registerPygmalionRoutes(router)` (`extras/cl-helper/index.js:528-564`), registered at `index.js:1852`:
- `POST /pyg-login`, body `{ username, password }`.
- Validates both are strings ≤ 256 chars (`index.js:536-539`), else 400.
- Re-encodes as `application/x-www-form-urlencoded` and forwards to `PYGMALION_AUTH_URL = 'https://auth.pygmalion.chat/session'` (`index.js:525`) with headers `Origin: https://pygmalion.chat` and `Referer: https://pygmalion.chat/` (`index.js:544-552`). These browser-forbidden request headers are exactly **why the exchange must happen server-side.**
- Pipes the upstream status + body straight back (`index.js:556-558`); on network failure returns 502 (`index.js:561`).

**Exactly why cl-helper is needed:** the Pygmalion auth endpoint requires `Origin`/`Referer` headers (CORS-protected, browser cannot set them), so the password-for-JWT exchange cannot be done from the browser. The plugin is a thin server-side proxy that adds those headers. Character browsing/import need no plugin at all.

## 3. Authentication / login

`get hasAuth()` returns `true` (`pygmalion-provider.js:389`). Auth is **optional** — it gates NSFW/sensitive results and user-scoped features only.

Credential storage & auth model (`pygmalion-provider.js:391-406`):
- `isAuthenticated` = truthy `getSetting('pygmalionToken')`.
- `getToken()` = `getSetting('pygmalionToken')` (a JWT id_token).
- `getAuthHeaders()` returns `{ Authorization: 'Bearer <token>' }`.
- `openAuthUI()` → `window.openPygmalionTokenModal?.()` (defined at `pygmalion-browse.js:2935`).

Settings keys (`getSettings()`, `pygmalion-provider.js:438-464`), all in section `'Login'`:
- `pygmalionEmail` (text)
- `pygmalionPassword` (password — "stored locally, never sent to third parties")
- `pygmalionRememberCredentials` (checkbox, default `false`)

Additional runtime setting keys used by the browse view: `pygmalionToken` (the JWT), `pygmalionNsfw` (persisted NSFW toggle, `pygmalion-browse.js:1506`, `2066`).

Login flow (client side) — `loginWithCredentials(email, password)` (`pygmalion-browse.js:1595-1647`):
- POSTs to `${CL_HELPER_PLUGIN_BASE}/pyg-login` via `CoreAPI.apiRequest`.
- On HTTP **201**, reads `data.result.id_token`, stores it via `savePygToken` → `setSetting('pygmalionToken', ...)` (`pygmalion-browse.js:1512-1516`), persists email/password and sets `pygmalionRememberCredentials = true`, then schedules auto-refresh and auto-enables NSFW.
- Maps 422 → "Invalid email or password", 502 → "auth server unreachable".

JWT lifetime handling (`pygmalion-api.js:325-343`): `decodeJwtPayload` (base64url, no verification) and `getTokenTTL` (returns `exp - now`, `Infinity` if no `exp`).

Token auto-refresh / recovery (all in `pygmalion-browse.js`):
- `scheduleTokenRefresh` (`1676-1709`) re-logs in at ~80% of TTL.
- `tryAutoLogin` (`1764-1805`) runs silently on `activate()` when a remembered credential exists and the token is missing/near-expiry.
- `attemptTokenRecovery` (`1724-1758`) reactively re-logs in when an API call throws `authFailed`.

`authFailed` tagging: `searchCharacters`, `getFollowedUsers`, `toggleFollowUser` set `err.authFailed = true` only on HTTP 401/403 (`pygmalion-api.js:91-94`, `266-271`, `290-295`) so transient 5xx don't trigger a bogus re-auth. The browse view keys recovery off this flag (`pygmalion-browse.js:408-422`, `1328-1337`).

There is also a manual-token escape hatch UI (`.pyg-manual-token-section`, auto-opened when the plugin is missing — `pygmalion-browse.js:1554-1556`) and a settings-UI helper `window.pygmalionLoginCheck` (`pygmalion-provider.js:642-679`) that performs the same `/pyg-login` call but tolerates `data.result.id_token || data.token`.

## 4. Data source

Connect RPC over HTTPS, JSON encoding. Unauthenticated reads use a GET with the request message JSON-encoded into the query string; authenticated reads use POST with a Bearer header.

`buildGetUrl(method, message)` (`pygmalion-api.js:37-44`) builds `${PYGMALION_API_BASE}/<Method>?connect=v1&encoding=json&message=<json>`.

Read endpoints (`PublicCharacterService`):
- `CharacterSearch` — `searchCharacters` (`pygmalion-api.js:62-105`). Without a token: GET (SFW-only). With a token: POST + Bearer (required for `includeSensitive`). Message fields: `query`, `orderBy`, `orderDescending`, `pageSize`, `page`, optional `includeSensitive`, `tagsNamesInclude`, `tagsNamesExclude`. Returns `{ totalItems, characters }`.
- `Character` — `fetchCharacterDetail(characterMetaId, characterVersionId?, token?)` (`pygmalion-api.js:114-138`). Returns `{ character, versions }`.
- `CharactersByOwnerID` — `fetchCharactersByOwner(userId, orderBy='approved_at', page, token?)` (`pygmalion-api.js:148-171`).

User endpoints (`UserService`, always POST + Bearer): `GetFollowedUsers` (`pygmalion-api.js:252-272`) and `ToggleFollowUser` (`pygmalion-api.js:280-296`).

**Canonical ID format:** a UUID character meta-id (36 chars, `[a-f0-9-]`). It is the `char.id` / `hit.id` field, stored as both `id` and `fullPath` everywhere (e.g. link info `pygmalion-provider.js:182-187`, normalize `622-635`). `parseCharacterUrl` matches it with `/\/character\/([a-f0-9-]{36})/i` (`pygmalion-api.js:203`).

Assets: avatar/gallery values are either full URLs or bare asset UUIDs; `getAvatarUrl` (`pygmalion-api.js:178-182`) prefixes bare UUIDs with `PYGMALION_ASSETS_BASE`.

## 5. Browse & filtering

Filter bar — `renderFilterBar()` (`pygmalion-browse.js:2455-2530`) renders:
- A **mode toggle** (`.chub-view-toggle` with `.pyg-view-btn` for `data-pyg-view="browse"` / `"following"`). `hasModeToggle` is `true` (`2408`).
- **Browse sort** `#pygSortSelect`: Downloads (default), Stars, Views, Newest (`approved_at`), Tokens (`token_count`), Name (`display_name`).
- **Following sort** `#pygFollowingSortSelect` (hidden until Following mode): Newest/Oldest Created, Name A-Z/Z-A, Most Downloads, Most Stars.
- **Tags dropdown** `#pygTagsBtn` / `#pygTagsDropdown` with search input `#pygTagsSearchInput`, clear `#pygTagsClearBtn`, list `#pygTagsList`. Tags cycle neutral→include→exclude→neutral (`renderPygTagsList`/`cyclePygTagState`, `468-536`); state stored in `pygIncludeTags`/`pygExcludeTags` Sets, seeded from `SEED_TAGS` (`79-86`) and harvested from results (`collectTagsFromResults`, `455-462`).
- **Features dropdown** `#pygFiltersBtn` / `#pygFiltersDropdown`: Ascending Order (`#pygFilterSortDir`), Hide Owned Characters (`#pygFilterHideOwned`), Hide Possible Matches (`#pygFilterHidePossible`).
- **NSFW toggle** `#pygNsfwToggle` (greyed at 0.5 opacity without a token; clicking with no token opens the login modal, `2058-2064`).
- **Refresh** `#pygRefreshBtn`.

The search bar (`#pygSearchInput`, `#pygSearchBtn`, `#pygClearSearchBtn`) and author banner live in `renderView()` (`2534-2606`), not the filter bar.

Notable filtering behavior in `loadCharacters` (`264-449`): the API does substring tag matching, so the client re-applies **strict** include-tag filtering (`315-324`), merges provider-level exclude tags from `getProviderExcludeTags('pygmalion')` (`284-287`), applies hide-owned/hide-possible client-side, and **auto-fetches up to 3 extra pages** to refill a page emptied by client filters (`337-382`). Page size is `PAGE_SIZE = 48` (`76`). Author filter mode swaps to the dedicated `fetchCharactersByOwner` endpoint (`289-291`).

Cards — `createPygCard(hit)` (`174-225`): avatar with lazy `data-src`, NSFW badge, in-library / possible-match badges, gallery-count badge, name, clickable creator link (`.browse-card-creator-link` with `data-author`/`data-owner-id`), up to 3 tags, and footer stats (downloads/stars/chats) plus approved date.

## 6. Preview / detail modal

`get supportsInAppPreview()` = `true` (`pygmalion-provider.js:303`). The provider builds the preview object by fetching full detail (`buildPreviewObject`, `305-314`) and opens it via `window.openPygmalionCharPreview?.(previewChar)` (`openPreview`, `316-318`).

Modal markup — `_renderPreviewModal()` (`pygmalion-browse.js:2672-2792`). `previewModalId` = `'pygCharModal'` (`2407`). Root overlay `#pygCharModal` > `.modal-glass.browse-char-modal`. Key element IDs / fields:
- Header: `#pygCharAvatar`, `#pygCharName`, creator `#pygCharCreator` (in-app author filter) + `#pygCreatorExternal` (profile link), `#pygOpenInBrowserBtn`, `#pygImportBtn`, `#pygCharClose`.
- Tagline: `#pygCharTaglineSection` / `#pygCharTagline`.
- Stats grid: `#pygCharDownloads`, `#pygCharStars`, `#pygCharViews`, `#pygCharChats`, `#pygCharDate`, optional `#pygCharSourceStat`/`#pygCharSource`, `#pygCharGalleryStat`/`#pygCharGalleryCount`, `#pygCharGreetingsStat`/`#pygCharGreetingsCount`.
- Tags: `#pygCharTags` (clamped via `applyTagsClamp`).
- Definition sections (`.browse-char-section`, hidden until populated): Creator's Notes `#pygCharCreatorNotesSection`, Description/persona `#pygCharDescriptionSection`, Example Dialogs `#pygCharExamplesSection`, First Message `#pygCharFirstMsgSection`, Alternate Greetings `#pygCharAltGreetingsSection`, Gallery `#pygCharGallerySection`/`#pygCharGalleryGrid`.

Flow — `openPreviewModal(hit)` (`565-734`) populates from the search hit synchronously; because search hits lack `personality`, it shows skeleton lines (`712-723`) then calls `fetchAndPopulateDetails(hit, token)` (`858-911`) to fetch `Character` detail and fill in definitions via `populateDefinitionSections` (`753-856`). Rich text goes through `safePurify(formatRichText(...), BROWSE_PURIFY_CONFIG)`, deferred with `requestAnimationFrame`/`deferRender`. A staleness token `pygDetailFetchToken` guards against out-of-order responses. Cleanup: `cleanupPygCharModal`/`closePreviewModal` (`913-938`).

## 7. Import & card mapping

`get supportsImport()` = `true` (`pygmalion-provider.js:490`). `importCharacter(characterId, hitData?, options)` (`497-579`): prefers pre-fetched detail, else fetches `Character`, else falls back to the search hit; builds a V2 card, ensures link metadata, downloads the avatar via `fetchWithProxy`, then delegates to `importFromPng(...)` with `fileName: pyg_<slug>.png`, `hasGallery`, `providerCharId`/`fullPath` = the UUID.

V2 mapping — `buildV2FromDetail(char)` (`45-83`), source fields under `char.personality`:
- `personality.name` → `data.name` (fallback `char.displayName`)
- `personality.persona` → `data.description`
- `personality.greeting` → `data.first_mes`
- `personality.mesExample` → `data.mes_example`
- `personality.characterNotes` → `data.creator_notes`
- `personality.creator` (fallback `owner.username`/`owner.displayName`) → `data.creator`
- `char.versionLabel` → `data.character_version`
- `char.tags` → `data.tags`
- `personality.alternateGreetings` (truthy-filtered) → `data.alternate_greetings`
- `personality`/`scenario`/`system_prompt`/`post_history_instructions` are left empty; `character_book` is `undefined`.

Provider-specific data is stored under `data.extensions.pygmalion` (`66-78`): `id`, `versionId`, `source`, `ownerId`, `ownerUsername`, `tagline` (= `char.description`), and stats `stars`/`views`/`downloads`/`chatCount`. `buildV2FromSearchHit` (`89-125`) is the minimal fallback (empty definitions).

The browse-view `importCharacter` wrapper (`pygmalion-browse.js:944-1068`) runs the pre-import duplicate check (`checkCharacterForDuplicatesAsync` + `showPreImportDuplicateWarning`), supports replace (inherits gallery id), then calls the provider, shows the import-summary modal, and marks the card in-library (`markCardAsImported`, `1070-1093`).

Duplicate/match helpers: `searchForImportMatch` (`pygmalion-provider.js:600-618`) and `enrichLocalImport` (`322-385`) — the latter back-links a locally-imported PNG to Pygmalion, requiring an **exact case-insensitive name AND creator match** before linking.

## 8. Linking & update checks

- `getLinkInfo(char)` (`pygmalion-provider.js:173-188`): reads `extensions.pygmalion.id`; returns `{ providerId:'pygmalion', id, fullPath:id, linkedAt }`.
- `setLinkInfo(char, linkInfo)` (`190-206`): writes/clears `data.extensions.pygmalion` (`id`, `versionId`, `linkedAt`, `pageName`).
- `getCharacterUrl(linkInfo)` → `getCharacterPageUrl(id)` (`292-295`).
- `openLinkUI` → `CoreAPI.openProviderLinkModal`; `openBulkLinkUI` → `CoreAPI.openBulkAutoLinkModal` (`supportsBulkLink` = `true`, `468-472`).
- `fetchLinkStats(linkInfo)` (`216-233`): fetches detail, returns `{ stat1: downloads, stat2: stars, stat3: personalityTokenCount }`, caches the node.
- `fetchMetadata` / `fetchRemoteCard` / `normalizeRemoteCard` (`240-269`): refetch `Character` and rebuild the V2 card.
- Update checks — `getComparableFields()` (`273-284`) compares only one optional field: `extensions.pygmalion.tagline` (label "Tagline", group `tagline`).
- `get supportsVersionHistory()` = `false` (`288`).

## 9. Save / favorites / bookmarks

**No save-card / favorite / bookmark support.** There is no `supportsSave`/`saveCard`/`supportsBookmark`/`supportsFavorite` anywhere in `provider-interface.js` or the provider modules (grep returns nothing). The only social write surface is **following authors** (not characters):
- `get supportsFollowingManager()` = `true` (`pygmalion-browse.js:2325`).
- `getFollowedUsers` / `toggleFollowUser` provider methods (`pygmalion-provider.js:408-418`) wrap the UserService calls.
- Following manager hooks: `getFollowedCreators`, `getCreatorAvatarUrl`, `followCreator` (requires a user UUID), `unfollowCreator`, `browseCreatorFromManager` (`pygmalion-browse.js:2327-2405`).
- A "Follow" button appears in the author-filter banner (`#pygFollowAuthorBtn`, wired via `togglePygFollowAuthor`, `1877-1955`); followed-user IDs are cached in `pygFollowedUserIds`.
- A **Following timeline** view aggregates new characters from followed authors (`loadPygFollowingTimeline`, `1234-1361`). All of this requires a token; without one the timeline shows a "Token Required" empty state.

## 10. Gallery

`get supportsGallery()` = `true`, `galleryFilePrefix` = `'pygmaliongallery'` (`pygmalion-provider.js:583-584`).

`fetchGalleryImages(linkInfo)` (`586-596`) fetches detail and returns `getGalleryImages(char)`. `getGalleryImages(char)` (`pygmalion-api.js:216-237`) concatenates `char.altAvatars` + `char.altImages` + (`char.chatBackgroundUrl` if present), each run through `getAvatarUrl`, returning `[{ url }]`.

In the preview modal, the gallery grid is rendered by `renderPygGalleryGrid` (`pygmalion-browse.js:736-751`) into `#pygCharGalleryGrid`, and clicking a thumb opens `BrowseView.openAvatarViewer` with the full URL list (`2255-2265`).

## 11. URL handling

- `canHandleUrl(url)` (`pygmalion-provider.js:422-430`): true when the hostname matches `/^(www\.)?pygmalion\.chat$/i`.
- `parseUrl(url)` → `parseCharacterUrl` (`pygmalion-api.js:199-208`): normalizes a bare host to `https://`, then matches `/\/character\/([a-f0-9-]{36})/i` and returns the UUID (or `null`).
- `getCharacterPageUrl(id)` (`pygmalion-api.js:189-191`) builds `https://pygmalion.chat/character/<uuid>`.

Examples:
- `https://pygmalion.chat/character/123e4567-e89b-12d3-a456-426614174000` → handled, parses to `123e4567-e89b-12d3-a456-426614174000`.
- `pygmalion.chat/character/123e4567-e89b-12d3-a456-426614174000` (no scheme) → handled (scheme is added).
- `https://pygmalion.chat/user/somebody` → `canHandleUrl` true, but `parseUrl` returns `null` (no `/character/<uuid>`).

## 12. Notable patterns worth copying

Copy Pygmalion as the baseline when your new provider is **public-read but needs a server-side credential exchange to log in.** Specifically:

- **Public browse + Bearer-gated extras.** The GET-without-token / POST-with-token split in `searchCharacters`/`fetchCharacterDetail` is the clean template for "anyone can browse SFW, login unlocks NSFW + user features."
- **cl-helper as a thin auth proxy only.** If the target's auth endpoint needs `Origin`/`Referer` (or any browser-forbidden header) or a CORS bypass, copy `registerPygmalionRoutes` (`extras/cl-helper/index.js:528-564`) and `checkPluginAvailable` — keep all read traffic client-side.
- **JWT lifecycle.** Reuse `decodeJwtPayload`/`getTokenTTL` plus the `scheduleTokenRefresh` / `tryAutoLogin` / `attemptTokenRecovery` trio and the `err.authFailed` (401/403-only) tagging for robust silent re-auth.
- **Client-side strict filtering with auto-refill.** If the remote API does fuzzy tag matching, copy the strict re-filter + bounded auto-fetch loop in `loadCharacters` so client-only filters don't return short/empty pages.
- **Following-as-the-only-write-surface.** If your source supports following creators but not saving/favoriting characters, mirror the `supportsFollowingManager` + following-timeline pattern rather than inventing a save API.

Do **not** start from Pygmalion if the provider needs version history, character bookmarking/favorites, or has no public read access (login required even to browse) — none of those are modeled here.
