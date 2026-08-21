# JannyAI account sync

## Context

Janny account endpoints are behind Cloudflare. In a logged-in browser, Janny's same-origin UI can read and mutate bookmarks. Raw cl-helper/curl-style requests to `/bookmark`, `/api/bookmark`, and `/api/collections/mine` return Cloudflare challenge responses. Browser JavaScript cannot read the likely HttpOnly session cookies, so Character Library needs an explicit server-side account session and clear diagnostics.

## Phase A: bookmarks

1. Add tested helper utilities for Janny account transport:
   - cookie-header parsing/sanitization
   - narrow method/path allowlist
   - Cloudflare challenge detection
   - bookmark page parsing fallback
   - safe FlareSolverr request shaping
2. Add cl-helper Janny routes:
   - set/clear/session/validate account cookies
   - proxied account fetches for only Janny bookmark and collection endpoints
   - optional FlareSolverr warmup/cookie harvest for Cloudflare clearance
3. Add client API helpers in `janny-api.js`:
   - validate session
   - get bookmarks
   - add/remove bookmark
   - fetch characters by IDs
4. Add Janny browse UI controls:
   - account button/status
   - bookmark status in character modal
   - bookmark/unbookmark action with a guard for maxed bookmark pages

## Phase B: collections

1. Add account helpers for:
   - list my collections
   - list characters in a collection
   - add/remove character in collection
   - create collection when the endpoint is available, otherwise return a precise unsupported/diagnostic error
2. Add Janny browse view mode for collections:
   - list user's collections
   - open a collection and render its cards
   - import cards from collection entries
   - add the current bookmarked character to a selected collection

## Verification

1. Run pure node tests for helper utilities.
2. Run syntax checks for modified JS.
3. Check git status and report whether changes are uncommitted, committed, or pushed.
