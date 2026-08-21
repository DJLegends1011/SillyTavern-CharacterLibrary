# DataCat folder sync (account-backed folders)

**Date:** 2026-06-27
**Branch:** `codex/datacat-account-sync`
**Status:** Approved design - live site endpoints probed 2026-06-27

## Goal

Add the server/API foundation for DataCat account folders so Character Library
can manage account-backed DataCat folders beyond the current default **Main**
save path.

This pass is deliberately server-first, like the JannyAI bookmark proxy: expose
safe `cl-helper` routes and frontend API wrappers, then leave the richer folder
picker/manage UI for a later pass.

## Confirmed DataCat behavior

The live DataCat bundle uses these routes:

- `POST /api/characters/{characterId}/collect` saves to the default **Main**
  collection.
- `DELETE /api/characters/{characterId}/collect` removes the character from
  Yours entirely.
- `GET /api/characters/{characterId}/folders` returns `collected` plus custom
  `folderIds`. **Main** is represented by `collected: true` and no custom folder
  id.
- `GET /api/user-folders` lists custom folders and counts.
- `POST /api/user-folders` creates a folder with `{ title, description? }`.
- `PATCH /api/user-folders/{folderId}` updates `{ title, description }`.
- `DELETE /api/user-folders/{folderId}` deletes a folder.
- `PUT /api/user-folders/{folderId}/items/{characterId}` adds a character to a
  custom folder.
- `DELETE /api/user-folders/{folderId}/items/{characterId}` removes a character
  from a custom folder.
- `GET /api/characters?folderId={id}` lists a custom folder.
- `GET /api/characters?mainOnly=1` lists the default Main collection.

Unauthenticated folder endpoints return `X-Session-Token header is required`,
so all CL routes must be account-gated.

## Architecture

`extras/cl-helper` remains the account-token holder and server-side proxy. New
folder routes are account-scoped siblings of `dc-yours` and `dc-follow`:

- `GET /dc-folders`
- `POST /dc-folders`
- `PATCH /dc-folders/:folderId`
- `DELETE /dc-folders/:folderId`
- `PUT /dc-folders/:folderId/items/:characterId`
- `DELETE /dc-folders/:folderId/items/:characterId`
- `GET /dc-folder-characters`

`modules/providers/datacat/datacat-api.js` owns path builders and exported API
helpers. Account routes use the existing `dcAccountJson()` lazy restore path, so
folder calls recover from an ST/cl-helper restart when the saved account token is
still in settings.

## Main vs custom folders

CL's existing star/Yours behavior stays unchanged and continues to mean
**save to Main** through `setDatacatYoursSaved()`.

Custom-folder membership is additive and separate:

- Saving to a custom folder calls `PUT /dc-folders/:folderId/items/:characterId`.
- Removing from a custom folder calls `DELETE /dc-folders/:folderId/items/:characterId`.
- Switching a character back to Main-only is a future UI action that can combine
  `setDatacatYoursSaved(characterId, true)` with removing custom folder IDs.

This keeps the current UX stable while enabling later folder controls.

## Validation

- Folder IDs are positive integers.
- Character IDs reuse the existing DataCat character ID validation.
- Folder titles are non-empty strings, trimmed, and capped at 120 characters.
- Folder descriptions are optional, trimmed, and capped at 500 characters.
- List query parameters are allow-listed: `minTotalTokens`, `activeTagIds`,
  `blockedTagIds`, `limit`, `offset`, `tagIds`, `search`, `sort`, `folderId`,
  and `mainOnly`.

## Testing

Automated:

- Unit tests for folder path builders, ID normalization, and folder payload
  normalization.
- Account-wrapper tests verifying lazy session recovery for folder routes.
- Syntax checks for edited JavaScript files.

Manual:

- With a DataCat account token saved, list folders through CL.
- Create a custom folder, add a DataCat character to it, and confirm the folder
  appears on datacat.run.
- Remove the character from that folder and confirm membership changes.
- Confirm existing Main/Yours star behavior still saves to Main.

## Out of scope

- Full DataCat folder picker/manage UI inside CL.
- Bulk migration between Main and folders.
- Vault and Cart flows.
- Real-time synchronization.
