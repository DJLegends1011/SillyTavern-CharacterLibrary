# JannyAI collections UX design

## Context

The `codex/jannyai-account-sync` branch adds JannyAI account sync for bookmarks and collections. The current implementation works as a useful first pass, but the collection UX differs from JannyAI in ways that make it heavier and less discoverable:

- Saving a character to a collection is a persistent preview-modal section with a native select and a separate submit button.
- The new Collections tab only shows account-owned collections.
- Owned collections are plain rows and omit descriptions, preview thumbnails, and edit/manage affordances.
- Mobile behavior has not been designed explicitly.

Reference observations are captured in `docs/superpowers/notes/2026-07-09-jannyai-account-sync-ux-notes.md`.

## Goals

1. Keep the new CL Collections tab.
2. Make collection interactions feel like Character Library UI, not a pasted JannyAI page.
3. Borrow JannyAI's proven interaction model where it is better:
   - direct collection dropdown toggles from character pages
   - public collection browsing
   - richer owned collection cards
   - native-style collection edit/manage flows
4. Treat mobile as a first-class design target.
5. Produce visual artifacts before implementation so the maintainer can review the end-state UX.
6. Preserve clear account, cl-helper, and Cloudflare diagnostics.

## Non-Goals

- Do not remove the Collections tab.
- Do not redesign unrelated JannyAI browse filters, card rendering, imports, or provider settings.
- Do not duplicate JannyAI's visual styling wholesale. Use CL's existing dark glass, magenta accent, compact toolbar, browse grid, modal, toast, and mobile patterns.
- Do not require account sync for public collection browsing unless JannyAI blocks the read-only public route.
- Do not implement destructive actions, such as delete collection, without confirmation.

## Design Principles

- **CL-native chrome:** New controls should reuse existing `glass-btn`, dropdown, browse-card, banner, modal, toast, and status styles where possible.
- **JannyAI-native behavior:** Match JannyAI's interaction semantics for collection add/remove, public browsing, collection metadata, and member management.
- **Progressive complexity:** Preview actions stay simple; deeper management lives in the Collections tab.
- **Responsive by default:** Every desktop surface needs a defined mobile equivalent before implementation starts.
- **Explicit failures:** Account-only actions should explain whether the user needs cl-helper, a saved cookie, validation, or a refreshed Cloudflare session.

## Required Visual Artifacts

Before implementation, create reviewable artifacts under `docs/superpowers/artifacts/jannyai-collections-ux/`.

Artifacts must show:

- Desktop preview modal with the `Add to collection` dropdown closed, open, checked, and error states.
- Mobile preview modal with the same states.
- Desktop Collections tab in `Public Collections` mode.
- Mobile Collections tab in `Public Collections` mode.
- Desktop `My Collections` cards.
- Mobile `My Collections` cards.
- Owned collection edit/manage view, at least desktop plus a mobile layout sketch.

Artifacts should use CL's existing visual language: dark background, compact controls, magenta accent, existing icon style, card radius consistent with the app, and no light JannyAI page clone.

## Surface 1: Preview Modal Collection Action

### Current Problem

The preview modal has a persistent `Collections` section with:

- `Choose collection...` native select
- separate `Add to collection` button
- extra vertical space inside the card details

This is slower than JannyAI's interaction and makes collections feel like a form instead of a quick character action.

### Desired Behavior

Replace the persistent section with an action-row dropdown near `Open`, `Bookmark`, and `Import`.

The control should:

- Render as `Add to collection` with a collection icon and caret.
- Open a CL-styled dropdown list of collections.
- Load owned collections on first open if they are not already loaded.
- Show checked state for collections containing the current character.
- Toggle membership immediately when a collection row is clicked.
- Keep the dropdown open after add/remove so multiple memberships can be changed quickly.
- Toast results using the character and collection names:
  - `Added <character> to <collection>.`
  - `Removed <character> from <collection>.`
- Truncate long collection names.
- Disable or show a loading state for only the row being changed.

### Empty and Error States

- No account cookie: show a concise toast pointing to Settings -> Online -> JannyAI.
- cl-helper unavailable: show a concise toast explaining cl-helper is required.
- Cloudflare challenge: show a concise toast explaining the cookie likely needs refreshing.
- No collections: show an inline dropdown empty state with an action to open My Collections/Create.
- Collection load failed: show an inline dropdown error and keep the trigger available for retry.

### Mobile Behavior

- The dropdown must fit within the viewport and avoid clipping behind the modal edge.
- Use a minimum practical touch target of about 44px for rows.
- Use internal scrolling for long collection lists.
- Keep the action accessible when modal header controls wrap.
- Do not rely on the browser's native select UI.

## Surface 2: Collections Tab

### Current Problem

The Collections tab is account-owned only. It has value, but it is closer to an account sync panel than JannyAI's Collections area.

### Desired Structure

Keep the tab and split it into two clear modes:

- `Public Collections`
- `My Collections`

The tab defaults to Public Collections, with My Collections one click away. If account state is missing, Public Collections should still be usable when the public route works.

### Public Collections

Public Collections should mirror JannyAI discovery behavior while using CL styling.

Cards should show, when available:

- preview thumbnail collage
- collection name
- character count
- description
- owner/collector
- view count
- last updated date

Controls should include:

- sort by `Latest`
- sort by `Most popular`
- load-more pagination using the existing CL browse pattern
- refresh

Opening a public collection should show a detail view with:

- back action to the public list
- larger preview collage
- collection name
- owner
- last updated date
- description
- character count
- character grid using existing Janny card rendering and import preview behavior

### My Collections

My Collections should keep account-owned management and creation, but use richer cards.

Owned collection cards should show:

- preview thumbnail collage
- private/public indicator
- collection name
- character count
- last updated date when available
- description
- clickable title/preview area plus an explicit `Open` button
- edit affordance
- delete affordance only with confirmation and only when supported

The create-collection form can remain in the tab, but it should be visually subordinate to the list and not crowd the top of mobile screens.

### Mobile Behavior

- Use a segmented control or compact tabs for Public/My.
- Cards should become single-column and avoid nested-card clutter.
- Collection descriptions should clamp rather than expanding rows indefinitely.
- Preview collages should preserve aspect and not cause layout shift.
- Public sort and refresh controls should wrap cleanly.
- Detail view should keep back navigation obvious and avoid burying the character grid.

## Surface 3: Owned Collection Edit/Manage

### Native JannyAI Reference

JannyAI's edit page combines metadata and membership management:

- `Name` input
- public/private radio options
- `Description` textarea with markdown support
- `Save` for metadata
- `Characters (<count>)`
- search or paste-link combobox
- `Characters will be auto-saved!`
- character rows with thumbnail, name, short description, and `Remove`

### Desired CL Behavior

Add an owned collection manage view in the Collections tab.

Metadata area:

- collection name input
- public/private control
- description textarea
- save button
- clear success/error feedback

Membership area:

- character count
- existing character rows/cards
- per-character remove action
- auto-save messaging for membership changes
- paste-link add for JannyAI/JanitorAI character URLs
- search-as-you-type add as a later enhancement if a reliable data source is available

If paste-link add cannot be implemented safely in the first manage-view slice, the visual slot and state model should still be included so the feature can land without reshaping the page.

### Destructive Actions

- Delete collection requires confirmation.
- Remove character from collection requires either a lightweight undo/toast or a confirm step only if the action is hard to reverse.
- Never trigger delete from a single accidental click.

### Mobile Behavior

- Metadata fields stack full width.
- Public/private choice should be large enough to tap.
- Save should stay near the fields it affects.
- Member rows should show thumbnail, title, and remove action without horizontal scrolling.
- Add/search input should not hide the list behind the keyboard.

## Data and API Needs

### Existing Pieces

The branch already includes:

- owned collection list: `fetchJannyCollections`
- owned collection characters: `fetchJannyCollectionCharacters`
- add character to collection: `addJannyCharacterToCollection`
- remove character from collection: `removeJannyCharacterFromCollection`
- create collection: `createJannyCollection`
- cl-helper allowlist entries for collection form add/edit/delete

### New or Expanded Pieces

The implementation plan should define adapters for:

- public collection list fetch with sort and page
- public collection detail fetch
- collection card normalization
- collection preview image extraction
- owned collection metadata update
- owned collection delete
- owned collection member removal
- paste-link member add
- optional search-as-you-type member add if a reliable data source is available

When JannyAI does not expose a stable JSON endpoint, use a narrowly scoped parser or helper route and return a precise unsupported/error state rather than a vague failure.

## State Model

Track these separately:

- account session status
- owned collection list
- per-character collection membership
- public collection page/sort/loading state
- active public collection detail
- active owned collection detail/manage state
- row-level mutations for add/remove

Avoid making one global `jannyCollectionsLoaded` flag responsible for public, owned, and per-character membership views.

## Error Handling

Public browsing:

- Should work without account state when the public JannyAI route is readable.
- If public browsing fails due to Cloudflare or network issues, show public-read diagnostics without telling the user to configure account sync unless that is actually required.

Owned/account actions:

- Missing cl-helper: explain cl-helper is needed.
- Missing cookie: point to Settings -> Online -> JannyAI.
- Invalid cookie: ask the user to refresh the cookie.
- Cloudflare challenge: explain that JannyAI blocked helper requests and the cookie/session may need refreshing.
- Unsupported route: show that the action is not available from CL yet and offer to open JannyAI.

## Testing and Verification

Unit or integration tests should cover:

- collection normalization for public and owned shapes
- parsing/extracting public collection list data
- parsing/extracting collection detail metadata
- edit/delete form request shaping if implemented
- preview dropdown membership toggle state
- error summaries for Cloudflare, missing account, and unsupported routes

Manual or browser verification should cover:

- desktop preview dropdown add/remove
- mobile preview dropdown add/remove
- public Collections list desktop and mobile
- public collection detail desktop and mobile
- My Collections cards desktop and mobile
- owned manage view desktop and mobile if implemented in the slice

Run existing JS syntax checks and node tests before calling the implementation complete.

## Implementation Staging

This design is intentionally full-parity, but implementation should be staged to reduce risk.

### Slice 1: Visual Artifacts and Data Boundaries

- Create the visual artifacts listed above.
- Decide the public collection data source.
- Add normalization helpers and tests.

### Slice 2: Preview Modal Dropdown

- Replace the persistent modal Collections section with a CL-styled dropdown action.
- Implement immediate add/remove toggle and checked state.
- Verify desktop and mobile modal behavior.

### Slice 3: Public Collections Browse

- Add Public/My mode split.
- Implement public collection cards, sort, load-more pagination, and detail view.
- Reuse existing Janny card rendering for collection detail grids.

### Slice 4: My Collections Card Upgrade

- Upgrade owned collection rows into richer cards.
- Add descriptions, preview thumbnails, updated date, privacy, and better open affordance.
- Keep create collection available without dominating the tab.

### Slice 5: Owned Manage View

- Add metadata edit/save.
- Add member remove.
- Add delete with confirmation if the route is reliable.
- Add paste-link member add.
- Leave a clear extension point for search-as-you-type member add if the reliable data source is not ready.

## Acceptance Criteria

- The preview modal no longer shows a persistent Collections section.
- Users can add/remove the current character from collections through a dropdown.
- Checked membership state is visible and updates without closing the dropdown.
- The Collections tab supports public collection browsing and owned collections.
- Collection descriptions are visible on public and owned collection cards when available.
- Public collection details show metadata and a character grid.
- Owned collection cards feel like CL UI and do not look like a light JannyAI clone.
- Mobile layouts are explicitly verified for the modal dropdown, collection lists, and detail/manage surfaces.
- Visual artifacts are reviewed before implementation begins.
- Git status is checked and reported after changes.
