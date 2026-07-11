# DataCat follow sync (account-backed Following)

**Date:** 2026-06-17
**Branch:** `codex/datacat-account-sync`
**Status:** Approved design — all endpoints confirmed

## Goal

Make CL's DataCat **Following** mirror the account's follows on datacat.run, in
both directions, on any device. Following a creator in CL follows them on the
DataCat site (and vice-versa); the Following timeline is built from the
account's server-side follow list rather than a device-local array.

This replaces today's **local-only** `datacatFollowedCreators` list (stored in
extension settings, per-device) with account state as the source of truth when
signed in. Logged out, the existing local behavior is unchanged.

Approach: **A — two-way sync** (the follow button behaves like the Yours/favorite
button). Deliberately no merge logic beyond a one-time migration.

## Reference implementation

The DataCat **Yours** sync is the exact pattern to mirror:
- `extras/cl-helper/index.js`: `dc-yours/:id/status` (GET) and `dc-yours/:id`
  (POST/DELETE) routes, gated by `requireDcAccount`, headers via
  `buildDataCatHeaders`, proxying to `/api/characters/{id}/collect`.
- `modules/providers/datacat/datacat-api.js`: `fetchDatacatYoursStatus`,
  `setDatacatYoursSaved` (POST when saving, DELETE when removing).
- `modules/providers/datacat/datacat-browse.js`: `toggleDatacatYours` —
  optimistic UI update, revert + toast on failure; `isDatacatYoursSyncEnabled()`
  gates on `getSetting('datacatAccountToken')`.

## Confirmed DataCat endpoints (from HAR capture 2026-06-17)

- `POST /api/creators/{creatorId}/follow`
  → `{"success":true,"creatorId":"…","sourceKind":"janitor","isFollowing":true,"followedAt":"…"}`
- `DELETE /api/creators/{creatorId}/follow`
  → `{"success":true,"creatorId":"…","sourceKind":"janitor","isFollowing":false,"followedAt":null}`
- Per-creator state: `GET /api/creators/{creatorId}` already returns `isFollowed`
  (also `/api/creators/{creatorId}/retrieve-projection`).
- `creatorId` is a UUID; both `janitor` and `saucepan` follows carry a
  `sourceKind`.
- **Follow list:** `GET /api/creators/following?sourceKind=janitor&limit=&offset=&sortBy=&sortDir=`
  → `{ success, section, sourceKind, total, limit, offset, sortBy, sortDir,
  lastUpdatedAt, tags, list }`. Each `list` row:
  `{ creatorId, sourceKind, userName, avatar, followersCount, profileCreatedAt,
  profileUrl, extractedUpdateAt, charCount, totalChats, totalMessages,
  avgMessagesPerChat, topTags, followedAt, isFollowed }`.
  Defaults to `sourceKind=janitor`; query `saucepan` separately. Map
  `creatorId`→id, `userName`→name/handle, `sourceKind` janitor→`datacat`.

## Scope

### Add — backend proxy (`extras/cl-helper/index.js`)
Mirror the `dc-yours` routes, gated by `requireDcAccount` + `buildDataCatHeaders`:
- `GET /dc-following?sourceKind=&limit=&offset=` → proxies
  `GET /api/creators/following?...` → normalized `{ ok, total, list }`.
- `POST /dc-follow/:creatorId` → `POST /api/creators/{id}/follow`.
- `DELETE /dc-follow/:creatorId` → `DELETE /api/creators/{id}/follow`.

Validate `creatorId` as a UUID (an `isDataCatCreatorId` sibling to the existing
`isDataCatCharacterId`).

### Add — API layer (`modules/providers/datacat/datacat-api.js`)
- `fetchDatacatFollowing({ sourceKind, limit, offset })` → `dcHelperJson('/dc-following?…')`.
- `setDatacatFollow(creatorId, follow)` → POST/DELETE `/dc-follow/:id`
  (exact mirror of `setDatacatYoursSaved`).
- No new read-state call: `fetchDatacatCreator()` already exposes `isFollowed`.

### Change — browse layer (`modules/providers/datacat/datacat-browse.js`)
New gate `isDatacatFollowSyncEnabled()` = account token present (no Settings
toggle — gated purely on account presence, by decision). Three branches:

**a. Following timeline (`loadFollowingCharacters`)** — when enabled, source the
creator list from `fetchDatacatFollowing` (paged, for both `janitor` and
`saucepan` sourceKinds) instead of local `datacatFollowedCreators`. Map DataCat's
`{creatorId, userName/handle, sourceKind}` into the existing `{id, name, source}`
shape the per-creator fetch loop already consumes (`janitor` → `datacat`,
`saucepan` → `saucepan`). The downstream character-fetch loop is unchanged.
Disabled → current local behavior.

**b. Follow button (`followCreator` / `unfollowCreator` + click handler +
`updateFollowButton`)** — when enabled, writes go to DataCat via
`setDatacatFollow` with optimistic UI + revert-on-failure (copied from
`toggleDatacatYours`); button state derives from `isFollowed`. `browseCreator`
seeds the initial button state from `fetchDatacatCreator().isFollowed`.
Disabled → current local list behavior.

**c. One-time migration** — on first enabled timeline load, push any local-only
follows up to DataCat (`POST /dc-follow` per creator), set a `datacatFollowMigrated`
flag, then stop using the local list for display. Local entries are left intact
as a logged-out backup.

## Data flow
- **Display:** browse → `fetchDatacatFollowing` (both sources) → `/dc-following`
  → DataCat → creatorIds → existing character fetch → timeline.
- **Toggle:** button → `setDatacatFollow` → `/dc-follow/:id` (POST/DELETE) →
  DataCat; optimistic, revert on error.
- **Button initial state:** `browseCreator` → `fetchDatacatCreator().isFollowed`.

## Error handling
Mirror `toggleDatacatYours`: optimistic update, revert + toast on failure; 401 →
"sign in to DataCat" toast; timeline fetch failure keeps the existing retry UI;
per-creator fetch errors stay swallowed as today.

## Testing
- API path-builder tests alongside `tests/datacat-utils.test.mjs`.
- Browse-layer tests (window-shim harness) for: sourceKind→source mapping,
  following-list→timeline shape, migration, and enabled/disabled branching.
- Manual verify on **mobile and desktop**, then push (local repo has no attached
  ST frontend — tested from GitHub).

## Out of scope (YAGNI)
Real-time/websocket sync, a dedicated follow-management UI, and any merge logic
beyond the one-time migration.

## Open items (to confirm while implementing)
1. **Saucepan handle** — the follow-list row exposes `userName`; confirmed for
   janitor. The account currently has 0 saucepan follows, so verify against a
   real saucepan follow that `userName` is the handle `fetchSaucepanCompanionsOfUser`
   needs (fall back gracefully if a row lacks it).
