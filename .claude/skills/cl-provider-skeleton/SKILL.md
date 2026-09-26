---
name: cl-provider-skeleton
description: Use when adding a new online provider to SillyTavern-CharacterLibrary (CL), porting a provider PR, or auditing an existing provider for parity with the others (botbooru/saucepan/chub/datacat). Gives the full provider skeleton (ProviderBase + BrowseView hooks, shared UI components, every wiring point, network/cl-helper rules) so a provider "fills in" a known shape instead of reinventing it.
---

# CL provider skeleton

A CL provider is two classes plus wiring: a `ProviderBase` subclass
(`modules/providers/<id>/<id>-provider.js`), a `BrowseView` subclass
(`<id>-browse.js` + `<id>-browse.css`), and about 15 registration points across the app.
Every point is load-bearing, and a gap surfaces as quietly broken UI rather than an error.
So work the full list; a rendering grid is the start, not the finish.

**Reference implementations:** Saucepan (single-mode, account login) and Botbooru
(mode toggle, cl-helper proxy). Mirror their structure hook for hook.

## 0. Probe the site before writing UI

Verify each of these live, with curl or Node plus a browser User-Agent, before building on it:
- **CORS.** Does the API send `Access-Control-Allow-Origin` for the ST origin? If not, every
  call goes through `fetchWithProxy` (ST `/proxy/`) or a cl-helper route.
- **CORP on images.** `Cross-Origin-Resource-Policy: same-site` blocks `<img>` on the ST
  origin. Display URLs must be proxied. ST `/proxy/` sends no `Cache-Control`, which causes
  a re-download and a flash on every render, and it drops `Content-Type` (SVG won't render).
  Serving images from a cl-helper route with `Cache-Control` fixes both.
- **User-Agent blocks** ("Automated access not permitted"). Server-side fetches need a browser UA.
- **Gated content** (NSFW/18+, login). What does anonymous access silently return? Find the
  documented auth path (e.g. app-password login leading to a cookie session).
- **Payload shapes.** Cards arrive as V2 `{spec, data}` **or flat V1**. Read both, via a
  `xxxCardFields(card)` helper. Check which fields exist (e.g. `character_book`).
- **Rate limits.** Anonymous limits can be low; test with a handful of known cards rather than bulk scans.

## 1. ProviderBase subclass

| Hook | Notes |
|---|---|
| `id` `name` `icon` `iconUrl` | `iconUrl` must be embeddable. If the favicon is CORP-blocked, inline it as a data: URI |
| `beta` / `deprecated` / `disabledByDefault` / `enableWarning` | as appropriate |
| `minClHelperVersion` / `clHelperFeatures` | gate base or per-feature cl-helper needs (e.g. `{ login: { minVersion, label } }`) |
| `init(coreAPI)` `activate` `deactivate` `hasView` `renderFilterBar/View/Modals` | delegate to the browse view |
| `getLinkInfo` / `setLinkInfo` / `getCharacterUrl` / `openLinkUI` | ext key = `data.extensions.<id>` |
| `fetchMetadata` / `fetchRemoteCard` / `normalizeRemoteCard` / `getComparableFields` | update checks |
| `fetchLinkStats` / `linkStatFields` | link modal stats |
| `canHandleUrl` / `parseUrl` | URL paste import |
| `supportsBulkLink` / `openBulkLinkUI` / `searchForBulkLink` / `getResultAvatarUrl` | bulk auto-link |
| `supportsImport` / `importCharacter(id, hitData, { inheritedGalleryId })` | see §4 |
| `supportsInAppPreview` / `buildPreviewObject` / `openPreview` | "View on X" opens CL's preview; fall back to the local card when the live fetch fails |
| `enrichLocalImport(cardData)` | re-link PNGs carrying `extensions.<id>` |
| optional | auth hooks, `supportsGallery`/`fetchGalleryImages`, `supportsVersionHistory` |

Implement only hooks that `modules/providers/provider-interface.js` currently declares; it is the live list.

## 2. BrowseView subclass

- `previewModalId`, `_getImageGridIds`, `_extractProviderIds` (drives the In Library lookup), `closePreview`, `openPreview` (calls `injectModals()` first).
- **Modal listeners attach once.** `init()` reruns on every provider switch, but the modals persist in `document.body`. Use a module-level guard.
- Preview modal: backdrop click closes it; `window.registerOverlay({ id, tier: 7, close })` handles Esc and mobile back; `BrowseView.wireTitleScroll`; desktop avatar click opens `BrowseView.openAvatarViewer(full, thumb)` (bail on `isMobileMode()`); set `avatar.dataset.full`.
- Loading: reset shows `renderSkeletonGrid`/`renderLoadingState`. **Load-more appends:** render with `append=true` for page > 0 so existing cards stay put. `view.observeImages(grid)`, `updateLoadMoreVisibility`.
- `applyDefaults({ sort, hideOwned, hidePossible })` + `getSettingsConfig()` (the Settings "Sort: Auto" list).
- **Mobile contract:** `mobileFilterIds` `{ sort, tags, filters, nsfw, refresh }` (the mobile sheet mirrors these real controls), `getSearchModes()` (`['character','creator']`), `getSearchInputId(mode)`, `getSearchPlaceholder(mode)`. The input's sibling submit button needs `.browse-search-submit`. Add `hasModeToggle` + `mobileModeSections` only if there's a Browse/Following toggle.
- `refreshInLibraryBadges`.

## 3. Shared UI components

Build every control from the `browse-shared.css` components below. Provider CSS holds only
UI unique to that provider. Remember the `.hidden` cascade: browse-shared loads after library.css.

- **NSFW toggle:** `.nsfw-toggle` + `.active`, label inside a `<span>`, fire/shield icon (the mobile chip mirrors `.active` and the span). Persist to `<id>Nsfw` in `DEFAULT_SETTINGS`, **default off**, restore in `init` before the first load. Keep labels short ("SFW Only" / "NSFW On") so they fit the mobile chip.
- **Tag dropdown:** `.browse-tags-dropdown` + `.browse-tag-filter-item` rows with the `.browse-tag-state-btn` tri-state (neutral, include, exclude) + `.tag-count`.
- **Features dropdown:** a "Library:" section with Hide Owned / Hide Possible, a `Features (n)` count badge, `has-filters`.
- Creator filter banner: `.browse-author-banner` (it has `.hidden` + mobile rules).
- Preview: `.browse-char-meta-grid` > `.browse-char-stats` (`.browse-stat` items) + `.browse-char-tags`; **tag clamp** (`browse-tags-collapsed` + a "..." `.browse-tags-more` expander, run in rAF after the modal shows); long stats get their own wrapping row (mobile `.browse-stat` is nowrap, so out-specify `html.cl-mobile .browse-stat`).
- **Creator's Notes** renders the card's `creator_notes` field, and the section hides when that field is empty.

## 4. Import pipeline (`finishBrowseImport`)

Preview button states: **In Library / Import (Possible Match) / Import**. On click, with an in-flight guard:
`checkCharacterForDuplicatesAsync`, then `showPreImportDuplicateWarning` (skip / replace, keeping
`getCharacterGalleryId`, / keep both), then `CoreAPI.getProvider(id).importCharacter(...)`, then
`finishBrowseImport({ view, summaryArgs, showSummary, closePreview, importBtn, characterName, avatarFileName, markImported })`.
In `importCharacter`: download the PNG, **prefer its embedded card** (`extractCharacterDataFromPng`) over API metadata, copy `character_book`, `assignGalleryId`, then `importFromPng` (which embeds exactly the card you pass it, so carry over every field to keep).

## 5. Wiring checklist (grep an existing provider id to find each)

- `modules/module-loader.js`: `loadModuleCSS(...)` + the `providerImports` entry. **Bump `MODULE_CSS_VERSION`** (a decimal) whenever CSS changes.
- `app/library.js`: `DEFAULT_SETTINGS` (credentials, `<id>Nsfw`), the Settings modal block (input refs / load / save / restore-defaults reset / preserve-on-reset / visibility toggles), exclude-tags config list, `ADV_FILTER_PROVIDERS`, search prefix regex + prefix list + prefix→provider map, `PROVIDER_EXT_KEYS`.
- `app/library.html`: provider `<details class="settings-provider-section">` (new UI goes **inside** it), search-prefix help `info-code-item`.
- `index.js`: `PROVIDER_EXT_KEYS`.
- `modules/recommender.js`: `PROVIDER_SOURCE_MAP`.
- `app/library-mobile.js`: avatar-viewer delegate (`<prefix>CharAvatar`).
- `modules/css-assistant.js`: provider CSS file list + class prefix.
- Exclude tags: `getProviderExcludeTags('<id>')` **with the id**, applied to results (server-side when the API supports it).

## 6. cl-helper routes

- Browser calls go through `CoreAPI.apiRequest` (adds `/api`). Plugin routes live at `/api/plugins/cl-helper/...`. For a helper-optional feature, detect the helper explicitly (a `/health` version probe) so a wrong path shows up as an error.
- Add routes inside the existing `index.js` (self-update copies only the files the installed helper already has). Bump `extras/cl-helper/package.json`, and gate features with `clHelperFeatures`.
- Proxies: path allowlist, hostname check, raw-path handling (filenames with `&` `?` `#`), a browser UA, and `Cache-Control` on image responses. Session via a custom header (e.g. `X-<Provider>-Session`), since `Authorization` collides with ST basic auth; remember the last session for `<img>` loads.

## 7. Verify

Test each API shape live, then in CL on **both desktop and mobile**:
- grid refresh (one transition), load-more (append, no flash)
- NSFW toggle state + persistence across reload, mobile sheet (sort/tags/features/NSFW/refresh), mobile search overlay (both modes)
- preview (notes, tag clamp, backdrop/Esc/back), import, reopen (In Library), re-import (duplicate prompt)
- Settings defaults (sort, hide owned/possible), exclude tags, "View on X" from the library
