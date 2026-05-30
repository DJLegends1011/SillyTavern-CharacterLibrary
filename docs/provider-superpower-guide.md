# New Provider Superpower Guide

Use this guide as a required procedure for adding an Online provider to Character Library.

Do not infer provider behavior from the visible website. Do not invent a UI pattern. Do not create a provider from scratch while a close provider already exists. Every implementation choice must be backed by a website observation, a repo pattern, or a failing/passing test.

## Required Output

Before coding, create a draft note for the target provider under `docs/provider-drafts/`. The draft must contain:

- target website URL,
- recon date,
- data endpoints found,
- auth/session requirements,
- CORS/proxy result,
- Cloudflare/bot-protection result,
- closest existing provider and why,
- server-plugin decision and why,
- planned files,
- provider ID, display name, extension key, and URL ID format,
- mirror baseline provider and exact files used as references,
- mirror-only deviations with evidence and reason,
- user-facing stat labels and the source fields behind them,
- internal-only ranking or quality fields that must not appear in UI,
- copied provider folder and every copied control kept, changed, or removed,
- copied preview/card-open path and every modal shell class kept, changed, or removed,
- verification checklist for the provider.

Stop if any required field is unknown. Inspect more or ask the user.

## Phase 1: Website Recon

Perform these steps in order.

1. Open the target website.
2. Open a normal public character page.
3. Open DevTools > Network.
4. Reload the page.
5. Identify the request that returns character data.
6. Record method, URL, headers, request body, response shape, pagination fields, and auth state.
7. Test anonymous browse.
8. Test anonymous search.
9. Test anonymous character detail.
10. Test anonymous image/avatar download.
11. Test logged-in-only behavior only after public behavior is documented.
12. Record whether login unlocks NSFW, private cards, favorites, bookmarks, followed creators, timelines, galleries, or exports.
13. Test direct browser fetch from the extension origin when practical.
14. Test SillyTavern `/proxy/` or `fetchWithProxy()` only after direct browser fetch is known to fail.
15. Check for Cloudflare or bot challenge responses.
16. Record the canonical character identifier: UUID, numeric ID, `creator/slug`, or full path.
17. Record the source of truth for V2 fields: API JSON, embedded PNG, exported card JSON, page props, or scraped HTML.

Do not code until the draft note contains the evidence above.

## Phase 2: Choose The Provider To Copy

Search the repo before choosing:

```bash
rg -n "class .*Provider|renderView\\(|fetchRemoteCard\\(|importCharacter\\(" modules/providers
```

Use the table below as a selection rule. Pick the provider whose network and auth model matches first. UI similarity is secondary.

| Copy this provider | Required evidence |
| --- | --- |
| `modules/providers/chub/` | Target has token auth plus favorites, follows/timeline, rich gallery support, remote version history, or account-backed sync. |
| `modules/providers/chartavern/` | Target has useful public APIs or embedded PNG cards, but some content requires cookie/session proxying through `cl-helper`. |
| `modules/providers/pygmalion/` | Target browsing is public, but login requires server-side exchange or headers/cookies the browser cannot safely perform. |
| `modules/providers/wyvern/` | Target can run browser-side with normal API calls/auth and supports browse, import, gallery, or following without `cl-helper`. |
| `modules/providers/janny/` | Target requires HTML/app-shell scraping because no complete clean detail API exists. |
| `modules/providers/datacat/` | Target is server-plugin-first, aggregator-like, extraction-based, or needs custom server proxy/session/bootstrap behavior. |

Do not pick a provider because it looks visually close. Pick it because the request flow, auth flow, and data shape match.

Record the chosen provider in the draft note.

## Phase 3: Server Plugin Decision

Use this decision tree.

Stay browser-only only when all statements are true:

- Public browse works from browser code or `fetchWithProxy()`.
- Public detail works from browser code or `fetchWithProxy()`.
- Avatar/image fetch works or has an existing safe fallback.
- Auth is not required for the initial useful provider.
- No forbidden headers, protected cookies, server secrets, or persistent server sessions are required.
- No Cloudflare challenge blocks the required public data path.

Add `cl-helper` only when at least one statement is true:

- Browser CORS blocks required data and SillyTavern proxy does not solve it.
- The provider requires forbidden headers such as custom `Origin`, `Referer`, or raw cookie forwarding.
- Login requires a server-side exchange.
- Auth cookies must be stored server-side.
- The site requires reusable server-side bootstrap/session state.
- The response requires server-side decoding or normalization before the browser can use it.
- Cloudflare blocks required data and the only workable route is a user-configured FlareSolverr path.
- Account sync requires authenticated server-side handling.

For every `cl-helper` route:

- allowlist hostnames,
- allowlist paths,
- validate request bodies,
- reject unknown methods,
- reject unknown target URLs,
- return clear upstream errors,
- do not create an open proxy,
- do not store secrets that are not required.

## Phase 4: Repo Wiring Audit

Run these searches before writing provider code:

```bash
rg -n "providerSelectorArea|onlineFilterContent|onlineView" app/library.html app/library.js
rg -n "providerOrder|providerDefaults|providerExcludeTags|ADV_FILTER_PROVIDERS|PROVIDER_EXT_KEYS" app/library.js
rg -n "loadModuleCSS|providerImports|registerProvider|getViewProviders|getProviderForUrl" modules/module-loader.js modules/providers/provider-registry.js
rg -n "getComparableFields|fetchRemoteCard|character_book|listing_name" modules/card-updates.js modules/character-versions.js
rg -n "CL_HELPER_PLUGIN_BASE|plugins/cl-helper" modules extras
```

Update every applicable wiring point:

- `modules/module-loader.js`: add provider CSS and provider import.
- `modules/providers/provider-registry.js`: modify only if the generic registry cannot support the provider.
- `app/library.html`: add static UI only for global shared settings, help text, or import placeholders. Do not mount provider browse UI here.
- `app/library.js`: update hardcoded provider lists, settings controls, advanced filters, search prefixes, provider extension keys, and import/link flows when applicable.
- `modules/card-updates.js`: rely on provider `getComparableFields()` unless a global comparison rule is required.
- `modules/character-versions.js`: rely on provider comparable fields unless a global version rule is required.
- `modules/gallery-extractors/extractor-registry.js`: update only when provider metadata affects extractor behavior.
- `extras/cl-helper/index.js`: update only when Phase 3 requires server routes.
- `README.md`: update provider matrix and user-facing docs after the provider is real.

Do not assume the provider appears in the app because its folder exists. The provider appears only after the shared wiring loads it.

## Phase 5: Copy And Rename

Copy the chosen provider folder as files. Do not hand-build a new provider shell when Phase 2 selected a close match.

Preserve the copied provider shape first:

- `renderFilterBar()` control order,
- `renderView()` section order,
- `renderModals()` modal structure,
- shared class names,
- topbar button classes,
- dropdown classes,
- mobile filter IDs,
- custom select initialization,
- dropdown dismiss wiring,
- modal listener persistence,
- card click delegation,
- preview lookup/cache path,
- shared preview modal shell,
- card grid rendering path.

Remove or change a copied control only after the draft note records the exact target-site evidence that the capability does not exist. When a copied capability is not implemented in this pass, render an explicit unavailable state or omit the control with the recorded reason. Do not silently replace the copied shell with a simpler UI.

Rename all of these before adding behavior:

- filenames,
- class names,
- provider `id`,
- display name,
- extension metadata key,
- DOM ID prefix,
- CSS prefix,
- settings keys,
- log prefixes,
- preview globals,
- endpoint constants,
- URL parser names,
- test filenames.

Run these searches until no stale copied identifiers remain except intentional references in comments or docs:

```bash
rg -n "oldProviderId|OldProviderName|oldCssPrefix|oldDomPrefix" modules/providers/<new-provider> tests docs
```

## Phase 6: Implement The Provider Contract

Implement in this order.

1. `id`
2. `name`
3. `icon`
4. `iconUrl`
5. `browseView`
6. `hasView`
7. `renderFilterBar()`
8. `renderView()`
9. `renderModals()`
10. `activate()`
11. `deactivate()`
12. `canHandleUrl()`
13. `parseUrl()`
14. `getLinkInfo()`
15. `setLinkInfo()`
16. `getCharacterUrl()`
17. `fetchMetadata()`
18. `fetchRemoteCard()`
19. `normalizeRemoteCard()`
20. `supportsImport`
21. `importCharacter()`
22. `searchForBulkLink()`
23. `searchForImportMatch()`
24. `supportsGallery`
25. `fetchGalleryImages()`
26. `getSettings()`

Skip a method only when `ProviderBase` supplies the desired behavior and the provider does not advertise that capability.

## Phase 7: Match Existing UI Strictly

Use the copied provider's structure first. Do not create new visual structure unless the copied structure cannot represent the target provider.

Required Online browse structure:

- topbar controls in `renderFilterBar()`,
- main search/content in `renderView()`,
- modal HTML in `renderModals()`,
- provider root using existing shared classes such as `browse-section`, `browse-search-bar`, `browse-search-input-wrapper`, `browse-search-submit`, `browse-grid`, `browse-card`, `browse-card-image`, `browse-card-body`, `browse-card-name`, `browse-card-creator` or `browse-card-creator-link`, `browse-card-tags`, and `browse-card-footer`,
- provider-specific CSS only for gaps that shared CSS does not cover.

Required copied-control audit:

- If the copied provider has Browse/Following controls, decide and record whether the new provider supports each mode.
- If a mode is unsupported, keep the visual pattern consistent and document the unavailable behavior.
- If the copied provider uses `CoreAPI.initCustomSelect()`, initialize the new provider select the same way.
- If the copied provider has Tags or Features controls, keep them unless the target has no tag/filter data and the draft note records that result.
- If a new provider-specific button class is created, update shared CSS selectors that style equivalent provider buttons.
- If mobile filter IDs exist in the copied provider, add equivalent IDs or record why the provider is intentionally excluded from mobile settings.

Required preview-open contract:

- `create<Provider>Card()` must render the same clickable card structure as the copied provider.
- Each card must include the data attribute that the click delegate reads.
- The click delegate must attach to the current grid after DOM creation.
- The click delegate must find the clicked character from the rendered result set, lookup map, following list, or detail cache.
- The preview opener must set selected character state before import buttons can run.
- `renderModals()` must use the same shared shell family as the copied provider. For current browse providers, this means `modal-overlay hidden` on the overlay and `modal-glass browse-char-modal` on the panel unless the copied provider uses a different documented shell.
- Open must remove `hidden` from the overlay element that shared CSS controls.
- Close must add `hidden` back to the same overlay element.
- Overlay click, close button, mobile back handling, and provider deactivation must all close or clean up the same preview.

Card rules:

- Keep browse cards compact.
- Do not render long descriptions inside browse cards.
- Put long description, greeting, scenario, lorebook, or prompt fields in the preview modal.
- Clamp names through the shared card name style.
- Keep footer stats short.
- Use shared icon button styles for search, refresh, filters, and NSFW controls.
- Preserve lazy image loading through `observeImages()`.
- Use the same modal listener persistence pattern as the copied provider. Modal DOM persists across provider switches.
- Use the website's visible metric names for preview and link stats. If the API exposes internal fields such as quality, rank, score, weight, recommendation, or boost values, keep them internal to sorting or provider extension metadata unless the website displays that metric to normal users.
- When replacing copied provider stat slots, update the icon, label, and value source together. Do not leave a copied label connected to a different source field, and do not expose internal ranking fields because a copied provider had an empty stat slot.
- Do not declare preview open complete until clicking a real rendered card opens the modal in the browser.

After rendering, compare the new provider against the copied baseline provider in the browser. Topbar controls, card density, preview shell, stat row spacing, action buttons, and close behavior should look like the baseline provider unless the draft note records an intentional target-site reason.

## Phase 7A: Mirror Sync Contract

Use this phase when the request says the provider should mirror another provider, such as BotBooru mirroring ChubAI.

Mirror means same behavior, layout contract, event flow, and shared renderer usage. It does not mean "similar enough." Only the provider identity, source endpoints, source field names, and target-site-specific capabilities should differ.

Required mirror baseline:

1. Write the baseline provider name in the draft note.
2. Record the exact baseline files inspected.
3. Record every intentionally different control, stat, endpoint, and unsupported feature.
4. Record every copied behavior that must remain identical.

Required side-by-side audit:

- topbar order, spacing, active states, and mobile collapse behavior,
- Browse/Following/Curated or equivalent mode placement,
- search panel layout, creator search behavior, clear/search buttons, and result count placement,
- sort/filter/dropdown custom select behavior,
- card grid density, image sizing, tag clamping, footer stat icons, and timestamp display,
- preview modal shell, close behavior, stats row, tag row, action buttons, creator link, and import flow,
- Creator Notes rendering path, including secure iframe usage, fullscreen expansion, HTML/entity decoding, media sizing, and cleanup,
- followed creator manager placement, counts, sorting, add/remove actions, and empty states,
- mobile viewport behavior for all controls above.

Required code audit:

```bash
rg -n "renderFilterBar|renderView|renderModals|create.*Card|open.*Preview|close.*Preview" modules/providers/<baseline> modules/providers/<provider>
rg -n "renderCreatorNotesSecure|cleanupCreatorNotesContainer|dataset.fullContent|currentCreatorNotesContent" app modules/providers/<baseline> modules/providers/<provider>
rg -n "mobileFilterIds|getSearchModes|getSearchInputId|initCustomSelect" modules/providers/<baseline> modules/providers/<provider>
```

Do not add provider-specific markup for a mirrored surface until the same surface in the baseline provider has been read and the difference is written down.

When a mirrored provider has malformed upstream data, normalize that provider's input before it enters the shared baseline renderer. Do not fork the shared renderer unless the same bug affects multiple providers. For rich notes, this means:

- feed rich notes through `renderCreatorNotesSecure()` when the baseline does,
- do not set `dataset.fullContent` on secure Creator Notes if the baseline expands the iframe output,
- decode provider-specific escaped HTML before sanitization,
- preserve the shared fullscreen media sizing rules,
- add a regression test with the malformed provider payload, not only a clean synthetic payload.

Before calling mirror work complete, capture a checklist comparing the baseline and mirrored provider. Each row must be one of:

- `same`,
- `intentional difference: <reason>`,
- `not supported by target site: <evidence>`.

## Phase 8: Card Data Mapping

Map source fields deliberately:

- provider page/listing title -> `data.extensions.<providerId>.pageName`,
- stable provider ID/path -> `data.extensions.<providerId>.id` and/or `fullPath`,
- character definition -> `data.description`,
- distinct personality -> `data.personality`,
- distinct scenario -> `data.scenario`,
- first message -> `data.first_mes`,
- alternate greetings -> `data.alternate_greetings`,
- website tagline/listing blurb -> `data.extensions.<providerId>.tagline`,
- actual source author notes or creator notes -> `data.creator_notes`,
- embedded/fetchable lorebook -> `data.character_book`,
- tags -> normalized string array.

Map V2-like source fields directly. Do not fill an empty V2 field from a different listing field unless the draft note records evidence that the target site uses that field as the canonical value.

Do not write import provenance into V2 content fields. Store source URLs, import timestamps, remote stats, listing names, and provider-specific display fields under `data.extensions.<providerId>`.

Do not copy a website tagline into `data.personality`, `data.description`, `data.scenario`, or `data.creator_notes`. If a source field duplicates or appends the tagline, strip that duplicate and store the tagline only under `data.extensions.<providerId>.tagline`.

Do not add the provider's own name as a card tag. Provider identity belongs in `data.extensions.<providerId>` and the link/update metadata.

Do not store volatile stats in comparable card fields. Store volatile stats in provider extension metadata only when the UI needs them.

Do not overwrite local card content during enrichment unless the current import flow fetched that card from the provider. For existing local cards, add provider metadata only after strict matching.

For provider stat displays, map source fields by user-facing meaning instead of column name. Prefer the labels shown on a normal source character page. Keep ranking-only fields in API helpers or extension metadata; they can influence browse ordering but should not become card preview stats, link stat labels, creator notes, or imported tags.

## Phase 9: Account Sync

Implement account sync only after public browse, preview, import, linking, and update checks work.

If the website has bookmarks, favorites, follows, collections, subscriptions, or timelines:

1. Record endpoint evidence in the draft note.
2. Record auth requirements.
3. Copy Chub's favorites/following patterns when the feature is account-backed.
4. Use `BrowseView` following manager hooks for followed creators:
   - `supportsFollowingManager`
   - `getFollowedCreators()`
   - `followCreator(query)`
   - `unfollowCreator(id)`
   - `getCreatorAvatarUrl(creator)`
5. Use the website's user-facing term in UI text.
6. Keep internal keys provider-specific.

Do not add sync controls that cannot work with the implemented auth path.

## Phase 10: Tests

Add focused tests for:

- URL parsing,
- ID validation,
- row normalization,
- V2 card mapping,
- tagline/listing blurb is not imported into V2 content fields,
- private/unlisted/NSFW filtering,
- provider identity and link metadata,
- imported tags do not include the provider's own name,
- stale cache behavior,
- topbar copied-control HTML,
- preview modal shell HTML,
- persistent modal listener behavior,
- card click lookup behavior when practical,
- importable module smoke.

Use `node --test` unless the repo defines a different test command.

## Phase 11: Required Verification

Run these before claiming the provider is ready:

```bash
node --test
node --check app/library.js
node --check modules/providers/<provider>/<provider>-api.js
node --check modules/providers/<provider>/<provider>-browse.js
node --check modules/providers/<provider>/<provider>-provider.js
git diff --check
```

Also run a live API smoke when the provider uses public endpoints:

```bash
node --input-type=module -e "const api=await import('./modules/providers/<provider>/<provider>-api.js'); /* call one browse/search function and print IDs */"
```

Run browser visual QA before merge:

1. Open the app.
2. Open Online.
3. Select the provider.
4. Confirm provider selector displays the provider.
5. Confirm topbar controls match existing providers.
6. Confirm search panel matches existing providers.
7. Confirm cards match existing provider density.
8. Click a rendered card, not an empty test fixture.
9. Confirm the preview overlay becomes visible.
10. Confirm the preview uses the same modal shell as the copied provider.
11. Confirm the preview shows the clicked card's name/avatar/tags/stats.
12. Confirm preview stats use website-visible labels and do not expose internal ranking fields.
13. Confirm preview closes by close button.
14. Confirm preview closes by overlay click.
15. Confirm import works.
16. Confirm imported card shows In Library.
17. Confirm provider link metadata exists.
18. Confirm Check for Updates returns sane diffs.
19. Confirm provider URL import routes to the provider.
20. Confirm mobile viewport has no overlapping text or controls.

Do not mark the task complete without recording which checks passed and which checks were not run.

## Phase 12: AIO Integration Branches

Use this phase when combining multiple provider, bookmark, helper, or UI feature branches into one all-in-one branch.

Treat an AIO branch as disposable integration output, not as a development source of truth.

1. Start from fresh `origin/main`.
2. Create a new branch with an explicit rebuild name such as `codex/aio-clean-rebuild`.
3. Keep every feature branch independently working against `main` when practical.
4. Integrate one feature at a time as a clean logical commit.
5. Prefer squash commits or carefully selected commits over merging exploratory branch history.
6. Prefix AIO commits with the source feature branch or feature area, for example `[botbooru-provider]`, `[masquerade-provider]`, or `[extended-bookmarks]`.
7. Include the source commit hash in the commit body when cherry-picking or re-creating a feature branch commit.
8. If a feature patch depends on earlier commits from the same branch, bring the dependency chain too. Do not cherry-pick only the final symptom fix when the AIO branch lacks the renderer, API, or UI contract it depends on.
9. Run the focused test suite after each feature lands.
10. Inspect shared files after every integration:
   - `app/library.js`
   - `app/library.html`
   - `modules/module-loader.js`
   - `modules/providers/browse-shared.css`
   - `extras/cl-helper/index.js`
11. Keep provider-specific edits when the feature is expected to touch each provider, such as bookmarks.
12. Do not treat provider-specific edits as accidental until the originating branch or commit is checked.
13. Do not carry AIO-only fixes silently. Move fixes back to the feature branch or document why the fix only belongs in AIO.
14. If a shared behavior breaks only on the AIO branch, rebuild the AIO branch from `origin/main` before patching symptoms.
15. Delete or archive dirty AIO branches after the clean rebuild is pushed and verified.

Minimum AIO verification:

```bash
node --test tests/*.mjs
git diff --check
git log --oneline origin/main..HEAD
```

The final AIO history should read like a checklist, for example:

```text
feat: integrate BotBooru provider
feat: integrate MasqueradeAI provider
feat: add provider bookmarks
fix: harden Saucepan helper proxy
[botbooru-provider] Decode BotBooru escaped creator notes HTML
```

Do not merge a dirty AIO branch forward just because it already contains everything. Rebuild from a clean base when upstream has changed heavily or when shared behavior breaks in the integration branch.

## Stop Rules

Stop and ask the user when:

- no data endpoint can be identified,
- direct and proxied requests both fail,
- Cloudflare blocks required data,
- auth is required for all useful behavior,
- the closest provider is unclear after evidence collection,
- the implementation requires server routes but the user has not approved `cl-helper` scope,
- the UI cannot match an existing provider without changing shared CSS/HTML,
- verification cannot run.

## Final Rule

Inspect first. Copy second. Wire every shared entry point third. Match the existing UI fourth. Add new infrastructure last.
