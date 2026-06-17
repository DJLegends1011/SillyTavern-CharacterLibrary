# Chartavern — Provider Anatomy

> Reference notes for the **chartavern** provider (site: CharacterTavern, `character-tavern.com`). Use this as a worked example when writing a new "how to add a provider" guide.
>
> Source files:
> - `modules/providers/chartavern/chartavern-api.js` — shared constants, network, auth, API calls, URL helpers
> - `modules/providers/chartavern/chartavern-provider.js` — `ChartavernProvider extends ProviderBase` (identity, import, linking, auth surface)
> - `modules/providers/chartavern/chartavern-browse.js` — `ChartavernBrowseView extends BrowseView` (UI, search, preview modal, login UI)
> - `modules/providers/chartavern/chartavern-browse.css` — provider-specific CSS (login modal only)
> - `extras/cl-helper/index.js` — server plugin routes (`registerCharacterTavernRoutes`)

## 1. Overview

- **Site / kind:** CharacterTavern (`https://character-tavern.com`), a public character-card hosting site. The provider is a **read-only browse + import** provider — it lists characters, previews them, and imports their V2 cards into the local SillyTavern library. No upload, no posting, no version history, no gallery.
- **Provider id / name / icon:** `id = 'chartavern'`, `name = 'CharacterTavern'`, `icon = 'fa-solid fa-beer-mug-empty'`, `iconUrl = https://character-tavern.com/favicon.ico` (`chartavern-provider.js:117-120`).
- **Key base URLs** (`chartavern-api.js:13-15`):
  - `CT_API_BASE = https://character-tavern.com/api`
  - `CT_SITE_BASE = https://character-tavern.com`
  - `CT_CARDS_CDN = https://cards.character-tavern.com` (Cloudflare-resized images + full card PNGs)
- **Class wiring:** the provider is a thin shell — it delegates the entire UI (`activate`/`renderView`/`renderFilterBar`/`renderModals`/preview) to the singleton `chartavernBrowseView` (`chartavern-provider.js:121,138-152`). Most real logic lives in `chartavern-browse.js` and `chartavern-api.js`.

## 2. Server plugin (cl-helper)

**Yes — it routes through `extras/cl-helper` for authenticated (NSFW) requests only.** Anonymous browsing/import bypass the plugin and go direct via `fetchWithProxy`.

- Plugin base: `CL_HELPER_PLUGIN_BASE = '/plugins/cl-helper'` (`provider-utils.js:14`), re-exported from `chartavern-api.js:10-11` as `CL_HELPER_CT_BASE`.
- Routes are registered by `registerCharacterTavernRoutes(router)` (`extras/cl-helper/index.js:629`, wired at `index.js:1854`). Note: grepping for "chartavern" in cl-helper finds **nothing** — the server side uses the **`ct-` / "CharacterTavern" naming**, not "chartavern".

Routes and why they exist:

| Route | Method | Purpose | Client caller |
|---|---|---|---|
| `/plugins/cl-helper/health` | GET | Detect plugin presence (`{ ok: true }`) | `checkCtPluginAvailable` (`chartavern-api.js:44`) |
| `/plugins/cl-helper/ct-session` | GET | Is a session active? `{ active }` (`index.js:731`) | `checkCtSession` (`chartavern-api.js:60`) |
| `/plugins/cl-helper/ct-set-cookie` | POST | Store session cookie server-side. Body `{ cookie }`, accepts bare value or `session=VALUE`; rejects multi-cookie / `;` / >4096 chars (`index.js:638-664`) | `ctSetCookie` (`chartavern-api.js:79`) |
| `/plugins/cl-helper/ct-validate` | GET | Test stored cookie by hitting CT search for "sara+lane"; returns `{ valid, hasNsfw, reason }` (`index.js:671-715`) | `ctValidateSession` (`chartavern-api.js:105`) |
| `/plugins/cl-helper/ct-logout` | POST | Clear stored cookie (`index.js:721`) | `ctLogout` (`chartavern-api.js:124`) |
| `/plugins/cl-helper/ct-proxy/*` | GET | Read-only proxy to `character-tavern.com` with stored cookie attached (`index.js:741`) | `ctFetch` (`chartavern-api.js:142-150`) |

**Why a plugin is needed:** the browser cannot send CharacterTavern's `session` cookie cross-origin, and NSFW results require that cookie. The plugin holds the cookie **in memory only** (`let ctSessionCookies = null`, `index.js:620`; lost on server restart) and attaches it to outbound requests. The `/ct-proxy/*` route is **path-allowlisted** to read-only API endpoints to avoid being an open relay — `CT_ALLOWED_PATHS` (`index.js:623-627`): `/api/search/cards`, `/api/character/{a}/{s}`, `/api/catalog/top-tags`. It also re-verifies the resolved hostname is `character-tavern.com` (`index.js:756`).

**Request routing logic** (`ctFetch`, `chartavern-api.js:142-150`): if a session is active and `apiRequest` is available, it strips `CT_SITE_BASE` from the target URL and re-issues it through `${CL_HELPER_CT_BASE}/ct-proxy${path}`; otherwise it falls back to `fetchWithProxy(url)` (direct/anonymous). `fetchTopTags` always goes direct (`chartavern-api.js:226`).

## 3. Authentication / login

- **Model:** optional **session-cookie pass-through**. Auth is purely to unlock NSFW-tagged content; all SFW browsing and importing work logged-out.
- `hasAuth = true`; `isAuthenticated` returns `isCtSessionActive()` — a module-level boolean in `chartavern-api.js` (`ctSessionActive`, lines 37/132), set true after a successful `ctSetCookie`/`ctValidateSession`. `getAuthHeaders()` returns `{}` (auth lives in the plugin's stored cookie, not in client headers) (`chartavern-provider.js:444-454`).
- `openAuthUI()` calls `window.openCtLoginModal?.()` (`chartavern-provider.js:450`), exposed at `chartavern-browse.js:1988`.
- **Credential storage setting key:** `ctCookie` (textarea, section "Authentication") declared in `getSettings()` (`chartavern-provider.js:474-485`). Also `ctNsfw` (boolean) persists the NSFW toggle. Both are read/written via `getSetting`/`setSetting` (`chartavern-browse.js:1388,1460-1491`).
- **Login flow** (`chartavern-browse.js`): `openCtLoginModal` → `checkCtPluginAvailable` + `checkCtSession` → `updateCtLoginUI`. User pastes cookie → `saveCookieAndConnect` (`:1438`) → `ctSetCookie` then `ctValidateSession`; on success saves `ctCookie`, enables NSFW, reloads. `tryCheckSession` (`:1504`) auto-restores from saved `ctCookie` on view init and clears it when expired (CT session expires ~10 days, noted in the modal at `:1761`).
- Cookie acquisition is manual: the user copies the `session` cookie from browser DevTools (instructions baked into the login modal HTML, `chartavern-browse.js:1752-1762`). The `ctValidate` also reports `hasNsfw`, used to warn if content prefs aren't enabled (`chartavern-browse.js:1468-1471`).

## 4. Data source

- **REST JSON API** at `CT_API_BASE` (`https://character-tavern.com/api`), three endpoints (all GET):
  - `GET /api/search/cards?query=&sort=&page=&limit=&tags=&exclude_tags=&minimum_tokens=&maximum_tokens=&hasLorebook=&isOC=` → `{ hits, totalHits, totalPages, page }` (`searchCards`, `chartavern-api.js:162-202`).
  - `GET /api/character/{author}/{slug}` → `{ card, ownerCTId }` (`fetchCharacterDetail`, `chartavern-api.js:211-218`).
  - `GET /api/catalog/top-tags` → `[{ tag, count }]` (`fetchTopTags`, `chartavern-api.js:224-228`).
- **Card image / import source:** the **CDN PNG** with embedded V2 data: `https://cards.character-tavern.com/{author}/{slug}.png` (`getCardPngUrl`, `chartavern-api.js:250-252`). Thumbnails use Cloudflare resize: `https://cards.character-tavern.com/cdn-cgi/image/format=auto,width=320,quality=85/{author}/{slug}.png` (`getAvatarUrl`, `chartavern-api.js:241-243`).
- **Canonical ID format:** a `path` string of the form **`author/slug`** (a.k.a. `fullPath`). This is THE identifier threaded through everything — search hits expose `hit.path`, links store `extensions.chartavern.path`, and helpers split on `/` to get `[author, slug]`. There is also a numeric `card.id`, stored as `extensions.chartavern.id`, but `path` is the primary key (`getLinkInfo` returns `null` if `path` is missing, `chartavern-provider.js:162-163`).
- **Sort options** (`CT_SORT_OPTIONS`, `chartavern-api.js:18-24`): `most_popular`, `trending`, `newest`, `oldest`, `most_likes`.
- **NSFW handling:** the API has no explicit NSFW flag — `searchCards` instead appends `nsfw` to `exclude_tags` when `nsfw=false` (`chartavern-api.js:189-194`), and the browse layer additionally client-side-filters `h.isNSFW` hits (`chartavern-browse.js:314-316`).

## 5. Browse & filtering

`renderFilterBar()` (`chartavern-browse.js:1595-1662`) renders these controls:

- **Sort `<select id="ctSortSelect">`** with the five `CT_SORT_OPTIONS` (converted to a custom dropdown via `CoreAPI.initCustomSelect`, `:1043`).
- **Tags dropdown (`#ctTagsBtn` / `#ctTagsDropdown`)** — lazy-loads top tags (`fetchTopTags`) on first open; each tag cycles **neutral → include → exclude → neutral** (`renderTagsList`/`cycleTagState`, `:923-1007`), tracked in `ctIncludeTags`/`ctExcludeTags` Sets and sent as `tags` / `exclude_tags`. Includes a tag search box and a clear button.
- **Advanced options inside the Tags dropdown:** `#ctMinTokens` and `#ctMaxTokens` number inputs → `minimum_tokens` / `maximum_tokens` (debounced, `:1163-1177`).
- **Features dropdown (`#ctFiltersBtn` / `#ctFiltersDropdown`)** with checkboxes:
  - `#ctFilterHasLorebook` → API `hasLorebook=true`
  - `#ctFilterIsOC` → API `isOC=true`
  - `#ctFilterHideOwned` → client-side, drops hits already in the local library
  - `#ctFilterHidePossible` → client-side, drops fuzzy name/creator matches
- **NSFW toggle (`#ctNsfwToggle`)** — gated: clicking it without an active session shows a toast and opens the login modal (`:1100-1111`).
- **Refresh button `#ctRefreshBtn`**, plus the main search box `#ctSearchInput` (in `renderView`, `:1672`) and an **author banner** (`#ctAuthorBanner`) for "all characters by author" pseudo-filtering (keyword search on the author name, `filterByAuthor`, `:1320`).

Loading: `loadCharacters(append)` (`:263`) builds opts, merges provider-level exclude tags via `getProviderExcludeTags('chartavern')` (`:293`), uses a `ctLoadToken` generation counter to discard stale responses, and **auto-fetches up to 3 extra pages** when client-side filters thin out a page below 60 results (`:328-345`). `limit` is 60 in browse but 30 default in the API helper. Grid cards are built by `createCtCard` (`:173`) with lazy-loaded images and in-library / possible-match badges.

## 6. Preview / detail modal

- **Modal shell:** `#ctCharModal` with classes `.modal-overlay` → `.modal-glass.browse-char-modal` → `.browse-char-body` (`_renderPreviewModal`, `chartavern-browse.js:1784-1895`). `previewModalId` getter returns `'ctCharModal'` (`:1563`). Registered as an overlay at tier 7 (`:1295`).
- **Header fields:** `#ctCharAvatar`, `#ctCharName`, creator link `#ctCharCreator` (click → `filterByAuthor`), `#ctOpenInBrowserBtn` (deep link to the CT page), `#ctImportBtn`, `#ctCharClose`.
- **Body fields:** tagline (`#ctCharTaglineSection`/`#ctCharTagline`), a stats grid (`#ctCharTokens`, `#ctCharDownloads`, `#ctCharLikes`, `#ctCharDate`, `#ctCharGreetingsStat`, `#ctCharLorebookStat`), tags (`#ctCharTags`), and collapsible sections: Creator's Notes, Description, Scenario, Example Dialogs, First Message, Alternate Greetings (each `.browse-char-section` with a `.browse-section-title`).
- **Population:** `openPreviewModal(hit)` (`:404`) fills from the search hit immediately (showing `skeletonLines` placeholders), then RAF-defers `safePurify(formatRichText(...), BROWSE_PURIFY_CONFIG)` rendering so it doesn't block paint. If the hit has no character definition, `fetchAndPopulateDetails` (`:644`) calls `fetchCharacterDetail` to backfill description/scenario/first-message/examples (mapped from the `definition_*` fields) using a `ctDetailFetchToken` to guard against stale fetches.
- **Reuse:** classes are all the shared `browse-*` set from `provider-utils.js` / `browse-view.js`. Only login-modal classes (`.ct-login-disabled`, `.ct-cookie-instructions`, `.ct-cookie-note`) are provider-specific CSS (`chartavern-browse.css`).
- **External entry point:** `window.openCtCharPreview(hit)` (`:1984`) lets `library.js` open this modal for an already-linked local character (via `provider.openPreview` → `buildPreviewObject`, `chartavern-provider.js:204-235`).

## 7. Import & card mapping

- `supportsImport = true` (`chartavern-provider.js:512`).
- **Provider-level `importCharacter(path, hitData, options)`** (`chartavern-provider.js:524-620`):
  1. Split `path` into `author/slug`; fetch `fetchCharacterDetail` for the rich card.
  2. Build a V2 card via `buildV2FromDetail` (or `buildV2FromSearchHit` if detail fails).
  3. Backfill tags from hit/search if detail returned none.
  4. Stamp `extensions.chartavern = { id, path, linkedAt, tagline, pageName }`.
  5. `assignGalleryId(...)`.
  6. **Download the CDN PNG** (`getCardPngUrl(path)`) — the canonical embedded-V2 source — and use `api.extractCharacterDataFromPng` to recover fields the detail API omits: `alternate_greetings`, `tags`, and `character_book` (lorebook) (`:588-605`).
  7. Hand off to shared `importFromPng({ characterCard, imageBuffer, fileName: ct_<slug>.png, providerCharId, fullPath, avatarUrl, api })`.
- **Browse-level `importCharacter(charData)`** (`chartavern-browse.js:767-883`) wraps the provider call with duplicate detection (`checkCharacterForDuplicatesAsync` → `showPreImportDuplicateWarning` with skip/replace), then refreshes the library (`fetchAndAddCharacter`) and marks the grid card imported.

**Source → V2 field mapping** — `buildV2FromDetail(card, authorName, altGreetings)` (`chartavern-provider.js:46-74`), detail-API field names:

| CT detail field | V2 `data.*` |
|---|---|
| `name` | `name` |
| `definition_character_description` | `description` |
| `definition_personality` | `personality` |
| `definition_scenario` | `scenario` |
| `definition_first_message` | `first_mes` |
| `definition_example_messages` | `mes_example` |
| `definition_system_prompt` | `system_prompt` |
| `definition_post_history_prompt` | `post_history_instructions` |
| `description` | `creator_notes` |
| `authorName` (arg) | `creator` |
| `tags` (via `parseTags`) | `tags` |
| `altGreetings` (arg) | `alternate_greetings` |
| `id`, `path`, `tagline` | `extensions.chartavern.{id,path,tagline}` |

`buildV2FromSearchHit(hit)` (`:80-108`) maps the **search-hit** field names instead: `characterDefinition`→description, `characterPersonality`→personality, `characterScenario`→scenario, `characterFirstMessage`→first_mes, `characterExampleMessages`→mes_example, `characterPostHistoryPrompt`→post_history_instructions, `pageDescription`→creator_notes, `alternativeFirstMessage`→alternate_greetings. `normalizeRemoteCard(rawData)` (`:418`) is just `buildV2FromDetail(rawData, '')`.

## 8. Linking & update checks

- **`getLinkInfo(char)`** (`:156-171`): reads `extensions.chartavern`; requires `path`; returns `{ providerId:'chartavern', id, fullPath: path, linkedAt }`.
- **`setLinkInfo(char, linkInfo)`** (`:173-189`): writes `extensions.chartavern = { id, path, linkedAt, pageName }`, or deletes it when `linkInfo` is null.
- **`getCharacterUrl(linkInfo)`** → `getCharacterPageUrl(fullPath)` = `https://character-tavern.com/character/{author}/{slug}`.
- **`fetchRemoteCard(linkInfo)`** (`:374-416`): **primary path** = download the CDN PNG and `extractCharacterDataFromPng` (the only source with alt-greetings), then enrich with detail-API-only fields (`system_prompt`, `tagline`). **Fallback** = `buildV2FromDetail` from the detail API alone. Both stamp `_listingName`.
- **`fetchMetadata(fullPath)`** (`:361-372`): returns the raw detail `card`.
- **`fetchLinkStats(linkInfo)`** (`:326-357`): returns `{ stat1: analytics_downloads, stat2: likes (from a search-hit lookup), stat3: tokenTotal }`, matching `linkStatFields` (Downloads / Likes / Tokens, `:123-129`).
- **`getComparableFields()`** (`:424-435`): only **one** comparable field — `extensions.chartavern.tagline` (labeled "CT Tagline", `optional`, group "tagline"). The actual definitions aren't diffed because CT exposes no commit/version history.
- **`supportsVersionHistory = false`** (`:440`) — CT has no public version/commit API.
- **Bulk auto-link:** `supportsBulkLink = true`; `searchForBulkLink(name)` searches by card name (CT search indexes names/descriptions, not usernames) and normalizes hits via `_normalizeSearchResult` (`:495-504, 651-663`). `enrichLocalImport` (`:239-322`) and `searchForImportMatch` (`:629-647`) auto-link imported cards by **exact name + exact creator-segment match** (strict, to avoid false links).

## 9. Save / favorites / bookmarks

**None.** CharacterTavern's read-only proxy exposes no write endpoints, so the provider implements **no account favorites, no following-manager hooks, and no local bookmarks.** Evidence:

- `followingSortOptions: []` and `viewModes: []` in `getSettingsConfig()` (`chartavern-browse.js:1574-1576`) — no "Following"/saved view.
- No `favorite*`, `bookmark*`, or following-manager methods exist on `ChartavernProvider` (the class has linking/import/auth/bulk-link only).
- The cl-helper proxy is GET-only and path-allowlisted to three read endpoints (`index.js:623-627`), so a "save to my CT account" action is not even reachable.

The only "save"-like concept is **importing** the card into the local library (section 7) and the local in-library / possible-match badging (`isCharInLocalLibrary`, `:90`).

## 10. Gallery

**None.** `supportsGallery = false` (`chartavern-provider.js:625`). CT has no gallery API, and `hasGallery: false` is passed throughout import (`:251, 316, 611, 639`). `fetchGalleryImages` is not implemented. Avatar/full-PNG image URLs exist (`getAvatarUrl`/`getCardPngUrl`) but there is no multi-image gallery per character.

## 11. URL handling

- **`canHandleUrl(url)`** (`chartavern-provider.js:458-466`): true when the hostname matches `^(www\.)?character-tavern\.com$` (case-insensitive), tolerating a missing scheme.
- **`parseUrl(url)`** → `parseCharacterUrl(url)` (`chartavern-api.js:269-278`): validates host, then matches `^/character/([^/]+)/([^/]+)` and returns `"author/slug"` (the canonical `fullPath`), else `null`.
- **Example URLs:**
  - `https://character-tavern.com/character/SomeAuthor/cool-bot` → `"SomeAuthor/cool-bot"` ✅
  - `character-tavern.com/character/SomeAuthor/cool-bot` (no scheme) → `"SomeAuthor/cool-bot"` ✅
  - `https://www.character-tavern.com/character/A/b` → `"A/b"` ✅
  - `https://character-tavern.com/browse` → `null` (no `/character/` segment)
  - `https://chub.ai/characters/x/y` → `null` (wrong host; `canHandleUrl` false)

## 12. Notable patterns worth copying

Copy chartavern as a baseline when building a provider that is: **a public, read-only character site exposing a JSON search API plus PNG-with-embedded-V2 cards on a CDN, where login is optional and only needed to widen content (e.g., NSFW).** Specifically reuse:

- **Optional-auth via cl-helper cookie pass-through.** The `ct-set-cookie` / `ct-validate` / `ct-session` / `ct-logout` + path-allowlisted `ct-proxy/*` pattern (server holds cookie in memory; client never sees auth headers) is the template for any site whose session cookie can't be sent cross-origin. Mirror the **allowlist + hostname re-check** for safety.
- **`ctFetch`-style transparent routing:** one fetch helper that proxies through cl-helper when authed and falls back to direct `fetchWithProxy` otherwise — callers don't branch on auth state.
- **PNG-as-canonical-source import:** fetch the embedded-V2 PNG from the CDN and `extractCharacterDataFromPng` to recover alt-greetings / lorebook the JSON API omits, then enrich with JSON-only fields. Good for any site that serves real V2 PNGs.
- **`author/slug` (`fullPath`) as the single canonical ID** threaded through links, import, preview, and URL parsing — simpler than juggling numeric IDs.
- **Thin provider + delegated BrowseView split:** `*-api.js` (constants/network), `*-provider.js` (ProviderBase contract), `*-browse.js` (BrowseView UI). Copy this three-file layout.
- **Stale-response guards** (`ctLoadToken`, `ctDetailFetchToken`) and **client-side filter + auto-page-refetch** for filters the API can't express (hide-owned, strict NSFW).

Do **not** copy chartavern when the target site needs uploads, account favorites/following, gallery support, or version history — none of those are implemented here (sections 8–10).
