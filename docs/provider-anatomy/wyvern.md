# Wyvern — Provider Anatomy

> Reference notes for the "how to add a provider" guide. All citations are
> `file:line` against the wyvern module as it exists on this branch.
> Files: `modules/providers/wyvern/wyvern-api.js`,
> `modules/providers/wyvern/wyvern-provider.js`,
> `modules/providers/wyvern/wyvern-browse.js`,
> `modules/providers/wyvern/wyvern-browse.css`.

## 1. Overview

Wyvern is a **browse-capable, importable, authenticated** provider for the
character source at `app.wyvern.chat` / `api.wyvern.chat`.

- Provider class `WyvernProvider extends ProviderBase` (`wyvern-provider.js:29`),
  exported as a singleton (`wyvern-provider.js:492-505`).
- Identity: `id = 'wyvern'`, `name = 'Wyvern'`, icon `fa-solid fa-dragon`,
  `iconUrl = ${WYVERN_SITE_BASE}/icon.png` (`wyvern-provider.js:32-35`).
- `hasView = true` (`wyvern-provider.js:64`) and `browseView` returns the
  `WyvernBrowseView` singleton (`wyvern-provider.js:36`,
  `wyvern-browse.js:2964`). The view extends the shared `BrowseView`
  (`wyvern-browse.js:219`).
- Code is split into three files: `wyvern-api.js` (constants, Firebase auth,
  metadata fetch + LRU cache, V2 card builder, URL helpers),
  `wyvern-provider.js` (the `ProviderBase` contract), and `wyvern-browse.js`
  (all UI / DOM / browse logic). The API layer is initialized once via
  `initWyvernApi({ getSetting, debugLog })` from `WyvernProvider.init()`
  (`wyvern-api.js:41-44`, `wyvern-provider.js:48-52`).
- Capability flags it turns on: `hasView`, `hasAuth`, `supportsInAppPreview`,
  `supportsImport`, `supportsGallery`, `supportsBulkLink`, plus
  `supportsFollowingManager` and `hasModeToggle` on the view.

Base hosts (`wyvern-api.js:11-13`):

- `WYVERN_API_BASE = 'https://api.wyvern.chat'`
- `WYVERN_SITE_BASE = 'https://app.wyvern.chat'`
- `WYVERN_IMAGE_BASE = 'https://imagedelivery.net/Dv4koOwHQU3XnXLqtl0aVQ/'` (Cloudflare Images CDN)

## 2. Server plugin (cl-helper)

**No cl-helper involvement.** A case-insensitive grep of
`extras/cl-helper/index.js` for "wyvern" returns **zero matches**. cl-helper
defines routes for other providers (e.g. `/pyg-login`, `/botbooru-login`,
`/ct-*`, `/dc-*`, `/civitai-*`, `/saucepan-proxy`, `/dropbox-proxy` — see
`extras/cl-helper/index.js:529`, `582`, `638`, `852`, `1260`, `1493`, `1516`),
but nothing for Wyvern.

Wyvern runs entirely browser-side:

- All Wyvern API calls go through `fetchWithProxy` from `provider-utils.js`
  (re-exported at `wyvern-api.js:68`, imported in browse/provider).
- `fetchWithProxy` (`provider-utils.js:163`) attempts a **direct browser
  `fetch(url)` first**; only on CORS/network failure does it fall back to
  SillyTavern's built-in `/proxy/<encoded-url>` endpoint
  (`provider-utils.js:178`) — which is ST core's CORS proxy, **not** cl-helper.
- Firebase auth calls (`firebaseSignIn`, `firebaseRefreshToken`) use plain
  `fetch()` directly to Google endpoints (`wyvern-api.js:81`, `100`).

So Wyvern is the canonical "no server plugin, browser-side fetch + ST CORS
proxy, normal Bearer auth" baseline. The verification holds.

## 3. Authentication / login

`hasAuth = true` (`wyvern-provider.js:248`). Auth is **Firebase
email/password → Firebase ID token (JWT) used as `Authorization: Bearer`**.

- `firebaseSignIn(email, password)` POSTs to the Firebase Identity Toolkit:
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=<FIREBASE_API_KEY>`
  with body `{ email, password, returnSecureToken: true }`, returning
  `{ idToken, refreshToken, expiresIn }` (`wyvern-api.js:16`, `80-92`).
- `firebaseRefreshToken(refreshToken)` POSTs (form-urlencoded
  `grant_type=refresh_token&refresh_token=...`) to
  `https://securetoken.googleapis.com/v1/token?key=<FIREBASE_API_KEY>`
  (`wyvern-api.js:17`, `99-110`).
- `FIREBASE_API_KEY` is a hard-coded public web API key
  (`wyvern-api.js:15`).
- `getTokenTTL(token)` base64-decodes the JWT payload to read `exp`
  (`wyvern-api.js:117-126`); refresh is scheduled at 80% of TTL
  (`scheduleWyvernTokenRefresh`, `wyvern-browse.js:1158-1195`).

Credential storage (provider settings via `getSettings()`,
`wyvern-provider.js:281-321`):

| Setting key | Type | Purpose |
|---|---|---|
| `wyvernToken` | password | Firebase ID token (Bearer) |
| `wyvernRefreshToken` | password | for silent renewal |
| `wyvernRememberToken` | checkbox | persist creds between sessions |
| `wyvernNsfw` | checkbox | show NSFW content |
| `showWyvernTagline` | checkbox | show tagline in details |

Additional keys written at login but not in `getSettings()`: `wyvernUid`,
`wyvernEmail`, `wyvernPassword` (stored when "Remember credentials" is checked,
`wyvern-browse.js:1075-1085`).

Header building: `getWyvernHeaders(includeAuth=true)` returns
`{ Accept: 'application/json' }` plus `Authorization: Bearer <wyvernToken>`
when a token exists (`wyvern-api.js:59-66`). The provider also exposes
`getAuthHeaders()` (`wyvern-provider.js:258-261`) and `_getHeaders()` which
merges `Accept` + auth (`wyvern-provider.js:471-474`).

`isAuthenticated` is `!!getSetting('wyvernToken')` (`wyvern-provider.js:250-252`).
`openAuthUI()` calls `window.openWyvernLoginModal()` (`wyvern-provider.js:254-256`),
defined/exposed in browse (`wyvern-browse.js:1312`, `2961`). Login modal is
`#wyvernLoginModal` (`_renderLoginModal`, `wyvern-browse.js:449-497`). Auto-login /
silent token recovery: `tryWyvernAutoLogin` + `attemptWyvernTokenRecovery`
(`wyvern-browse.js:1204-1259`), called from `view.activate` (`wyvern-browse.js:681`).
`window.wyvernLoginCheck(email, password)` is a thin wrapper for external
callers (`wyvern-provider.js:494-503`).

Note: auth is optional for browsing — anonymous browse/search works; login
unlocks NSFW in all sort modes, the Following timeline, recommendations, and
follow actions (see the login modal copy, `wyvern-browse.js:458-465`).

## 4. Data source

REST API at `api.wyvern.chat`, fetched browser-side via `fetchWithProxy`.
Endpoints used:

- `GET /characters/{charId}` — single character metadata
  (`wyvern-api.js:153`; also `wyvern-provider.js:125`, `204`;
  `wyvern-browse.js:2733`).
- `GET /exploreSearch/characters?...` — browse/search grid
  (`wyvern-browse.js:1693`, `1757`; bulk-link `wyvern-provider.js:346`).
- `GET /recommendations/characters?limit=48` — auth-only recommended sort
  (`wyvern-browse.js:1642`).
- `GET /exploreSearch/users?q=...&page=&limit=` — creator search
  (`wyvern-browse.js:1584`, `748`).
- `GET /characters/user/{uid}` — a creator's characters
  (`wyvern-browse.js:2078`).
- `GET /unified-feed?contentType=character&source=following&...` — Following
  timeline (`wyvern-browse.js:1889`).
- `GET /users/{uid}/follow` and `/unfollow` — follow toggles
  (`wyvern-browse.js:765`, `787`, `2164`).
- `GET /users/{uid}/followers?...` — follow-status check
  (`wyvern-browse.js:2118`).

**Canonical ID format:** Wyvern character nanoid string, e.g.
`_LbhnWCqY3xnBnpaAa8qYt` (documented at `wyvern-api.js:143`). It is stored as
`extensions.wyvern.id` and used everywhere as both `id` and `fullPath`.

Metadata fetch has a 3-entry LRU cache with a 10-minute TTL:
`wyvernMetadataCache`, `WYVERN_METADATA_CACHE_MAX = 3`,
`WYVERN_CACHE_TTL = 10*60*1000` (`wyvern-api.js:132-171`). The preview modal
keeps a separate 5-entry detail cache `wyvernDetailCache` /
`WYVERN_DETAIL_CACHE_MAX` (`wyvern-browse.js:88-89`, `2752-2756`).

## 5. Browse & filtering

`renderFilterBar()` (`wyvern-browse.js:296-362`) emits:

- **Mode toggle** `.wyvern-view-btn` Browse / Following
  (`data-wyvern-view`, `wyvern-browse.js:298-306`). `hasModeToggle = true`
  (`wyvern-browse.js:254`).
- **Sort `<select>` `#wyvernSortSelect`** with options: Popular,
  Popular NSFW (`nsfw-popular`), Recommended, New (`created_at`),
  Most Likes (`votes`), Most Messages (`messages`)
  (`wyvern-browse.js:310-317`; mirrors `WYVERN_SORT_OPTIONS`
  `wyvern-api.js:20-27` and `getSettingsConfig` `wyvern-browse.js:262-276`).
- **Tag filter dropdown** `#wyvernTagsBtn` / `#wyvernTagsDropdown` with a
  searchable tri-state (include/exclude/neutral) tag list
  (`#wyvernTagsList`); state stored in `wyvernTagFilters`
  (`Map<tag,'include'|'exclude'>`, `wyvern-browse.js:70`). Include tags go to
  the API `tags=` param; exclude tags are filtered client-side
  (`wyvern-browse.js:1664-1671`, `2241-2255`). Popular tags are harvested from
  result sets, not a dedicated endpoint (`extractWyvernTagsFromResults`,
  `wyvern-browse.js:1532-1556`).
- **Features dropdown** `#wyvernFiltersBtn` with checkboxes:
  `#wyvernFilterLorebook`, `#wyvernFilterGreetings`,
  `#wyvernFilterHideOwned`, `#wyvernFilterHidePossible`
  (`wyvern-browse.js:341-349`). All applied client-side in `renderWyvernGrid`
  (`wyvern-browse.js:2235-2261`).
- **NSFW toggle** `#wyvernNsfwToggle` (`wyvern-browse.js:353-355`) — toggles
  `wyvernNsfw` setting and reloads.
- **Refresh** `#refreshWyvernBtn` (`wyvern-browse.js:358-360`).

`renderView()` (`wyvern-browse.js:366-441`) adds a character search bar
`#wyvernSearchInput`, a creator search `#wyvernCreatorSearchInput`, a creator
filter banner `#wyvernCreatorBanner`, the results grid `#wyvernGrid`, a
"Load More" block, and the separate `#wyvernFollowingSection` timeline.

Grid loading: `loadWyvernCharacters()` (`wyvern-browse.js:1612-1803`) — 48 per
page, infinite scroll via `canLoadMore`/`loadMore` (`wyvern-browse.js:278-292`),
generation counter `wyvernLoadGeneration` to discard stale responses, and an
auto-fetch loop (up to 3 extra pages) when client-side filters thin out a page
(`wyvern-browse.js:1748-1774`). NSFW rating handling: omit `rating` when
authed+NSFW, special-case `nsfw-popular`, else `rating=none`
(`wyvern-browse.js:1682-1688`). Cards built by `createWyvernCard`
(`wyvern-browse.js:2336-2392`) with lazy `data-src` images and in-library /
possible-match badges.

## 6. Preview / detail modal

`supportsInAppPreview = true` (`wyvern-provider.js:117`).
`openPreview(previewChar)` → `window.openWyvernCharPreview(...)`
(`wyvern-provider.js:140-142`, exposed `wyvern-browse.js:2960`).
`previewModalId = 'wyvernCharModal'` (`wyvern-browse.js:231`).

Modal markup `#wyvernCharModal` (`_renderPreviewModal`,
`wyvern-browse.js:499-625`), class `.modal-glass.browse-char-modal`. Key
element IDs / fields:

- Header: `#wyvernCharAvatar` (`.browse-char-avatar`), `#wyvernCharName`,
  `#wyvernCharCreator` (clickable → creator filter), `#wyvernCharMessages`,
  `#wyvernCharLikes`.
- Controls: `#wyvernOpenInBrowserBtn` (Open on Wyvern), `#wyvernDownloadBtn`
  (Import), `#wyvernCharClose`.
- Body sections (each `.browse-char-section`, collapsible
  `.browse-section-title`): tagline `#wyvernCharTaglineSection`, stats
  (`#wyvernCharViews`, `#wyvernCharDate`, `#wyvernCharGreetingsStat`,
  `#wyvernCharGalleryStat`), tags `#wyvernCharTags`, Creator's Notes,
  Description, Personality, Scenario, Example Dialogs, First Message,
  Alternate Greetings (`<details>` lazy-rendered), Gallery
  `#wyvernCharGalleryGrid` (`.browse-gallery-grid`).

`openWyvernCharPreview(char)` (`wyvern-browse.js:2412-2786`) renders slim data
from the grid object immediately, applies inline definition if present, checks
`wyvernDetailCache`, then does an abortable `GET /characters/{id}` to fill
description/personality/scenario/examples/first_mes/alt-greetings/gallery
(`wyvern-browse.js:2729-2758`). Rich text goes through
`safePurify(formatRichText(...), BROWSE_PURIFY_CONFIG)`. Cleanup via
`closeWyvernCharPreview` / `cleanupWyvernCharModal`
(`wyvern-browse.js:2399-2403`, `2788-2819`); the in-flight fetch is aborted
through `wyvernDetailFetchController` (`wyvern-browse.js:2405-2410`).

## 7. Import & card mapping

`supportsImport = true` (`wyvern-provider.js:374`).
`importCharacter(charId, hitData, options)` (`wyvern-provider.js:376-426`):

1. `fetchMetadata(charId)` → `fetchWyvernMetadata` (`wyvern-provider.js:164-166`).
2. `buildCharacterCardFromWyvern(metadata)` builds the V2 card.
3. Stamps `extensions.wyvern = { id, tagline, pageName, linkedAt }`
   (`wyvern-provider.js:389-395`).
4. `assignGalleryId(...)`, downloads the avatar via `fetchWithProxy`
   (`wyvern-provider.js:397-407`), clears the metadata cache, then delegates to
   the shared `importFromPng({ ... })` helper (`wyvern-provider.js:411-421`),
   producing `wyvern_<slug>.png`.

UI entry point `downloadWyvernCharacter()` (`wyvern-browse.js:2825-2957`)
does a pre-import duplicate check (`checkCharacterForDuplicatesAsync` →
`showPreImportDuplicateWarning`, with skip/replace, replace inheriting the
`gallery_id`), calls `provider.importCharacter`, then shows the import summary
modal (gallery / embedded media) and refreshes the local library.

**Source → V2 mapping** (`buildCharacterCardFromWyvern`,
`wyvern-api.js:231-285`); output is `{ spec:'chara_card_v2', spec_version:'2.0', data:{...} }`:

| Wyvern field | V2 `data.*` |
|---|---|
| `name` | `name` |
| `description` (+ `shared_info` appended after `---`) | `description` |
| `personality` | `personality` |
| `scenario` | `scenario` |
| `first_mes` | `first_mes` |
| `mes_example` | `mes_example` |
| `creator_notes` | `creator_notes` |
| `pre_history_instructions` | `system_prompt` |
| `post_history_instructions` | `post_history_instructions` |
| `alternate_greetings` | `alternate_greetings` |
| `tags` | `tags` |
| `creator.displayName \|\| creator.username` | `creator` |
| `character_note` | `extensions.depth_prompt` `{ prompt, depth:4, role:'system' }` |
| `lorebooks[0]` | `data.character_book` (V2), via `convertWyvernLorebook` |
| `id` / `tagline` / `visual_description` | `extensions.wyvern.{id,tagline,visual_description}` + `linkedAt` |

`convertWyvernLorebook` (`wyvern-api.js:293-324`) maps the first lorebook
(V2 supports one) and normalizes entries to V2 fields
(keys, secondary_keys, content, insertion_order, position before/after_char, …).

## 8. Linking & update checks

- `getLinkInfo(char)` reads `extensions.wyvern.id`, returns
  `{ providerId:'wyvern', id, fullPath:id, linkedAt }`
  (`wyvern-provider.js:72-87`).
- `setLinkInfo(char, linkInfo)` writes/deletes `data.extensions.wyvern`
  `{ id, linkedAt, pageName }` (`wyvern-provider.js:89-104`).
- `getCharacterUrl(linkInfo)` → `getCharacterPageUrl(id)`
  (`wyvern-provider.js:106-109`).
- `openLinkUI(char)` → `CoreAPI.openProviderLinkModal(char)`
  (`wyvern-provider.js:111-113`).

Update checks:

- `fetchRemoteCard(linkInfo)` fetches metadata and returns a V2 card via
  `buildCharacterCardFromWyvern`, attaching `_listingName`
  (`wyvern-provider.js:172-186`).
- `normalizeRemoteCard(rawData)` passes through if already
  `chara_card_v2`, else rebuilds (`wyvern-provider.js:188-192`).
- `getComparableFields()` exposes one optional comparable field:
  `extensions.wyvern.tagline` (group "tagline", `wyvern-provider.js:233-244`).
- Link-modal live stats: `fetchLinkStats(linkInfo)` →
  `GET /characters/{id}`, returning `{ stat1:views, stat2:likes, stat3:null }`
  and caching the raw node in `_cachedLinkNode` for reuse
  (`wyvern-provider.js:200-229`). `linkStatFields` declares Views/Likes icons
  (`wyvern-provider.js:38-44`).

Bulk linking: `supportsBulkLink = true` (`wyvern-provider.js:325`),
`openBulkLinkUI()` → `CoreAPI.openBulkAutoLinkModal()`,
`searchForBulkLink(name, creator)` queries `/exploreSearch/characters` and
fuzzy-matches name/creator (`wyvern-provider.js:334-366`).
`searchForImportMatch` reuses it for import duplicate detection
(`wyvern-provider.js:430-448`). `enrichLocalImport` attaches provider info from
an existing `extensions.wyvern.id` on a local PNG (`wyvern-provider.js:146-160`).

## 9. Save / favorites / bookmarks

**No save-card / favorites / bookmark feature.** There is no
`supportsFavorites`, `saveCharacter`, bookmark, or like-toggle hook anywhere in
the wyvern module. The only social action exposed is **following creators**
(not characters):

- View-level: `supportsFollowingManager = true` (`wyvern-browse.js:712`),
  with `getFollowedCreators` / `followCreator` / `unfollowCreator` /
  `browseCreatorFromManager` (`wyvern-browse.js:714-805`). Follow/unfollow hit
  `GET /users/{uid}/follow` and `/unfollow` (`wyvern-browse.js:765`, `787`).
- The creator-filter banner has a Follow/Unfollow button
  `#wyvernFollowCreatorBtn` → `toggleWyvernFollowCreator`
  (`wyvern-browse.js:2149-2192`), and a Following timeline mode backed by
  `GET /unified-feed?source=following` (`wyvern-browse.js:1854-1944`).

So "favorites/bookmarks" for individual cards is **not** part of the Wyvern
baseline; "following" is creator-level only and requires auth.

## 10. Gallery

`supportsGallery = true` (`wyvern-provider.js:452`).
`fetchGalleryImages(linkInfo)` calls `fetchWyvernMetadata(linkInfo.id)` and maps
`data.gallery[]` → `{ url: img.imageURL, id: img.id }`
(`wyvern-provider.js:454-467`). Import flags `hasGallery` from
`metadata.gallery?.length` (`wyvern-provider.js:416`), and the import-summary
gallery entry is built in `downloadWyvernCharacter`
(`wyvern-browse.js:2901-2910`). In the preview modal, gallery thumbnails render
into `#wyvernCharGalleryGrid` and open the shared avatar viewer on click
(`wyvern-browse.js:2678-2695`, `984-994`).

## 11. URL handling

- `canHandleUrl(url)` returns true only when the hostname matches
  `^(www\.)?app\.wyvern\.chat$` (case-insensitive)
  (`wyvern-provider.js:265-273`).
- `parseUrl(url)` → `parseCharacterUrl` (`wyvern-provider.js:275-277`),
  which validates the same host and extracts the id from
  `^/characters/([^/]+)` (`wyvern-api.js:209-219`). Accepts bare hosts by
  prefixing `https://` (`wyvern-api.js:212`).
- `getCharacterPageUrl(id)` builds `${WYVERN_SITE_BASE}/characters/{id}`
  (`wyvern-api.js:199-201`).

Example URLs:

- `https://app.wyvern.chat/characters/_LbhnWCqY3xnBnpaAa8qYt` →
  `canHandleUrl` true, `parseUrl` → `_LbhnWCqY3xnBnpaAa8qYt`.
- `app.wyvern.chat/characters/abc123` (no scheme) → also parses to `abc123`.
- `https://api.wyvern.chat/characters/abc123` → `canHandleUrl` false (wrong host).

## 12. Notable patterns worth copying

Copy Wyvern as the baseline when your new provider is a **public REST API
reachable from the browser with token Bearer auth and no server-side scraping**.
Specifically:

- **No cl-helper, browser-side only.** All requests go through
  `fetchWithProxy` (direct `fetch` first, ST `/proxy/` CORS fallback). If you
  never need cookies, server-side scraping, or signed/extracted tokens, you can
  skip cl-helper entirely — Wyvern is the cleanest template for this.
- **Three-file split.** `*-api.js` (constants, auth, fetch + cache, V2 builder,
  URL helpers) / `*-provider.js` (`ProviderBase` contract) / `*-browse.js`
  (`BrowseView` UI). `init*Api({ getSetting, debugLog })` decouples the API
  layer from `CoreAPI`.
- **Optional auth done well.** Anonymous browse works; a token only unlocks
  premium features. JWT TTL decode + 80%-of-TTL refresh scheduling + silent
  recovery from refresh token / stored creds is a reusable auth pattern
  (`scheduleWyvernTokenRefresh`, `attemptWyvernTokenRecovery`).
- **Two-tier metadata caching + abortable detail fetch.** LRU metadata cache in
  the API layer plus a per-modal detail cache, with `AbortController` so a
  closed/changed preview discards stale responses.
- **Stale-response guards & filter auto-fetch.** The `wyvernLoadGeneration`
  counter and the "fetch up to 3 more pages when client filters thin a page"
  loop are worth reusing for any infinite-scroll grid with client-side filters.
- **Clean V2 mapping with an `extensions.<provider>` namespace** carrying
  `id` + provider-specific fields (`tagline`, `linkedAt`), which then drives
  linking, update comparison (`getComparableFields`), and re-import.

Note what Wyvern does **not** demonstrate: a server plugin, cookie/session auth,
or per-card favorites/bookmarks. For those, copy a different provider
(e.g. the `ct-*`/`dc-*`/`civitai-*` providers that use cl-helper routes).
