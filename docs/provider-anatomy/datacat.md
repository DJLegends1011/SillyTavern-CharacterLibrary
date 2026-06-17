# DataCat — Provider Anatomy

> Reference snapshot of the `datacat` provider as it exists on branch
> `codex/provider-guide-docs`. DataCat is the most server-plugin-heavy provider
> in the repo: nearly every read goes through the `cl-helper` Express plugin
> (`extras/cl-helper/index.js`). Where this tree differs from
> `codex/datacat-account-sync`, it is called out — notably, **no account-sync /
> favorites / saved-cards hooks exist here** (see §9).

Files:
- `modules/providers/datacat/datacat-provider.js` — `ProviderBase` subclass, import/link/preview/gallery wiring.
- `modules/providers/datacat/datacat-api.js` — shared network + V2-builder + multi-source search helpers.
- `modules/providers/datacat/datacat-browse.js` — `BrowseView` subclass: grid, filters, modal, extraction, following.
- `modules/providers/datacat/datacat-browse.css` — extraction panel + lorebook + source-badge styling.
- `extras/cl-helper/index.js` — server plugin: DataCat session/proxy/extraction, Saucepan proxy, FlareSolverr forwarder.

---

## 1. Overview

**Kind: aggregator + extraction-based, multi-source.** DataCat (`https://datacat.run`)
is itself an aggregator that re-hosts characters extracted from **JanitorAI** and
**Saucepan**. This provider then layers *additional* direct sources on top of
DataCat's own API:
- DataCat REST API (recent/fresh/creator/tags) — the native source.
- JanitorAI **MeiliSearch** index (`janny-characters`) for text search/sort.
- JanitorAI **Hampter** internal API (trending/popular) via FlareSolverr.
- **Saucepan** search API (proxied) for new/trending/popular.
- **Extraction**: when a JanitorAI/Saucepan character is not yet on DataCat, the
  provider submits it to DataCat's cloud-browser extraction service and polls.

Identity (`datacat-provider.js:55-73`): `id='datacat'`, `name='DataCat'`,
`icon='fa-solid fa-cat'`, `iconUrl='https://datacat.run/catgif.gif'`,
`beta=true`, `disabledByDefault=true`, plus an `enableWarning` calling the API
"barebones". `linkStatFields` exposes stat1=Chats (`fa-comments`), stat2=Messages
(`fa-envelope`), stat3=null.

Canonical ID: a **36-char UUID**. DataCat's REST returns a numeric auto-increment
as `id` and the UUID as `character_id`; `fetchMetadata` (`datacat-provider.js:160-167`)
normalizes `id := character_id` because URLs and all API calls use the UUID. A
per-character `sourceKind` (`'janitor'|'saucepan'`) rides alongside the id
everywhere and is required to disambiguate freshly-extracted characters.

`init(coreAPI)` (`datacat-provider.js:77-82`) binds two callbacks into the api
module: `setApiRequest(coreAPI.apiRequest)` and
`setSavedTokenGetter(() => coreAPI.getSetting('datacatToken'))`.

## 2. Server plugin (cl-helper)

All DataCat REST traffic flows through `cl-helper` rather than ST's built-in
`/proxy/`. `CL_HELPER_PLUGIN_BASE` is imported from `provider-utils.js`; the api
module hits it via the bound `coreAPI.apiRequest`. Plugin presence is checked
with `checkDcPluginAvailable()` → `GET {base}/health` expecting `{ok:true}`
(`datacat-api.js:132-143`). Routes are registered by `registerDataCatRoutes`,
`registerSaucepanRoutes`, and `registerFlareSolverrRoutes` (`index.js:1855-1860`).

**DataCat session/proxy routes** (`registerDataCatRoutes`, `index.js:851-1086`).
Server holds a single module-scoped `dcSessionToken`. Outbound calls use
`dcHeaders(token)` (`index.js:802-810`): browser `User-Agent`,
`Origin/Referer: https://datacat.run`, and crucially **`X-Session-Token: <token>`**.

| Route | Method | Why it exists |
|-------|--------|---------------|
| `/dc-init` | POST | Bootstrap a session. If a token is cached and not `force`, re-tests it; else creates an **anonymous** session via DataCat `POST /api/liberator/identify` with a random `deviceToken` (UUID), storing the returned `sessionToken`. Returns `{ok,token}`. (`index.js:852-899`) |
| `/dc-set-token` | POST | Push a client-saved token (≤256 chars) into the server's `dcSessionToken`. Used to restore a persisted session. (`index.js:901-916`) |
| `/dc-clear-token` | POST | Null out `dcSessionToken`. (`index.js:918-922`) |
| `/dc-session` | GET | Cheap `{active:bool}` probe. (`index.js:924-926`) |
| `/dc-validate` | GET | Validate by hitting `recent-public?limit=1`; returns `{valid,totalCount}`. (`index.js:928-950`) |
| `/dc-extract` | POST | Submit an extraction job. Requires a session (401 otherwise). Validates the URL is a JanitorAI character or Saucepan companion URL. Resolves a public-feed session id via `GET /api/users` (`getPublicSessionId`). Routes to DataCat `POST /api/saucepan-extract/run` (saucepan) or `POST /api/character/smart-extract-v2` (janitor) with an `idempotencyKey`/`X-Request-Id`. (`index.js:953-1042`) |
| `/dc-proxy/*` | GET | **Read-only allowlisted proxy** for DataCat REST. Path must match `DC_ALLOWED_PATHS`; query string is forwarded; host pinned to `datacat.run`; JSON passed through, other content returned as buffer. (`index.js:1044-1085`) |

`DC_ALLOWED_PATHS` (`index.js:820-829`) — the only paths `/dc-proxy` will forward:
`/api/characters/fresh`, `/api/characters/recent-public`,
`/api/characters/:uuid`, `/api/characters/:uuid/download`,
`/api/creators/:uuid`, `/api/creators/:uuid/characters`,
`/api/tags/faceted`, `/api/extraction/status-projection`.

Why a server plugin at all: (a) **session bootstrap** — DataCat needs an
`X-Session-Token` even for anonymous reads, minted server-side via the Liberator
identify endpoint; (b) **CORS/header forging** — `Origin/Referer/User-Agent` must
be set, which the browser can't do; (c) **extraction** is POST-only and
session-bound; (d) the proxy enforces a read-only allowlist so the client can't
turn it into an open proxy.

**Saucepan proxy** (`registerSaucepanRoutes`, `index.js:1435-1495`).
`GET|POST /saucepan-proxy/*`, host-pinned, allowlist
`/api/v1/search` (POST only), `/api/v1/companions-of-user`, `/api/v1/companion`
(`index.js:1360-1364`). POST bodies are sanitized field-by-field by
`sanitizeSaucepanSearchBody` (`index.js:1371-1409`). **The decode reason is the
key motivation**: Saucepan replies with **zstd-compressed** bodies that ST's
`/proxy/` forwards without `Content-Encoding`, so the browser can't decode them.
`readSaucepanBody` (`index.js:1421-1433`) requests `gzip, deflate, br` and falls
back to native `zlib.zstdDecompress` (Node ≥22.15) before returning plain JSON.

**FlareSolverr forwarder** (`registerFlareSolverrRoutes`, `index.js:1621-1715`).
Stateless thin POST forwarder (FlareSolverr emits no CORS headers). Three routes:
`/flaresolverr-fetch`, `/flaresolverr-session-create`,
`/flaresolverr-session-destroy`. The user-supplied FlareSolverr URL is **not**
stored server-side — passed per request. Target allowlist is a single entry:
`janitorai.com/hampter/characters` (`index.js:1578-1580`). Used only to satisfy
JanitorAI's Cloudflare challenge for Hampter trending/popular sort.

## 3. Authentication / login

**The provider declares no user auth**: `hasAuth → false`, `getAuthHeaders → {}`
(`datacat-provider.js:419-420`). There is no login UI. What exists instead is an
**anonymous server-side session token** managed entirely inside `cl-helper`:

- Token storage: server module variable `dcSessionToken` (`index.js:800`). The
  client may persist its value in the **`datacatToken`** setting; the saved-token
  getter is bound in `init()`.
- Bootstrap flow (`datacat-api.js`): `initDcSession(savedToken, force)`
  (`186-205`) first tries `restoreSavedToken` (`151-172`: `/dc-set-token` then
  `/dc-validate`); on failure it `POST /dc-init` for a fresh anonymous token.
- Lazy re-arm: `dcFetch` (`112-126`) retries once on **401/403** after
  `tryBootstrapSession` (`91-104`), which de-dupes concurrent bootstraps behind a
  single in-flight promise (`_bootstrapInFlight`).
- Window helpers for the settings panel (`datacat-provider.js:533-547`):
  `window.datacatValidateSession`, `window.datacatRefreshToken`
  (`initDcSession(null, true)` — force new), `window.datacatClearSession`.

So the "session" is plumbing to talk to DataCat anonymously, not a user account.

## 4. Data source

Primary REST helpers (all via `dcFetch` → `/dc-proxy`):
- `fetchDatacatCharacter(id, sourceKind?)` → `GET /api/characters/:id?sourceKind=` (`datacat-api.js:248-260`).
- `fetchDatacatDownload(id, sourceKind?)` → `GET /api/characters/:id/download?t=…` (V2-ish payload) (`268-280`).
- `fetchDatacatCreator(id)` / `fetchDatacatCreatorCharacters(id,{limit,offset,sortBy})` (`287-321`).
- `fetchRecentPublic({limit,offset,tagIds,minTotalTokens})` → `/api/characters/recent-public?…&summary=1&minTotalTokens=889` (`336-349`). `MIN_TOTAL_TOKENS=889` is the quality floor (`datacat-api.js:59`).
- `fetchFreshCharacters({sortBy,limit24,limitWeek})` → `/api/characters/fresh` returning `last24h`/`thisWeek` windows (`360-377`).
- `fetchFacetedTags({activeTagIds,minTotalTokens})` → `/api/tags/faceted?mode=recent` (`386-399`).

Non-DataCat sources (do **not** use `/dc-proxy`):
- MeiliSearch `searchMeiliJanny` (`727-785`): direct `fetch` to `JANNY_SEARCH_URL`
  (with `fetchWithProxy` fallback), `Bearer` token from `getSearchToken()`, index
  `janny-characters`, normalized via `normalizeMeiliHit`.
- Hampter `fetchHampterCharacters` (`875-930`): `https://janitorai.com/hampter/characters`,
  optionally through FlareSolverr; `normalizeHampterHit`.
- Saucepan `searchSaucepan` / `fetchSaucepanCompanionsOfUser` / `fetchSaucepanCompanion`
  (`1018-1141`): via `/saucepan-proxy`; `normalizeSaucepanHit` builds avatar from
  `cdn.saucepan.ai/images/:id/card`.

Avatar resolution `resolveDatacatAvatarUrl(hit)` (`datacat-api.js:49-56`): JanitorAI
avatars are bare filenames prefixed with `https://ella.janitorai.com/bot-avatars/`;
Saucepan embeds a full `https://` URL. Guarded by `window.isUrlSafeForDownload`.

All hits are read through camel/snake-tolerant accessors (`getCharId`,
`getCreatorId`, `getChatCount`, `getTotalTokens`, etc., `datacat-browse.js:243-280`)
because each source uses different field casing.

## 5. Browse & filtering

`renderFilterBar()` (`datacat-browse.js:3932-4006`) builds the control bar:
- **Mode toggle** `.datacat-view-btn` (Browse / Following) — `hasModeToggle → true`.
- **Sort `#datacatSortSelect`** — `buildSortOptionsHtml` (`1265-1294`) emits
  `Recent`, optgroups "Last 24 Hours" / "This Week" (fresh sorts × `_24h`/`_week`),
  "JanitorAI (Hampter)" (`hampter_trending/popular`), "JanitorAI (MeiliSearch)"
  (`janny_newest/oldest/tokens_desc/tokens_asc/relevant`), and "Saucepan"
  (`saucepan_new/trending/popular`). A second `#datacatFollowingSortSelect`
  (newest/oldest/name/chat_count) is shown in Following mode.
- **Tags `#datacatTagsBtn`** → dropdown `#datacatTagsList`. The picker renders one
  of three tag systems depending on sort mode: DataCat faceted tags (numeric ids,
  grouped, exclusive groups, live counts via `refreshTagCounts`), JanitorAI tags
  (`JANNY_ALL_TAGS` from `JANNY_TAG_MAP`, include-only), or Saucepan tags
  (curated `SAUCEPAN_KNOWN_TAGS` slug list + slugs harvested from results, tri-state
  include/exclude/neutral). Hidden entirely in Hampter mode (no tag param).
- **Features `#datacatFiltersBtn`** → client-side checkboxes
  `datacatFilterHideOwned`, `datacatFilterHidePossible`, `datacatFilterHideJanitor`,
  `datacatFilterHideSaucepan` (source filters hidden in single-source sort modes).
- **NSFW toggle `#datacatNsfwToggle`** (client-side filter).
- **Open-Def toggle `#datacatOpenDefToggle`** — Saucepan only; toggles
  `open_definition_only`.
- **Refresh `#datacatRefreshBtn`**.

The grid is driven by `loadCharacters(append)` (`474-804`), a large dispatcher that
branches on browse mode and sort-mode predicates (`isJannySortMode`,
`isHampterSortMode`, `isSaucepanSortMode`, `parseSortMode`). Cards are built by
`createDatacatCard` (`316-404`): avatar with lazy `data-src`, NSFW badge, source
badges (J/S, shown only in mixed-source modes), in-library / possible-match
badges, up-to-3 tags, and source-dependent footer stats. Persistent exclude tags
come from `getProviderExcludeTags('datacat')`.

The search box (`doSearch`, `1431-1526`) is URL-aware: a UUID or DataCat creator
URL routes to creator browse; a DataCat character URL opens preview; a
JanitorAI/Saucepan character URL triggers `lookupExternalCharacter` (DataCat
lookup, else extraction CTA); plain text routes to the active source's search or
switches to MeiliSearch relevance.

## 6. Preview / detail modal

`supportsInAppPreview → true` (`datacat-provider.js:350`). `openPreview` calls
`window.openDatacatCharPreview` (`394`); `buildPreviewObject` (`352-390`) fetches
the character and returns a flat preview object (id/name/chat_name/description/
avatar/tags/custom_tags/is_nsfw/creator/created_at/chat_count/message_count) with
a local-data fallback.

The browse-side modal is `#datacatCharModal`, opened by `openPreviewModal(hit)`
(`datacat-browse.js:2455-2587`). It paints header immediately
(`#datacatCharAvatar`, `#datacatCharName`, `#datacatCharCreator`,
`#datacatOpenInBrowserBtn` → datacat.run or saucepan.ai), stat slots
(`#datacatCharChats/Messages/Tokens/Date`), `#datacatCharTags`, then shows
skeletons and kicks off `fetchAndPopulateDetails(hit, token)` (`2589-2928`).

That async populator is the heart of the modal. Notable fields/sections:
- Body sections `#datacatCharDescriptionSection`/`Scenario`/`FirstMsg`/`MesExample`
  rendered through `safePurify(formatRichText(...), BROWSE_PURIFY_CONFIG)`. Body
  source is resolved per source kind (Saucepan: `content_variants` recovery →
  `chara_card_v2_json.data` → `description`; JanitorAI: `personality`).
- `#datacatCharCreatorNotesSection` via `renderCreatorNotesSecure` (iframe-isolated).
- Saucepan **locked-definition** banner (`renderLockedDefBanner`) when
  `fetchSaucepanCompanion().open_definition === false` and no recovery variant.
- Alt greetings (`renderAltGreetings`, lazy per-`<details>`), example messages
  (download-only), and a **metadata-only linked-lorebooks** list
  (`renderDatacatLorebooks`, `2930-3001`) — `.datacat-lorebook-row`, private items
  flagged, not downloadable through CL.
- Saucepan **portrait gallery** painted from `companion_snapshot.portraits[]`.
- Inline **extraction CTA** (`.datacat-modal-extract-cta`) when the character is
  not on DataCat; the Import button doubles as an "Extract" button
  (`startModalExtraction` + polling).

## 7. Import & card mapping

`supportsImport → true` (`datacat-provider.js:447`). `importCharacter(identifier,
hitData?, options)` (`454-516`): fetch character, prefer `/download`
(`buildV2FromDownload`) else `buildV2FromDatacat`, stamp the `datacat` extension,
`assignGalleryId`, download the avatar via `fetchWithProxy`, then `importFromPng`
with filename `datacat_<slug>.png` and `hasGallery` = (Saucepan portraits > 0).
The browse-side `importCharacter` wrapper (`datacat-browse.js:3098-3235`) runs the
duplicate-check / replace flow and the import-summary modal.

**source → V2 mapping** lives in `datacat-api.js`:
- `buildV2FromDatacat(character)` (`533-586`). Output `spec='chara_card_v2'`,
  `spec_version='2.0'`. Field selection is **source-dependent**:
  - JanitorAI: `personality → data.description`, `description → creator_notes`.
  - Saucepan (open def): `description → data.description`,
    `companion_snapshot.full_description` (or `chara_card_v2_json.data.creator_notes`)
    → `creator_notes`.
  - Saucepan (hidden def): a server-repaired body is read from
    `content_variants[primary].content` via `pickRecoveryVariant` (`438-443`).
  - Common: `scenario`, `first_message → first_mes`, `tags` via `resolveTagNames`,
    `creator_name → creator`.
  - `extensions.datacat = { id, sourceKind, creatorId, creatorName }`.
  - `character_book` built from `character.scripts[]` by
    `extractCharacterBookFromScripts` (`448-500`): public lorebook scripts only,
    JSON-decoded entries merged.
- `buildV2FromDownload(downloadData, character)` (`602-654`) wraps the
  already-near-V2 `/download` payload, falling back to the recovery variant for
  hidden-definition Saucepan cards, and merges `extensions.datacat`.

`enrichLocalImport` (`datacat-provider.js:398-415`) re-links a locally-imported PNG
only if it already carries `extensions.datacat.id` (no search API to match by name).

## 8. Linking & update checks

Link info is stored in `char.data.extensions.datacat`
(`getLinkInfo`/`setLinkInfo`, `datacat-provider.js:102-136`):
`{ id, sourceKind, linkedAt, pageName }`, `fullPath = String(id)`.
- `getCharacterUrl` → `https://datacat.run/characters/:id` (`339-342`).
- `openLinkUI` → `CoreAPI.openProviderLinkModal` (`344-346`).
- `fetchMetadata` normalizes `id := character_id` (`160-167`).
- `fetchRemoteCard` (`169-195`): `/download` first → `buildV2FromDownload`, else
  `buildV2FromDatacat`; tags result with `_listingName`.
- `normalizeRemoteCard` (`197-200`) and `fetchLorebook` (`202-211`).
- `fetchLinkStats` (`140-156`) returns `{stat1:chats, stat2:messages, stat3:null}`.

**Update checking is intentionally minimal**: `getComparableFields() → []`
(`309-311`) and `supportsVersionHistory → false` (`315`). The interesting hook is
`refreshRemoteData(linkInfo, options)` (`213-305`): gated on the
**`datacatReextractOnUpdate`** setting, it checks the plugin + session, backfills
`sourceKind`, builds the upstream URL (`janitorai.com/characters/:id` or
`saucepan.ai/companion/:id`), submits `submitExtraction(url, {alwaysReextract:true,
publicFeed: datacatPublicFeed})`, then polls `/api/extraction/status-projection`
(≤60 polls × 3s) reporting phase labels until the job's `requestId`/`characterId`
appears in history. This re-extracts the source-of-truth before the normal
remote-card fetch runs.

## 9. Save / favorites / bookmarks

**None in this tree.** There is no save-card / favorites / bookmarks / following-
upstream support. Specifically:
- No `supportsSave`/`getSavedCards`/`saveCard` methods on the provider; no
  favorites or bookmark cl-helper routes; `supportsBulkLink → false`
  (`datacat-provider.js:526`); `getSettings() → []` (`520-522`).
- A repo-wide grep over `modules/providers/datacat` for
  `accountSync|favorite|bookmark|saveCard|supportsSave|following` finds only the
  Saucepan `favorite_count` display field and a comment mentioning `gallery-sync`.
- The one "Following" feature (`datacat-browse.js:2090-2445`) is a **purely local
  creator-follow list** persisted in the **`datacatFollowedCreators`** setting
  (`loadFollowedCreators`/`saveFollowedCreators`, `2094-2103`). The Following
  timeline is assembled client-side by fetching each followed creator's characters
  (DataCat creator API or Saucepan `companions-of-user`). It is not synced to any
  DataCat account.

> Note vs `codex/datacat-account-sync`: that branch is expected to add account /
> sync hooks. **They are absent here** — document accordingly.

## 10. Gallery

`supportsGallery → true` (`datacat-provider.js:324`). `fetchGalleryImages(linkInfo)`
(`326-335`) fetches the character and calls `extractSaucepanGalleryImages`
(`39-49`), which pulls `companion_snapshot.portraits[].image.highres_url` (with
`id`) from the saucepan CDN. **JanitorAI-source characters have no gallery field**,
so they return `[]`. The avatar (`companion_snapshot.image.highres_url`) is
deliberately excluded since it's downloaded separately during import. The preview
modal paints the same portraits into `#datacatCharGalleryGrid`
(`datacat-browse.js:2818-2834`).

## 11. URL handling

`canHandleUrl(url)` (`datacat-provider.js:424-432`): true only when the hostname
matches `^(www\.)?datacat\.run$`.

`parseUrl(url)` (`434-443`): extracts a 36-char UUID from any
`/characters?/…/<uuid>` path via
`/\/characters?\/(?:[^/]+\/)*([a-f0-9-]{36})/i`.

Examples:
- `https://datacat.run/characters/123e4567-e89b-42d3-a456-426614174000` → UUID.
- `https://datacat.run/characters/recent/123e4567-…` → UUID (nested segments ok).
- `https://janitorai.com/characters/<uuid>` → **not** handled by `canHandleUrl`
  (different host); the browse search box handles it separately (`doSearch`,
  routing to `lookupExternalCharacter('janitor')` → extraction).
- `https://saucepan.ai/companion/<uuid>` → likewise handled only in the search box
  (`lookupExternalCharacter('saucepan')`), not by `parseUrl`.

## 12. Notable patterns worth copying

- **Server-plugin proxy with a read-only path allowlist.** Copy datacat when your
  upstream needs forged `Origin/Referer`/`User-Agent` or a session header the
  browser can't set. The `DC_ALLOWED_PATHS` + host-pin pattern (`index.js:820-1085`)
  is the safe template for a new `cl-helper` GET proxy.
- **Anonymous session bootstrap with lazy 401-retry.** The
  `setApiRequest`/`setSavedTokenGetter` injection + `dcFetch` single-retry +
  de-duped `tryBootstrapSession` (`datacat-api.js:75-126`) is a clean model for any
  source that needs a token but no real login.
- **Aggregator that fans out to several upstreams behind one browse view.** The
  sort-mode-predicate dispatcher in `loadCharacters` plus per-source `normalize*Hit`
  functions show how to unify mixed-shape results into one card renderer.
- **Decode-at-the-edge proxy.** Copy the Saucepan zstd-decompress proxy
  (`readSaucepanBody`, `index.js:1421-1433`) when an upstream returns a body
  encoding ST's `/proxy/` mangles.
- **Extraction/poll lifecycle.** If your source can fetch-on-demand, the
  submit→poll-`status-projection`→reopen pattern (provider `refreshRemoteData` and
  browse `startExtractionPolling`) is a reusable template.
- **Source-dependent V2 mapping with a recovery-variant fallback.**
  `buildV2FromDatacat`/`buildV2FromDownload` are worth copying when one provider id
  spans multiple upstream card conventions.
