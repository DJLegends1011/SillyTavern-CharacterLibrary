# Chub — Provider Anatomy

## 1. Overview
Target site: ChubAI / CharacterHub (`https://chub.ai`, also `characterhub.org`, `venus.chub.ai`). It is a **public REST API aggregator** — the provider talks directly to ChubAI's first-party REST endpoints. Three API hosts are used (`chub-api.js:11-13`):
- `https://api.chub.ai` (`CHUB_API_BASE`) — search, character metadata, V4 Git repo, follows/account.
- `https://gateway.chub.ai` (`CHUB_GATEWAY_BASE`) — gallery and favorites.
- `https://avatars.charhub.io/avatars/` (`CHUB_AVATAR_BASE`) — avatar/card image CDN, also a PNG-card extraction fallback.

Character data comes primarily from REST JSON (`/api/characters/...?full=true`), with two fallbacks: V4 Git `card.json` and embedded-PNG extraction.

## 2. Server plugin (cl-helper)
**No.** A case-insensitive grep for "chub" in `extras/cl-helper/index.js` returns zero matches — there are no chub routes in the server plugin. All networking is browser-side. Calls use `fetch()` directly to the ChubAI hosts, or `fetchWithProxy` (re-exported from `provider-utils.js` via `chub-api.js:54`). The CORS fallback is SillyTavern's generic `/proxy/<encoded-url>` endpoint, tried only when a direct `fetch` throws (e.g. `chub-api.js:104-108`, `190-196`). ChubAI's API sends permissive CORS, so direct browser fetches normally succeed; the proxy is just a safety net. There is no server-side credential exchange, login, or HTML decoding step.

## 3. Authentication / login
**Anonymous-capable.** The login modal states plainly: "Browsing and downloading public characters works without a token!" (`chub-browse.js:599`). Auth is an optional **bearer token** — ChubAI's `URQL_TOKEN`, which the user copies from `chub.ai` localStorage via DevTools (instructions in `_renderLoginModal`, `chub-browse.js:617-634`).

- Stored under setting key **`chubToken`** (declared in `getSettings()`, `chub-provider.js:548-556`); persistence toggled by **`chubRememberToken`**. Saved server-side through ST's settings system via `setSettings()` (`chub-browse.js:1298-1301`).
- Legacy migration: old localStorage key `st_gallery_chub_urql_token` (`CHUB_TOKEN_KEY`, `chub-browse.js:50`) is read once and migrated into settings (`chub-browse.js:1266-1279`).
- Header: `Authorization: Bearer <token>` (`getChubHeaders`, `chub-api.js:45-52`; `getAuthHeaders`, `chub-provider.js:513-516`). Favorites use different header names (`samwise` and `CH-API-KEY`, `chub-browse.js:3957-3958`).
- `hasAuth` = true, `isAuthenticated` = `!!getSetting('chubToken')` (`chub-provider.js:498-502`). `openAuthUI()` opens `#chubLoginModal`.
- What a token unlocks: the **Following/Timeline** view, the **My Favorites** feature-filter, favoriting characters, and any restricted/private content.

## 4. Data source
Primarily **REST JSON**. Canonical metadata endpoint: `https://api.chub.ai/api/characters/{fullPath}?full=true`, returning `data.node` (`fetchChubMetadata`, `chub-api.js:90-172`). Search: `https://api.chub.ai/search?<params>`.

Secondary sources: **V4 Git API** `card.json` for canonical exported state (`/api/v4/projects/{id}/repository/commits` then `/repository/files/raw%252Fcard.json/raw?ref=<ref>`), and an **embedded-PNG** last-resort (`{CHUB_AVATAR_BASE}{fullPath}/chara_card_v2.png` → `extractCharacterDataFromPng`).

Canonical character ID format: **`creator/slug`** (the `fullPath`, e.g. `creator/character-name`). A numeric project `id` also exists and is required for gallery, favorites, lorebook, and Git lookups.

## 5. Browse & filtering
`renderFilterBar()` (`chub-browse.js:380-494`) defines:
- **Mode toggle** (`.chub-view-btn`): **Browse** and **Following** (timeline, requires token). `hasModeToggle` = true.
- **Search**: character search (`#chubSearchInput`) and a separate **creator** search (`#chubCreatorSearchInput`); search modes are `['character','creator']`.
- **Sort/discovery preset** (`#chubDiscoveryPreset`): combined sort+time presets — Hot This Week/Month, Most Downloaded, Top Rated (Week/All), Newest, Recently Updated, Recent Hits, Random (`CHUB_DISCOVERY_PRESETS`, `chub-browse.js:69-79`). Timeline mode has its own client-side sort (`#chubTimelineSortHeader`).
- **Tags dropdown** (`#chubTagsBtn`): tri-state include/exclude tag filters (`chubTagFilters` Map → `topics` / `excludetopics` params) with tag search, plus **Advanced Options**: sort direction (asc/desc), Min Tokens, Max Tokens.
- **Features dropdown** (`#chubFiltersBtn`): require Image Gallery / Lorebook / Expressions / Alt Greetings; **My Favorites** (login-gated); and library filters **Hide Owned** / **Hide Possible Matches**.
- **NSFW toggle** (`#chubNsfwToggle`, default on — `nsfw`+`nsfl` params) and a **Refresh** button.
- **Paging**: page-based for browse (`first=48`, `page=N`, `loadMore` increments `chubCurrentPage`); cursor + per-author supplemental paging for the timeline.
- **Author filter banner** with its own sort and a Follow button.

## 6. Preview / detail modal
A card click calls `openChubCharPreview(char)` (window-exported, `chub-browse.js:4190`), which opens modal `#chubCharModal`. `previewModalId` = `'chubCharModal'` (`chub-browse.js:292`). Shell classes: `.modal-overlay` > `.modal-glass.browse-char-modal` with `.modal-header` / `.browse-char-body` (`_renderPreviewModal`, `chub-browse.js:652-784`). Fields shown: avatar, name, creator (linked to author filter + external profile link), rating, downloads, an inline **favorite** toggle, tagline, stats (tokens, date, greetings, lorebook, gallery count), tags, Creator's Notes, Description, Personality, Scenario, Example Dialogs, First Message, Alternate Greetings, and a Gallery grid. Header buttons: "Open" (on ChubAI) and "Import" (`#chubDownloadBtn`). The provider also supports a separate in-library preview via `supportsInAppPreview`/`buildPreviewObject`/`openPreview` (`chub-provider.js:184-219`).

## 7. Import & card mapping
`supportsImport` = true (`chub-provider.js:689`). `importCharacter(fullPath, hitData, options)` (`chub-provider.js:691-756`) fetches metadata, builds a V2 card via `buildCharacterCardFromChub` (`chub-api.js:252-293`), downloads an avatar through a URL priority chain (max_res → hit avatar → metadata avatar → `avatar.webp` → `avatar.png` → `chara_card_v2.png`), then writes the PNG via `importFromPng`. The browse "Import" button routes through `downloadChubCharacter()` (`chub-browse.js:4044`) which runs duplicate detection, then calls `provider.importCharacter(...)`.

ChubAI field names differ from V2; the mapping (`buildCharacterCardFromChub`, `chub-api.js:266-292`; mirrors ST's `downloadChubCharacter`) is:
- `definition.personality` → `data.description`
- `definition.tavern_personality` → `data.personality`
- `definition.first_message` → `data.first_mes`
- `definition.example_dialogs` → `data.mes_example`
- `definition.description` → `data.creator_notes`
- `definition.scenario/system_prompt/post_history_instructions/alternate_greetings/character_version` → same V2 keys
- `definition.embedded_lorebook` (or V4-linked lorebook) → `data.character_book`
- metadata `topics` → `data.tags`; `fullPath.split('/')[0]` → `data.creator`

Provider-namespaced extension `data.extensions.chub` is populated on import (`chub-provider.js:711-718`): `{ id, full_path, tagline, pageName, linkedAt }`. The tagline is also stored under `data.extensions.chub.tagline` by the card builder. `normalizeRemoteCard()` delegates to `normalizeToV2()` (`chub-provider.js:312-314`, `37-66`).

## 8. Linking & update checks
- `getLinkInfo(char)` reads `data.extensions.chub`, requiring `fullPath`/`full_path`; returns `{ providerId:'chub', id, fullPath, linkedAt }` (`chub-provider.js:138-153`).
- `setLinkInfo(char, linkInfo)` writes `extensions.chub = { id, full_path, linkedAt, pageName }`; passing `null` deletes it (`chub-provider.js:155-171`).
- `getCharacterUrl` → `https://chub.ai/characters/{fullPath}`.
- `getComparableFields()` returns a **single** optional field: `extensions.chub.tagline` (label "Chub Tagline", group "tagline") — the only chub-specific diff field (`chub-provider.js:369-380`).
- `fetchRemoteCard(linkInfo)` (`chub-provider.js:255-310`) is a 3-tier pipeline: V4 Git `card.json` (when `chubUseV4Api` enabled), metadata-API mapping, then PNG extraction.
- `fetchLinkStats` (`chub-provider.js:329-350`) returns live `{stat1: starCount, stat2: n_favorites, stat3: nTokens}` and caches the raw node in `_cachedLinkNode` for the link modal's "View on" action.
- Version history: `supportsVersionHistory` + `supportsRemotePageVersion` = true; `remoteVersionLabel` = "Chub Page". `fetchVersionList` maps V4 commits; `fetchVersionData(ref)` pulls `card.json` at a commit; `fetchRemotePageCard` builds the current published state from metadata (`chub-provider.js:382-494`).

## 9. Save / favorites / bookmarks
**Account-backed favorites (no local bookmarks).** Favoriting is a ChubAI server action: `POST`/`DELETE https://gateway.chub.ai/api/favorites/{numericId}` with headers `samwise` + `CH-API-KEY` set to the token and an empty `{}` body (`toggleChubCharFavorite`, `chub-browse.js:3949-3961`). Requires login. There is no local-only bookmark store in this provider.

Following Manager hooks are fully implemented on the browse view:
- `supportsFollowingManager` = true (`chub-browse.js:217`).
- `getFollowedCreators()` → derived from `fetchMyFollowsList()` (account → `/api/account`, then `/api/follows/{username}?page=N`, `chub-browse.js:2509-2568`).
- `followCreator(query)` → `POST {CHUB_API_BASE}/api/follow/{username}` (`chub-browse.js:240-267`).
- `unfollowCreator(id)` → `DELETE {CHUB_API_BASE}/api/follow/{id}` (`chub-browse.js:269-285`).
- `browseCreatorFromManager(creator)` jumps into the author-filtered browse view.

## 10. Gallery
`supportsGallery` = true (`chub-provider.js:760`). `fetchGalleryImages(linkInfo)` (`chub-provider.js:762-779`) requires the numeric `linkInfo.id` and hits `https://gateway.chub.ai/api/gallery/project/{id}?limit=100&count=false`, mapping nodes to `{ url: primary_image_path, id: uuid, nsfw: nsfw_image }`. The detail modal renders a gallery grid; setting `includeProviderGallery` (default true) governs gallery inclusion.

## 11. URL handling
`canHandleUrl(url)` (`chub-provider.js:520-530`) matches hostnames `chub.ai` / `www.chub.ai`, `characterhub.org` / `www.characterhub.org`, and `venus.chub.ai`. `parseUrl(url)` (`chub-provider.js:532-543`) strips a leading `/characters/` and returns the first two path segments as `creator/slug`. Recognized examples: `https://chub.ai/characters/creator/slug`, `https://chub.ai/creator/slug`, `characterhub.org/characters/creator/slug`.

## 12. Notable patterns worth copying
- **Clean two-file split + shared helper**: `chub-provider.js` (provider contract / data pipeline), `chub-browse.js` (`BrowseView` subclass / UI), and `chub-api.js` (constants, headers, fetch helpers, V2 card builder, LRU cache). A good baseline for any **public-REST aggregator** provider with a rich browse UI.
- **Direct-fetch-then-`/proxy/` fallback** pattern (`chub-api.js:102-108`) — copy this for any provider whose API normally allows CORS but may occasionally be blocked, avoiding a mandatory server plugin.
- **Layered remote-card pipeline** (`fetchRemoteCard`: structured API → V4 Git canonical → PNG extraction) — a strong template when a source exposes multiple representations of the same card.
- **Optional-token model**: anonymous browse/import works; the token only unlocks account features (favorites, following). Copy this for sites where login is optional rather than required.
- **Field-name remapping in one canonical builder** (`buildCharacterCardFromChub`) plus a `normalizeToV2` flattener — ideal reference for any provider whose API uses non-V2 field names.
- **Full Following-Manager + account-backed favorites** implementation — the reference to copy for any provider that has server-side social features (follows/favorites) keyed by an account token.
