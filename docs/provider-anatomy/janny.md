# Janny — Provider Anatomy

> Reference snapshot of the **JannyAI** (`jannyai`) provider, the canonical
> "HTML / app-shell scraping" baseline. Three files make up the provider:
> `modules/providers/janny/janny-api.js` (shared constants + token + search/text
> utils), `modules/providers/janny/janny-provider.js` (the `JannyProvider` class),
> and `modules/providers/janny/janny-browse.js` (the `JannyBrowseView` UI).
> There is **no** `janny-browse.css`; it reuses the shared `browse-*` styles.

## 1. Overview

- **Provider kind: hybrid search-API + HTML scraper.** Listing/search uses a
  hosted **MeiliSearch** instance (`https://search.jannyai.com/multi-search`,
  `janny-api.js:10`). Full character *definitions* are **not** available from
  search — they are obtained by **scraping the rendered character page** and
  parsing **Astro island props** out of the HTML (`janny-provider.js:309-357`).
  This is what makes janny the "app-shell scraping" baseline: there is no real
  detail JSON API, so the page itself is the data source.
- Identity (`janny-provider.js:409-413`): `id = 'jannyai'`, `name = 'JannyAI'`,
  icon `fa-solid fa-broom`, `browseView` = the `JannyBrowseView` singleton.
- `linkStatFields` (`:415-421`): only `stat3` is used — `{ icon: 'fa-solid
  fa-coins', label: 'Tokens' }`. stat1/stat2 are `null` (Janny exposes no
  rating/favorites counts).
- Capability summary:
  - `hasView` → `true` (`:432`)
  - `hasAuth` → `false` (`:709`)
  - `supportsImport` → `true` (`:739`)
  - `supportsBulkLink` → `true` (`:853`)
  - `supportsVersionHistory` → `false` (`:565`)
  - `supportsInAppPreview` → `true` (`:580`)
  - `supportsGallery` → inherited `false` (never overridden; gallery is hard-off,
    see §10)
  - `getSettings()` → `[]` (`:845-849`) — no user-configurable settings.

## 2. Server plugin (cl-helper)

**Janny does NOT use the cl-helper server plugin.** All network calls are made
directly from the browser (MeiliSearch `fetch`, page scrapes via proxies). There
are no `/cl-helper/...` calls anywhere in the three janny files.

The only `janny`-related hits in `extras/cl-helper/index.js` are **unrelated** to
this provider:
- `index.js:970` — the `/dc-extract` (DataCat) route's hostname allow-list happens
  to accept `jannyai.com` alongside `janitorai.com`, but that route is the
  JanitorAI/Saucepan DataCat extractor, not the janny provider.
- `index.js:1021` — `extractSourceMode: 'core_plus_janny'` is an internal DataCat
  option name; again unrelated to this provider's code path.

Takeaway for the guide: janny is the example of a provider that needs **no
server-side helper at all** — everything is client-side fetch + scrape.

## 3. Authentication / login

- **No user auth.** `get hasAuth() { return false; }` and `getAuthHeaders()
  { return {}; }` (`janny-provider.js:706-711`).
- The MeiliSearch endpoint requires a **public search key** (a Bearer token), but
  it is a site-wide key, not a per-user credential. It is obtained automatically:
  - `getSearchToken()` (`janny-api.js:43-91`) scrapes JannyAI's Astro client JS
    bundle to extract the 64-hex MeiliSearch key:
    1. fetch `https://jannyai.com/characters/search`,
    2. regex out `client-config.<hash>.js` (or follow `SearchPage.<hash>.js` →
       its `client-config` import),
    3. fetch `/_astro/<client-config>.js` and match `"([a-f0-9]{64})"`.
  - On any failure it falls back to a **hardcoded key**
    `JANNY_FALLBACK_TOKEN = '88a6463b…2ff2b30'` (`janny-api.js:13, :83`).
  - The token is cached module-scoped (`_cachedToken`) and an in-flight promise is
    shared between provider and browse view (`janny-api.js:35-36, 44-46`).
- **Storage:** none. No tokens, cookies, or settings persisted per user.

## 4. Data source

- **Search / listing:** MeiliSearch multi-search POST to `JANNY_SEARCH_URL`
  (`https://search.jannyai.com/multi-search`), index `indexUid: 'janny-characters'`
  (`janny-api.js:258-303`, `janny-browse.js:78-145`). Headers include
  `Authorization: Bearer <token>`, `Origin: https://jannyai.com`,
  `Referer: https://jannyai.com/`, and the spoofed
  `x-meilisearch-client: 'Meilisearch instant-meilisearch (v0.19.0) ; Meilisearch
  JavaScript (v0.41.0)'`. Direct `fetch` first, falling back to `fetchWithProxy`
  on CORS failure.
- **Full definition:** `fetchCharacterDetails(characterId, slug)`
  (`janny-provider.js:309-357`) GETs
  `https://jannyai.com/characters/{characterId}_{slug}` via `fetchHtmlPage()`
  then extracts the `astro-island` element whose `component-export="CharacterButtons"`
  (fallback: any island with `character` props), HTML-unescapes the `props="…"`
  attribute, `JSON.parse`s it, and decodes Astro's `[type, data]` serialization via
  `decodeAstroValue()` (`:228-244`). Creator username is regex-scraped from the
  server-rendered `Creator: @username` markup (`:341-348`).
- **Proxy ladder for page scraping** (`fetchHtmlPage`, `janny-provider.js:44-86`),
  in order, because Cloudflare protects jannyai.com:
  1. `corsproxy.io` (`https://corsproxy.io/?url=…`) — most reliable in practice.
  2. **Puter.js** WISP relay (`window.puter.net.fetch`) — needs COOP/COEP for
     `SharedArrayBuffer`; usually broken, self-disables via `_puterBroken`.
  3. SillyTavern server proxy `/proxy/<encoded-url>` — node-fetch from user IP,
     Cloudflare usually 403s it; surfaces "enable enableCorsProxy" hint.
  `isValidCharacterHtml()` (`:88-92`) gates a response as valid only if it is
  >1000 bytes and contains `CharacterButtons` or `astro-island`.
- **Canonical ID format:** `"{id}_{slug}"` — the `fullPath`. `id` is a JannyAI
  character UUID; slug derives from the name. Search results normalize slug as
  `character-<slugify(name)>` (`janny-provider.js:889`,
  `janny-browse.js:687`). `parseUrl`/`fetchMetadata`/`importCharacter` all split
  on the first `_` to recover `charId` + `slug`.
- Avatars: `JANNY_IMAGE_BASE` = `https://image.jannyai.com/bot-avatars/` +
  `hit.avatar` filename (`janny-api.js:11`).
- Tags are numeric IDs mapped through `TAG_MAP` (`janny-api.js:16-29`) via
  `resolveTagNames()` (`:101-103`).

## 5. Browse & filtering

`JannyBrowseView extends BrowseView` (`janny-browse.js:1243`). The whole UI is
rendered as HTML strings; events are wired in `initJannyView()` (`:933-1158`).

`renderFilterBar()` (`:1286-1356`) controls, all client IDs prefixed `janny`:
- **Sort** `<select id="jannySortSelect">`: Newest / Oldest / Most Tokens / Least
  Tokens / Relevance, mapped to MeiliSearch `sort` arrays in `searchJanny`
  (`:93-100`): `createdAtStamp:desc|asc`, `totalToken:desc|asc`, or empty
  (`relevant`). Converted to a custom dropdown via `CoreAPI.initCustomSelect`.
- **Tags dropdown** (`jannyTagsBtn` / `jannyTagsDropdown`): searchable list of all
  `TAG_MAP` tags (`renderTagsList`, `:845-888`). Tags are **include-only**
  (single state `state-include`, a `Set<number> jannyIncludeTags`); multiple
  includes are AND-ed (`tagIds = <id> AND …`, `:87-90`).
- **Min/Max tokens** (`jannyMinTokens` / `jannyMaxTokens`, defaults 29 / 100000,
  `:64-65`) → MeiliSearch `totalToken >= / <=` filters (`:83-84`).
- **Features dropdown** (`jannyFiltersBtn` / `jannyFiltersDropdown`):
  - `jannyFilterLowQuality` → toggles `isLowQuality = false` filter (`:86`).
  - `jannyFilterHideOwned` → client-side filter via `isCharInLocalLibrary`.
  - `jannyFilterHidePossible` → client-side filter via `isCharPossibleMatchObj`.
- **NSFW toggle** (`jannyNsfwToggle`, default ON, `:57`) → adds `isNsfw = false`
  when off (`:85`).
- **Refresh** (`jannyRefreshBtn`).
- **Author filter** (no bar control): clicking a creator link calls
  `filterByAuthor()` (`:1188-1211`) — a *keyword* search on the author name
  (Janny has no real author endpoint), surfaced via the `jannyAuthorBanner`.

Loading: `loadCharacters()` (`:316-448`) paginates (`hitsPerPage: 80`), applies
persistent exclude tags from settings (`getProviderExcludeTags('janny')`), then
the hide-owned/hide-possible client filters, and **auto-fetches up to 3 extra
pages** when client filters thin the results below 80 (`:367-397`). Cards built by
`createJannyCard()` (`:230-275`) with `browse-card` classes and `data-janny-id` /
`data-slug`; in-library / possible-match badges via `view._lookup`.

## 6. Preview / detail modal

- Modal markup is `renderModals()` (`:1404-1486`); overlay id **`jannyCharModal`**
  (`get previewModalId()`, `:1255`), root `.modal-overlay` → `.modal-glass
  .browse-char-modal`.
- `openPreviewModal(hit)` (`:457-548`) fills header (`jannyCharAvatar`,
  `jannyCharName`, `jannyCharCreator`, open-in-browser `jannyOpenInBrowserBtn`),
  stats (`jannyCharTokens`, `jannyCharDate`), tags (`jannyCharTags`, clamped by
  `applyTagsClamp`), and an import button (`jannyImportBtn`) whose label/class
  reflect in-library / possible-match / fresh state.
- It renders **skeletons** for the heavy sections, then fires
  `fetchAndPopulateDetails(hit, token)` (`:550-646`) which calls
  `provider.fetchMetadata("{id}_character-{slug}")` (the page scrape) and fills:
  - `jannyCharCreatorNotesSection` / `jannyCharCreatorNotes` — website
    description (raw HTML, may include images), via `renderCreatorNotesSecure`.
  - `jannyCharDescriptionSection` / `jannyCharDescription` — the **`personality`**
    field (Janny's "personality" = card description).
  - `jannyCharScenarioSection` / `jannyCharScenario` — `scenario`.
  - `jannyCharFirstMsgSection` / `jannyCharFirstMsg` — `firstMessage`.
  - `jannyCharExamplesSection` / `jannyCharExamples` — `exampleDialogs`.
  All run through `safePurify(formatRichText(...), BROWSE_PURIFY_CONFIG)`.
- Stale-guard via `jannyDetailFetchToken`; cleanup in `cleanupJannyCharModal()`
  (`:648-667`) / `closePreviewModal()` (`:669-676`). Modal registered as overlay
  tier 7 (`:1155`). Linked-card preview entry point exported as
  `window.openJannyCharPreview` (`:1562-1564`), called by `openPreview()`
  (`janny-provider.js:615-617`).

## 7. Import & card mapping

- `get supportsImport() { return true; }` (`janny-provider.js:739`).
- `importCharacter(identifier, hitData, options)` (`:748-841`):
  1. split `identifier` into `charId` + `slug`.
  2. if `hitData` already has definition fields (`personality` || `firstMessage`,
     e.g. from the preview fetch) use it directly to skip a second scrape; else
     `fetchCharacterDetails`; else fall back to the raw MeiliSearch hit (with a
     warning that definitions will be incomplete).
  3. backfill missing `tagIds` / `creatorId` from a MeiliSearch search by name
     (`:782-795`) — page scrape often lacks these.
  4. build the V2 card, stamp `extensions.jannyai`, assign gallery id, download
     avatar via `fetchWithProxy`, then `importFromPng({…, hasGallery: false})`.
- **source → V2 mapping** is `buildV2FromDetails(charData)` (`:368-400`):
  | V2 field (`data.*`) | Janny source |
  |---|---|
  | `name` | `char.name` |
  | `description` | **`char.personality`** |
  | `personality` | `''` (intentionally empty) |
  | `scenario` | `char.scenario` |
  | `first_mes` | `char.firstMessage` |
  | `mes_example` | `char.exampleDialogs` |
  | `creator_notes` | `char.description` (the website blurb, raw HTML) |
  | `creator` | `char.creatorUsername` ‖ `char.creatorId` |
  | `tags` | `resolveTagNames(char.tagIds)` |
  | `extensions.jannyai` | `{ id, creatorId, tagline: stripHtml(description) }` |
  `alternate_greetings: []`, `character_book: undefined`, `character_version:
  '1.0'`, system/post-history empty. Note the **personality↔description swap** is
  the key gotcha to copy carefully.

## 8. Linking & update checks

- `getLinkInfo(char)` (`:448-463`) reads `extensions.jannyai.id`, returns
  `{ providerId:'jannyai', id, fullPath: slug? `${id}_${slug}` : id, linkedAt }`.
- `setLinkInfo(char, linkInfo)` (`:465-481`) writes/clears
  `extensions.jannyai = { id, slug, linkedAt, pageName }`.
- `fetchMetadata(fullPath)` (`:512-524`) → page scrape, returns the raw character
  object. `fetchRemoteCard(linkInfo)` (`:526-541`) → scrape + `buildV2FromDetails`
  (+ `_listingName`). `normalizeRemoteCard` (`:543-545`) wraps
  `buildV2FromDetails`.
- `fetchLinkStats(linkInfo)` (`:485-508`): derives a search term from the slug,
  searches MeiliSearch, finds the hit by `id`, returns
  `{ stat1:null, stat2:null, stat3: totalToken }`.
- **Update checks:** `getComparableFields()` (`:549-560`) compares only one field —
  `extensions.jannyai.tagline` ("Creator's Notes" / "Tagline"), marked `optional`.
  Because `supportsVersionHistory` is `false` there is no commit/version diff; the
  app falls back to field comparison.

## 9. Save / favorites / bookmarks

**None.** There is no concept of saving cards back to the provider, favoriting,
bookmarking, or following on Janny. The interface has no `supportsSaveCard` /
`supportsFavorites` / `supportsFollowing` hooks, and the janny files implement no
such methods. `followingSortOptions: []` (`janny-browse.js:1265`) and the empty
`getSettings()` confirm there is no following/saved tab. Janny is purely
read-only: search → preview → import.

## 10. Gallery

**No gallery support.** Every code path hardcodes `hasGallery: false`
(`janny-provider.js:632, 697, 831`); `supportsGallery` is left at the inherited
`false`. The header comment states "No gallery support." A gallery id is still
*assigned* to imported cards (`assignGalleryId`, `:813`) so local media can attach,
but no remote gallery pages are fetched.

## 11. URL handling

- `canHandleUrl(url)` (`:715-724`): true for hostnames matching
  `^(www\.)?jannyai\.com$` **or** `^(www\.)?janitorai\.com$` (case-insensitive).
- `parseUrl(url)` (`:726-735`): matches `\/characters\/([a-f0-9-]+(?:_[^/]*)?)`
  and returns that captured `{uuid}_{slug}` segment (the `fullPath`/identifier).
- `getCharacterUrl(linkInfo)` (`:569-572`): builds
  `https://jannyai.com/characters/{fullPath}`.
- Example URLs:
  - `https://jannyai.com/characters/3f2a1c8e-…_character-akari` →
    `parseUrl` → `"3f2a1c8e-…_character-akari"`.
  - `https://www.janitorai.com/characters/3f2a1c8e-…_akari` → `canHandleUrl` true,
    `parseUrl` → `"3f2a1c8e-…_akari"`.

## 12. Notable patterns worth copying

Copy janny as a baseline when the new source is **a Cloudflare-protected site with
no real detail API** and you must scrape the rendered page. Specifically:

- **Astro app-shell scraping:** the `astro-island props="…"` extraction +
  `decodeAstroValue` `[type,data]` decoder (`janny-provider.js:228-244, 316-337`)
  is the template for any Astro/Next-style site where the data is embedded in the
  page shell rather than served as JSON.
- **Multi-strategy proxy ladder with self-disabling tiers** (`fetchHtmlPage`,
  `:44-86`) + an `isValidCharacterHtml` Cloudflare-challenge detector — reuse this
  for any CF-fronted target.
- **Auto-scraped public API key with hardcoded fallback** (`getSearchToken`,
  `janny-api.js:43-91`) for sites that ship a public search key in their JS
  bundle — avoids hard-coding while staying resilient.
- **Hybrid search-API + page-scrape split:** cheap MeiliSearch listing for the
  grid, expensive scrape only on preview/import, with **MeiliSearch backfill** of
  fields the scrape misses (`importCharacter` `:782-795`).
- **Read-only, no-auth, no-gallery, no-following minimal surface** — the smallest
  realistic provider shape; good starting point before adding capabilities.

Do **not** copy janny if your source exposes a clean detail JSON API, requires
user login, or offers galleries/version history — those need a richer baseline.
