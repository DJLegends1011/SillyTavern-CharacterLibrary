# CharaVault Provider — Work in Progress

Branch: `claude/add-new-provider-TIN0m`
Last commit: `8c5b242` (WIP: api + provider + cl-helper endpoints)

## What's done

- [x] `extras/cl-helper/index.js` — CharaVault endpoints
  - `POST /cv-login` — App-Password auth (warns if password doesn't start with `cv_`)
  - `POST /cv-logout`
  - `GET /cv-session` → `{active, email}`
  - `GET /cv-validate` — hits `/api/auth/me`, clears on 401/403
  - `GET /cv-proxy/*` — allowlisted read-only passthru; forwards `X-RateLimit-*` + `Retry-After` headers
- [x] `modules/providers/charavault/charavault-api.js`
  - Token-bucket throttle: unauth 50/min, authed 100/min, `minDelayMs` 1200/600
  - `cvFetch` — single queue for all `/api/*` calls; 429 Retry-After honored (abort if >300s)
  - Adaptive slowdown at `X-RateLimit-Remaining` ≤15 (×2 delay) / ≤5 (2s crawl)
  - Endpoints: `searchCards`, `fetchCardDetail`, `fetchCardLorebooks`, `fetchLorebook`, `fetchTopTags`
  - URL helpers: `getCardPngUrl` (unthrottled static), `getAvatarUrl` (CF resized), `parseCharacterUrl`, `splitFullPath`
  - Builders: `buildCharacterCardFromCv`, `normalizeLorebookToV2` (dual shape: array + dict)
  - `sha256Hex` for content-hash update tiebreaker
- [x] `modules/providers/charavault/charavault-provider.js`
  - `CharaVaultProvider extends ProviderBase` — id `charavault`, icon `fa-solid fa-vault`
  - PNG-first import (static PNG is free/unthrottled) + metadata backfill
  - Auto-attach lorebook when `has_book=true` (2 extra API calls)
  - URL round-trip via `canHandleUrl` + `parseUrl` for all 5 URL shapes
  - `fetchRemoteCard` for updates; `getComparableFields` for tagline diff
  - Window functions: `charavaultLogin`, `charavaultLogout`, `charavaultValidateSession`, `charavaultCheckPluginAvailable`
  - **Known issue:** imports `./charavault-browse.js` which doesn't exist yet → will fail at module load until browse file is added

## What's left

1. **`modules/providers/charavault/charavault-browse.js`** (biggest remaining piece)
   - Copy structure from `modules/providers/chartavern/chartavern-browse.js` (~1978 lines)
   - Find/replace `ct`→`cv`, `Ct`→`Cv`, `chartavern`→`charavault`, `CharacterTavern`→`CharaVault`
   - Adjust API shapes:
     - Search: `{q, tags, creator, folder, nsfw, has_book, sort, limit, offset}` (offset-based, not page)
     - Result key: `data.cards || data.results || data` (defensive)
     - Sort options: `most_downloaded | top_rated | newest | oldest | name_asc | name_desc | token_count_asc | token_count_desc`
   - Hit shape on card (normalize inside `_hitFromDetail` / `_normalizeSearchResult`):
     - `{folder, file, fullPath, name, creator, tagline, tags, token_count, has_book, nsfw, downloads, rating, updated_at, created_at}`
   - Expose `window.openCharavaultCharPreview(hit)` and `window.openCharavaultLoginModal()` (both referenced by the provider)
   - Login modal: email + app-password fields (not a cookie textarea) — password field with eye toggle, remember checkbox
   - Extra filter: `has_book` toggle next to NSFW toggle
   - Thumbnail: try `getAvatarUrl` (CF `/cdn-cgi/image/...`) and fall back to raw `getCardPngUrl` on error

2. **`modules/providers/charavault/charavault-browse.css`**
   - Copy from `modules/providers/chartavern/chartavern-browse.css` (~50 lines)
   - Rename `.ct-*` → `.cv-*`
   - Add rules for any new elements specific to the login modal (app-password field)

3. **`modules/module-loader.js`** (around line 302 / 313)
   - Add `loadModuleCSS('./providers/charavault/charavault-browse.css');`
   - Add `{ name: 'charavault', load: () => import('./providers/charavault/charavault-provider.js') }` to `providerImports`

4. **`app/library.js` — settings defaults** (around line 427, `DEFAULT_SETTINGS`)
   ```js
   charavaultEmail: null,
   charavaultAppPassword: null,
   charavaultRemember: false,
   charavaultNsfw: false,
   charavaultHasBook: false,
   charavaultSort: 'most_downloaded',
   charavaultFolder: '',
   ```
   Do **not** add `'charavault'` to `disabledProviders` — ships enabled.

5. **`app/library.html` — settings section** (insert after Wyvern, ~line 2173)
   - `<details id="settingsCharavaultSection">` with:
     - Plugin banner (`charavaultPluginBanner`, like DataCat's)
     - Status badge (`charavaultSessionStatus`)
     - Email input (`settingsCharavaultEmail`)
     - App-password input (`settingsCharavaultAppPassword`) with `toggleCharavaultPasswordVisibility` eye button
     - `validateCharavaultBtn` button
     - `settingsCharavaultRememberCredentials` checkbox
     - Exclude tags pills (`charavaultExcludeTagsPills` + `charavaultExcludeTagsInput`)
   - Plus add `<li><strong>CharaVault</strong>…</li>` entries in the providers-list near line 1128

6. **`app/library.js` — handlers** (around line 2146, after Wyvern)
   - References: `charavaultEmailInput`, `charavaultAppPasswordInput`, `charavaultRememberCredsCheckbox`, `toggleCharavaultPasswordVisibility`, `charavaultPluginBanner`, `charavaultSettingsFields`, `charavaultSessionStatus`
   - Add to `checkClHelperPlugin(...)` call (line 1449)
   - Load values in open-modal block (line 1423)
   - Save values in `doSaveSettings()` (line 1776)
   - Reset block (line 1933)
   - `validateCharavaultBtn` click handler (mirror Wyvern's, calls `window.charavaultLogin`)
   - Session status updater (mirror `updateDatacatSessionStatus`, calls `window.charavaultValidateSession`)
   - Add `'charavault'` to exclude-tags provider list at line 1367
   - Add `'charavault'` to `PROVIDER_EXT_KEYS` at line 13988
   - Add `'charavault'` entries to the filter-prefix regex at lines 12889 + 12926 + 12984

7. **Commit + push** (user asked for the branch `claude/add-new-provider-TIN0m`)

## Reference files already read

- `extras/cl-helper/index.js` (all)
- `modules/providers/chartavern/chartavern-api.js` (all — primary template)
- `modules/providers/chartavern/chartavern-provider.js` (all — primary template)
- `modules/providers/chartavern/chartavern-browse.js` (all — primary template)
- `modules/providers/chartavern/chartavern-browse.css` (all)
- `modules/providers/wyvern/wyvern-api.js` (all — lorebook builder source)
- `modules/providers/provider-utils.js` (all — shared helpers)
- `modules/providers/browse-view.js` (all)
- `app/library.html` (Wyvern + CharacterTavern sections)
- `app/library.js` (DEFAULT_SETTINGS + settings modal + save/reset + CT/Wyvern/Datacat handlers)
- `modules/module-loader.js` (provider loading block)

## Verification (to run once complete)

1. `ProviderRegistry.getProvider('charavault')` returns instance in console
2. Unauth browse returns results with throttle (≥1.2s spacing)
3. Import `https://charavault.net/cards/janitorai/ec8_Kai'Sa.card.png` → succeeds
4. Card with `has_book=true` → `data.character_book.entries` populated
5. App Password login (email + `cv_...`) succeeds; non-`cv_` password shows warning
6. After login, `minDelayMs` drops from 1200 to 600
7. `canHandleUrl` + `parseUrl` round-trip all 5 URL shapes
8. Without cl-helper plugin → browse still works unauth, login UI shows banner

## Plan file (source of truth for design)

`/root/.claude/plans/its-planning-time-the-delegated-crane.md`
