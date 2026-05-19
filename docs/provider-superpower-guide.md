# New Provider Superpower Guide

Use this when adding a new online provider to Character Library. The goal is not to invent a provider from scratch. The goal is to inspect the target website, find the existing provider that behaves most like it, duplicate that pattern, and only add new infrastructure when the site forces your hand.

## Mission

Build the smallest provider that can reliably browse, preview, import, link, and update characters from the target site.

Before coding, answer these questions:

- What data source does the website actually use: public REST, GraphQL, MeiliSearch, embedded PNG cards, page HTML, or a private app API?
- Can browser-side `fetch()` reach it directly, or does it need SillyTavern's `/proxy/`, `fetchWithProxy()`, or `cl-helper`?
- Does the provider need user auth for useful features, or only for optional extras?
- Does the site expose bookmarks, favorites, follows, or a timeline worth syncing into Character Library?
- Which existing provider already solved the closest version of this problem?

## Website Recon Checklist

Do this in the browser before touching repo files:

1. Open the site and inspect a normal character page.
2. Open DevTools > Network and reload the page.
3. Find the requests that carry character data. Prioritize JSON/API requests over HTML scraping.
4. Check the request method, URL, headers, body, cookies, response shape, pagination, and auth requirements.
5. Test whether an anonymous session can search, browse, open details, and download/import a card.
6. Test whether logged-in state unlocks important data such as NSFW results, private cards, favorites, follows, galleries, or bookmarks.
7. Test direct browser fetches from Character Library's origin when possible. If CORS blocks direct requests, try SillyTavern's `/proxy/`.
8. Check for Cloudflare or bot challenges. If the response is a challenge page, server-side Node fetch may not help.
9. Record the canonical ID format for a character, such as `creator/slug`, UUID, numeric ID, or full URL path.
10. Record the best source of truth for V2 card fields: API JSON, embedded PNG, exported card JSON, or scraped page props.

Save the recon notes somewhere temporary before coding. The implementation should follow what the site really does, not what the visible page suggests.

## Pick The Closest Existing Provider

Start by copying the provider that resembles the new website. Rename IDs, selectors, settings, endpoint constants, extension keys, and CSS class prefixes after the copy.

| Copy this provider | When the new website resembles it |
| --- | --- |
| `modules/providers/chub/` | Full-featured provider with token auth, favorites, following/timeline, gallery downloads, remote version history, linked lorebooks, bulk linking, and rich browsing. Use this as the model when the target site has account-backed sync features like bookmarks/favorites/follows. |
| `modules/providers/chartavern/` | Site exposes useful REST APIs and/or embedded PNG cards, but some content needs session cookies through `cl-helper`. Good model for optional cookie auth and read-only server proxying. |
| `modules/providers/pygmalion/` | Public browsing works, but login needs a server-side auth proxy because browser JS cannot set required headers or complete the auth flow safely. Good model for email/password auth routed through `cl-helper`. |
| `modules/providers/wyvern/` | Auth can happen browser-side and the provider supports browse, import, gallery, and following without requiring `cl-helper`. Good model for Firebase or normal API auth. |
| `modules/providers/janny/` | Search is API-backed, but detail pages require HTML/Astro scraping and may fight CORS or Cloudflare. Good model when no clean detail API exists. |
| `modules/providers/datacat/` | Provider is experimental, aggregator-like, or server-plugin-first. Good model when `cl-helper` is required for sessions, extraction, custom proxying, FlareSolverr forwarding, or upstream quirks like compression/browser-incompatible responses. |

If two providers look close, copy the one whose networking/auth model matches first. UI shape is easier to adjust than a mismatched data path.

## Browser-Only Or Server Plugin?

Default to browser-only when the site allows it. Add `cl-helper` support only when it unlocks reliability or a real feature.

Stay browser-only when:

- Public APIs work from the browser or through SillyTavern's CORS proxy.
- Auth can use a normal token header in browser requests.
- No forbidden headers, protected cookies, or server-only secrets are needed.
- The site does not require long-lived shared session state.

Use `cl-helper` when:

- Browser requests are blocked by CORS and ST's `/proxy/` is insufficient.
- The provider needs forbidden headers such as custom `Origin`, `Referer`, or cookie forwarding.
- Login requires a server-side exchange, as with Pygmalion.
- Auth uses cookies that should be stored server-side, as with CharacterTavern.
- The provider needs reusable session/bootstrap state, as with DataCat.
- Responses need server-side decoding or normalization before the browser can consume them.
- The site is behind Cloudflare and the only workable path is a user-provided FlareSolverr service.
- You want user account sync features like bookmarks, favorites, followed creators, or timeline data and those APIs require authenticated server-side handling.

Keep every `cl-helper` route narrow:

- Allowlist hostnames and paths.
- Prefer read-only `GET` proxies unless a write action is explicitly needed.
- Validate request body fields and lengths.
- Do not create an open proxy.
- Do not store unnecessary secrets.
- Return upstream errors clearly enough for the UI to explain setup problems.

## Provider Anatomy

A normal provider folder has these files:

- `newsite-provider.js`: provider identity, link metadata, card normalization, imports, updates, auth, URL parsing, gallery, and bulk-link behavior.
- `newsite-api.js`: endpoint constants, network helpers, response parsing, auth helpers, card builders, and cache/session helpers.
- `newsite-browse.js`: Online tab controls, browse/search state, preview modal, import buttons, follow/favorite/bookmark controls, lazy image loading, and event wiring.
- `newsite-browse.css`: provider-specific UI polish only. Shared browse styling belongs in `modules/providers/browse-shared.css`.

Shared contracts live here:

- `modules/providers/provider-interface.js`: the provider methods and capability flags.
- `modules/providers/provider-registry.js`: provider registration, activation, character ownership lookup, and URL dispatch.
- `modules/providers/provider-utils.js`: shared fetch, text, PNG import, gallery save, and `CL_HELPER_PLUGIN_BASE`.
- `modules/providers/browse-view.js`: base browse behavior, local-library lookup, image observers, preview helpers, and following manager support.
- `modules/module-loader.js`: CSS loading and provider imports.
- `app/library.html`: shared Online tab anchors such as `providerSelectorArea`, `onlineFilterContent`, and `onlineView`.
- `app/library.js`: top-level Online tab activation, settings rendering, URL import routing, provider link display, and shared modal flows.
- `app/library.css` and `app/library-mobile.css`: shared layout and responsive styles. Add provider-specific CSS only when the copied provider's shared classes are not enough.

## Provider Wiring Points

Do not stop after creating the provider folder. Search for the copied provider ID and update every central wiring point that applies.

In the current app, the provider selector and Online tab content are generated dynamically:

- Static HTML supplies the shared slots in `app/library.html`: `providerSelectorArea`, `onlineFilterContent`, and `onlineView`.
- `modules/module-loader.js` imports provider modules and provider CSS. This is the normal place to make a provider exist at runtime.
- `modules/providers/provider-registry.js` builds the provider selector, activates views, routes provider URLs, and finds which provider owns a local card.
- `app/library.js` renders provider order/settings, toggles the Online tab, handles batch URL imports, displays linked-provider metadata, and asks each provider to enrich local imports.
- `modules/card-updates.js` and `modules/character-versions.js` consume provider comparable fields for update/version diff UI.
- `modules/gallery-extractors/extractor-registry.js` can read provider extension metadata when gallery/media extraction needs provider context.
- `extras/cl-helper/index.js` needs narrow routes only when the provider requires server plugin support.

Only edit static HTML when the shared slots or global controls themselves need to change. Normal provider UI should come from `renderFilterBar()`, `renderView()`, and `renderModals()` so the registry can mount it consistently.

When you copy a provider, search for all of these strings before coding too far:

- the old provider ID, display name, extension key, CSS prefix, DOM ID prefix, settings keys, and log prefix,
- provider-specific settings in `getSettings()` and `app/library.js`,
- provider-specific preview globals such as `window.openChubCharPreview`,
- server routes or plugin checks in `extras/cl-helper/index.js`,
- README/provider matrix entries.

## Implementation Plan

Follow this order.

1. Finish website recon and write down the source endpoints.
2. Pick the closest provider from the table above.
3. Duplicate that provider folder and rename file names, classes, constants, DOM IDs, CSS prefixes, settings keys, and extension metadata keys.
4. Search the repo for the copied provider ID/name and update the central wiring points listed above.
5. Add the provider CSS and provider import to `modules/module-loader.js`.
6. Confirm `app/library.html` already has the shared Online tab anchors the provider needs. Add shared HTML only if a new global slot is required.
7. Implement identity first: `id`, `name`, `icon`, `iconUrl`, `browseView`, `hasView`, `renderFilterBar()`, `renderView()`, and lifecycle methods.
8. Implement URL routing: `canHandleUrl()` and `parseUrl()`.
9. Implement link metadata: `getLinkInfo()`, `setLinkInfo()`, and `getCharacterUrl()`. Store stable provider metadata under `card.data.extensions.<providerId>`.
10. Implement browse/search with the simplest useful filters. Get cards rendering before adding advanced controls.
11. Implement preview/details. Reuse the browse view modal pattern from the copied provider.
12. Implement `fetchMetadata()` and `fetchRemoteCard()` using the most complete source of truth.
13. Implement `normalizeRemoteCard()` so update diffs compare V2-compatible fields.
14. Implement `supportsImport` and `importCharacter()`. Use `assignGalleryId()` and `importFromPng()` from `provider-utils.js`.
15. Implement auth only after anonymous browse/import works.
16. Implement account sync features next: bookmarks/favorites/follows/timeline. Chub is the best reference for favorites and following.
17. Implement optional capabilities only if the website supports them: gallery downloads, bulk link, remote version history, linked lorebooks, remote page version, or custom comparable fields.
18. Add `cl-helper` routes only if the decision tree says they are needed.
19. Add settings descriptors through `getSettings()` for tokens, cookies, feature toggles, or server plugin endpoints.
20. Update docs or README provider matrix if the new provider is user-facing.

## Card Data Rules

Character Library expects V2 card data for imports and update checks. Map provider fields deliberately:

- Provider display name or page title goes into `pageName` inside the provider extension metadata.
- Character definition goes into `data.description`.
- Personality goes into `data.personality` only if the source has a distinct personality field.
- Website blurb/tagline usually belongs in `data.creator_notes` or `data.extensions.<providerId>.tagline`.
- Alternate greetings should be preserved when the source exposes them.
- Lorebooks should go into `data.character_book` when embedded or fetchable.
- Tags should be normalized to plain strings.
- Store stable IDs and paths in `data.extensions.<providerId>` so local cards can be linked later.

Never overwrite local card content during auto-enrichment unless the card was imported from that provider in the current flow. For local import enrichment, prefer adding provider metadata and tags only after strict name/creator checks.

## Account Sync Features

If the target website has bookmarks, favorites, follows, collections, or a creator timeline, treat that as a first-class provider capability.

Use Chub as the reference when implementing:

- token-backed auth settings,
- favorites filtering,
- add/remove favorite buttons,
- followed creator manager,
- timeline/following tab,
- account-gated restricted content,
- cached favorite/follow IDs for fast badge updates.

Use `BrowseView`'s following manager hooks when the website tracks followed creators:

- `supportsFollowingManager`
- `getFollowedCreators()`
- `followCreator(query)`
- `unfollowCreator(id)`
- `getCreatorAvatarUrl(creator)`

If the site calls the feature "bookmarks" instead of "favorites", keep UI text aligned with the site but store the implementation in provider-specific names to avoid confusing it with SillyTavern native favorites.

## Cloudflare And Anti-Bot Notes

Cloudflare changes the provider design.

Try these in order:

1. Use official/public APIs that are not protected.
2. Use browser-accessible app APIs with the same headers the site uses.
3. Use SillyTavern `/proxy/` or `fetchWithProxy()` for CORS-only failures.
4. Use `cl-helper` for required forbidden headers, cookies, sessions, or response decoding.
5. Use a user-configured FlareSolverr endpoint through `cl-helper` only for specific allowlisted URLs.

Do not silently depend on a public third-party CORS proxy for core features unless there is no better path and the UI clearly explains the reliability tradeoff. Janny's current fallback pattern is useful context, but a new provider should prefer first-party or user-run infrastructure.

## Registration Checklist

Before calling it done, verify:

- The provider is imported in `modules/module-loader.js`.
- Its CSS is loaded in `modules/module-loader.js` if it has provider-specific CSS.
- Static Online tab anchors in `app/library.html` still match what `app/library.js` and `provider-registry.js` expect.
- The provider appears in the generated provider selector and settings provider-order list.
- The provider returns a unique `id` and uses that same ID in extension metadata.
- URL import dispatch works through `canHandleUrl()` and `parseUrl()`.
- Browsing handles empty, loading, error, and pagination states.
- Preview modal opens and closes cleanly on desktop and mobile.
- Import creates a valid PNG character card and links it back to the provider.
- Update checks fetch fresh remote data and produce sane diffs.
- Auth-required controls degrade gracefully when logged out or when `cl-helper` is missing.
- Server plugin routes, if added, are allowlisted and not open proxies.
- Settings labels make setup understandable without reading code.
- README/provider matrix is updated if the provider ships to users.

## Quick Smoke Tests

Run or manually verify these flows:

1. Open Online tab and switch to the new provider.
2. Search a common character name.
3. Open preview for a result.
4. Import the result.
5. Confirm the card appears in the local library with an In Library badge.
6. Open the imported card and confirm provider link metadata is present.
7. Run Check for Updates on the imported card.
8. Paste a provider URL into batch import and confirm routing picks the new provider.
9. Toggle NSFW/auth-only features while logged out and logged in, if supported.
10. If `cl-helper` is involved, test both missing-plugin and installed-plugin states.

## Agent Reminder

When in doubt, inspect first, copy the closest provider second, and only build new infrastructure third. The provider should feel native to Character Library, but its network strategy must match the website's real behavior.
