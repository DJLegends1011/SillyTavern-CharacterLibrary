# JannyAI account sync (cloud bookmarks)

**Date:** 2026-06-23
**Branch:** `codex/janny-account-sync` (to be created off `codex/datacat-account-sync`)
**Status:** Approved design — endpoints confirmed via HAR captures 2026-06-23

## Goal

Give the JannyAI provider an account-backed bookmark layer:

- Sign in with a Supabase session token pasted from the user's browser.
- Per-action mirror: when the user bookmarks / unbookmarks a JannyAI card in CL,
  the change is mirrored to `jannyai.com/api/bookmark` on the user's account.
- A **bookmark badge** on JannyAI cards in the browse grid (filled vs. outline),
  driven by a cached set of the user's cloud bookmarks.
- A **"Show only my bookmarks"** filter in the JannyAI browse view, gated on
  being signed in.

Out of scope: first-connect bulk sync (user handles manual migration), "Yours"
ownership star, follow sync (JannyAI has no native follow — local-only behavior
stays).

## Reference implementation

DataCat's Yours pattern is the closest analog:

- `modules/providers/datacat/datacat-browse.js`: `datacatFilterOnlyYours` flag,
  `datacatYoursStateById` Map cache, `isDatacatYoursSyncEnabled()` gate on
  `getSetting('datacatAccountToken')`, optimistic toggle with revert-on-failure.
- `modules/providers/datacat/datacat-api.js`: `fetchDatacatYoursStatus`,
  `setDatacatYoursSaved`.

JannyAI's shape is simpler: bookmarks are a flat list of character UUIDs with no
nested collections, and the cloud read is one batched call.

## Confirmed endpoints (from HAR captures 2026-06-23)

All on `https://jannyai.com`, authenticated by the Supabase session cookie
(`sb-access-token=<JWT>`).

| Action | Method + path | Notes |
|---|---|---|
| List my bookmarks | `GET /api/bookmark` | → `{"bookmarks":[{"characterId","createdAt"}, …]}` |
| Add bookmark(s) | `POST /api/bookmark` body `{"characterIDs":["uuid", …]}` | batched; returns full updated list |
| Remove bookmark(s) | `DELETE /api/bookmark?ids=uuid1,uuid2` | batched via comma-separated query |
| Bump public counter | `POST /_actions/incrementCount` body `{"characterID","count":"bookmark"}` | fire-and-forget; matches site behavior on add |

### Auth token

- Supabase JWT, header `Cookie: sb-access-token=<JWT>` (or equivalently
  `Authorization: Bearer <JWT>` — both accepted by Supabase-protected routes).
- JannyAI configured **7-day lifetime** (decoded from `exp` claim): paste-once-
  per-week is acceptable for v1.
- Refresh token field deferred: if v1 UX of repasting weekly proves rough, add
  optional `JannyAI Refresh Token` setting that calls
  `https://eenzcbluoctduymzksoq.supabase.co/auth/v1/token?grant_type=refresh_token`.

## Settings UI

One new field in the JannyAI section of Settings:

```
JannyAI Session Token  [_______________]  [How to find this]
```

The "How to find this" link opens a help panel describing:
1. Sign in to jannyai.com in your browser.
2. Open DevTools → Application → Cookies → `jannyai.com`.
3. Copy the value of `sb-access-token`.
4. Paste here. Lasts 7 days; repeat when bookmarks stop syncing.

When the field is populated, a connection check fires a `GET /api/bookmark` —
on 200, status badge reads "Signed in (N bookmarks)". On 401, "Token expired —
repaste."

## New module: `modules/providers/janny/janny-account.js`

Owns everything account-related. Roughly 100–150 lines.

```js
// State
let _cachedBookmarkSet = new Set();   // populated by refreshBookmarkCache()
let _lastFetchAt = 0;

// Gates
export function isJannyAccountEnabled();   // token present
export function getJannyBookmarkSet();     // returns the cached Set

// Network
export async function fetchJannyBookmarks();      // GET /api/bookmark, returns array
export async function addJannyBookmarks(ids);     // POST /api/bookmark
export async function removeJannyBookmarks(ids);  // DELETE /api/bookmark?ids=…
export async function bumpJannyBookmarkCounter(id); // POST /_actions/incrementCount (fire-and-forget)

// Cache lifecycle
export async function refreshBookmarkCache();     // on settings save, on token validation, on focus
```

Auth header helper:
```js
function jannyAuthHeaders() {
    const token = getSetting('jannyAccountToken');
    return token ? { 'Cookie': `sb-access-token=${token}` } : {};
}
```

Networking goes through `fetchWithProxy` (already used by JannyAI search).

## Browse-view changes (`janny-browse.js`)

### 1. Bookmark badge on cards

A bookmark icon overlay on every card, mirroring the site:

- Filled `fa-solid fa-bookmark` if `getJannyBookmarkSet().has(hit.id)`.
- Outline `fa-regular fa-bookmark` otherwise (or hidden if not signed in — TBD,
  but I'll keep it always shown so the affordance is consistent).
- Click → optimistic toggle: flip the icon, call `addJannyBookmarks([id])` or
  `removeJannyBookmarks([id])`; on success, also fire
  `bumpJannyBookmarkCounter(id)` (add path only); on failure, revert + toast.

This icon is **independent of CL's own extended-bookmarks flow** — it tracks
the cloud bookmark state on jannyai.com, not CL's local bookmark store. (If we
later want them linked, that's an orchestrator-level change; out of scope here.)

### 2. "Show only my bookmarks" filter

A new toggle button next to existing filters. State:

```js
let jannyFilterOnlyBookmarked = false;
```

When on, push an extra MeiliSearch filter into the existing `filters` array:

```js
const ids = [...getJannyBookmarkSet()];
filters.push(`id IN [${ids.map(id => `"${id}"`).join(',')}]`);
```

122 IDs (typical) fits comfortably in a MeiliSearch filter. The toggle is hidden
when not signed in.

The filter chip also disables sort options that don't make sense when filtering
to bookmarks (none — all sorts still valid; just observed for consistency).

## Provider changes (`janny-provider.js`)

- `get hasAuth() { return true; }` (was false)
- `getAuthHeaders()` returns Supabase JWT cookie when set
- `getCurrentUserId()` — new: parses `sub` claim from JWT; used by the
  bookmark badge to know whose bookmarks to show (no cross-account leakage if
  user changes tokens)

## Files touched

- **New**: `modules/providers/janny/janny-account.js`
- **Touch**: `modules/providers/janny/janny-provider.js` — flip `hasAuth`,
  add `getAuthHeaders`, `getCurrentUserId`
- **Touch**: `modules/providers/janny/janny-browse.js` — bookmark badge, filter
  toggle, optimistic toggle handler
- **Touch**: Settings UI — one token field with help link
- **Touch**: `extras/cl-helper/janny-utils.js` (if it exists; create if not) —
  only if proxy routing needs Janny-specific helpers; first pass uses the
  generic proxy

## Error handling

- 401 from any endpoint → mark token invalid, surface a non-modal toast
  "JannyAI session expired — repaste in Settings."
- Network failure on toggle → optimistic UI reverts, toast "Couldn't update
  bookmark on JannyAI."
- `incrementCount` failure → silent (it's cosmetic stats).

## Testing

- Unit-ish: `janny-account.test.js` covering `fetchJannyBookmarks` parsing,
  `addJannyBookmarks` body shape, `removeJannyBookmarks` query encoding (matches
  the test-harness window shim pattern).
- Manual smoke (mobile path per project memory): sign in via paste, verify badge
  reflects server state on a card known to be bookmarked, toggle once, reload
  page, badge persists.

## Open question carried forward

If we later want the "Yours" star on JannyAI: needs the user's creator UUID. The
JWT's `sub` claim gives the Supabase user id, but we'd also need a mapping from
Supabase user id → JannyAI creator UUID. Likely via the JannyAI home page's
hydrated user data or a `/api/me` route we haven't captured. Defer.
