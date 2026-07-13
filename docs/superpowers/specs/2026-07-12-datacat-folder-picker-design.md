# DataCat folder picker (folder sync phase 2)

**Date:** 2026-07-12
**Branch:** `codex/datacat-account-sync`
**Status:** Approved design
**Predecessor:** `2026-06-27-datacat-folder-sync-design.md` (server/API foundation — landed)

## Goal

Give Character Library a real favoriting surface for DataCat account folders:
a "Save to folder" picker that mirrors datacat.run's own folder dropdown, built
on the dc-folders routes and API wrappers that phase 1 already shipped.

Phase 1 deliberately stopped at the server: cl-helper routes, `datacat-api.js`
wrappers, and tests exist; the only UI today is the star, which saves to the
default **Main** collection. This phase adds the picker UI. It is frontend-only
— no new cl-helper routes are required.

## Confirmed live behavior (datacat.run, verified 2026-07-12)

Inspected the production picker while logged in:

- The character viewer has a heart (quick-save to Main) and a separate
  **"Save to folder"** button.
- "Save to folder" opens a dropdown: **Main** first, then the account's custom
  folders, then an inline **"New folder name" + Save** row.
- Opening the picker fires `GET /api/user-folders` and
  `GET /api/characters/{id}/folders` (the latter returns `collected` plus
  custom `folderIds`). A 401 on the first call is retried with the session
  token and succeeds — matching phase 1's lazy-restore design.
- Folder assignment requires the character to already be collected to
  Main/Yours: the server rejects `PUT` folder-membership with
  `{ ok: false, status: 400, reason: "Character is not in your library" }`
  otherwise (verified live 2026-07-12). Custom folders on datacat.run are
  subsets of Yours, so its own picker has this precondition implicitly. Our
  picker now auto-saves to Main first (via the same path as the star) when
  toggling a custom folder on for a character that isn't collected yet.

## Existing building blocks (all on this branch — do not rebuild)

cl-helper routes:

- `GET /dc-folders` — list folders
- `POST /dc-folders` — create folder
- `PUT /dc-folders/:folderId/items/:characterId` — add membership
- `DELETE /dc-folders/:folderId/items/:characterId` — remove membership
- `GET /dc-yours/:characterId/status` — `{ collected, folderIds }`

`datacat-api.js` wrappers: `fetchDatacatFolders()`, `createDatacatFolder()`,
`setDatacatFolderMembership()`, `fetchDatacatYoursStatus()` for
`{ collected, folderIds }`, plus `setDatacatYoursSaved()` for Main.
All account calls ride `dcAccountJson()` lazy session restore.

## Scope decisions (user-approved)

- **Entry point:** the star is untouched (one tap = save/unsave Main). A new
  folder-icon "Save to folder" button is added to the card viewer's action row
  on desktop and to the mobile card drawer. Grid cards do NOT get the button.
- **Management scope:** membership toggling + inline folder create only.
  Rename/delete stays on datacat.run.
- **Account-gated:** the button renders only when a DataCat account session is
  active, like other account-gated UI on this branch.

## Interaction model

Borrowed from the JannyAI collections UX design
(`codex/jannyai-account-sync:docs/superpowers/specs/2026-07-09-jannyai-collections-ux-design.md`),
adapted to DataCat folders. Built independently in this branch's files — no
code dependency on the JannyAI branch (AIO merges remain a union).

Dropdown contents, top to bottom:

1. **Main** — checkmark bound to `collected`. Toggling calls
   `setDatacatYoursSaved()`; the star's state updates live since both surfaces
   share the same source of truth.
2. **Custom folders** — name + checkmark per folder. Tapping toggles
   membership immediately via `setDatacatFolderMembership()`. Only the tapped
   row shows a busy state. The dropdown stays open so several folders can be
   changed in one visit.
3. **Inline create** — "New folder name" text field + Save button. Creates via
   `createDatacatFolder({ title })` (title only, like the site), then
   immediately adds the current character to the new folder and renders it
   checked. Input is trimmed; empty input disables Save; title cap 120 chars
   (phase 1 validation).

Feedback:

- Toasts: `Added <character> to <folder>.` / `Removed <character> from
  <folder>.` / `Created <folder>.`
- Long folder names truncate with ellipsis.

## Data flow

- On first open per character: `fetchDatacatFolders()` (folder list cached for
  the session; invalidated after a create) and `dc-yours/{id}/status` for
  `{ collected, folderIds }` (fetched fresh each open — membership is cheap
  and can change on other devices).
- Toggles are optimistic: flip the checkmark, call the API, revert + toast on
  failure. This matches the star's existing behavior.
- State lives in `datacat-browse.js` module scope alongside the existing
  account-sync state; no new global stores.

## Error handling

- **Logged out / cl-helper down:** button absent (account-gated render).
- **Mid-session 401:** inline row in the dropdown — "Session expired — check
  Settings → Online → DataCat" — after the existing lazy-restore retry fails.
- **Folder list load failure:** inline error row with a Retry action; the
  trigger button stays usable.
- **Create failure** (duplicate name, 4xx): toast with DataCat's error text;
  the typed input is preserved.
- **Membership toggle failure:** optimistic checkmark reverts; toast explains.

## Mobile

Mobile is the primary platform for this user. Requirements:

- The button joins the mobile card drawer's action row.
- The picker renders as a bottom-anchored sheet within the drawer viewport:
  minimum ~44px touch targets, internal scrolling for long folder lists, no
  native `<select>`.
- Must be verified on the mobile path (`library-mobile.*` + card-viewer
  drawer), not just desktop.
- Note `browse-shared.css` cascade: it loads after `library.css`, so any
  toggled-hidden picker elements need explicit `.X.hidden` re-hide rules.

## Testing

Automated (branch's existing `node --test` suite, with the browser-globals
shim preloaded via `--import`):

- Picker state logic: membership map building from `{ collected, folderIds }`,
  optimistic toggle + revert, cache invalidation after create.
- Folder-create payload normalization (trim, title cap) — extends the phase 1
  wrapper tests.
- Syntax checks for edited JS files.

Manual (live, with the user's account, driven in the ST tab):

1. Open a DataCat character → picker lists Main + the account's real folders
   with correct checkmarks.
2. Toggle a custom folder on → confirm membership on datacat.run.
3. Toggle it off → confirm removal.
4. Toggle Main from the picker → star updates in place, and vice versa.
5. Create a folder from the picker → appears on datacat.run with the
   character inside.
6. Repeat the core flow in the mobile viewport (drawer + sheet).

## Non-goals

- Folder rename/delete from CL (stays on datacat.run).
- Bulk migration between Main and folders.
- A folders browse tab / filtering the browse grid by folder.
- Vault and Cart flows.
- Grid-card folder buttons.
- Any hampter/MeiliSearch work (the "accurate latest" PR was scrapped;
  findings live in the session notes: hampter's Cloudflare gate is
  pass-by-cookie, and the Meili mirror's Newest lags janitor.ai by hours).
