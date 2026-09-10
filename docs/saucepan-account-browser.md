# Saucepan account/browser branch

Branch: `codex/saucepan-account-sync-browser`, based on `codex/saucepan-hidden-extraction` at `8da54fb`.

## Implemented

- Saucepan favorites and followed-creator companion searches using `special_view: { view: "favorites" | "following" }` on `/api/v1/search`.
- Followed creator catalogue from `GET /api/v1/users/followed` (`users` response).
- Explicit POST/DELETE favorite and follow actions with `companion_id` and `user_id`, respectively. Writes are never automatically replayed.
- Saucepan API transport through the CDP browser already configured for JanitorAI. Each request has a separate Saucepan page, bounded fetch, same-origin clearance cookies, and the explicit Saucepan token. The page and connection close after the request; other providers' pages are untouched.
- Account changes invalidate companion and browse caches. Pending requests cannot repopulate a previous account's results.
- Correct handling of the wrapped companion detail response during protected-definition extraction.

The API contract was checked against Saucepan's public application bundle `https://saucepan.ai/assets/index-DVcW98uV.js` on September 10, 2026. No account credentials are stored in this document or tests.

## Setup and limits

Update the installed `extras/cl-helper` folder as a whole (including `saucepan-browser.js`) to version 1.10.0 and restart SillyTavern. Configure the managed browser or endpoint under Settings → Online → JanitorAI, then sign in under Saucepan's settings. A Codex browser login is separate from Character Library's saved Saucepan token and CDP browser.

Protected definitions still use the existing opt-in cloudflared callback. Saucepan's generation API queues server work and returns generation/stream identifiers; the frontend does not receive the assembled custom-provider prompt. Routing that API call through CDP is insufficient to replace a server-reachable callback. No tunnel-free protected-card export is claimed by this branch.

The requested companion, `5b120a10-d0cd-4960-b5af-5354da7c5f9b`, was verified through the signed-in site UI as **Ava | Lonesome Half-demon** by **Kokitadain**, with **Mostly Closed** definition visibility and **Custom providers** allowed. It has not been exported or imported by this task.

## Verification

Run `npm test` inside `extras/cl-helper`. Tests cover browser origin/path restrictions, credentials, HTTP failures, favorites/follows contracts, pagination, stale account requests, UI controls and protected extraction cleanup. JavaScript syntax and Git whitespace checks are also required.

Live follow/favorite mutations and an end-to-end export still need verification in the running SillyTavern installation. Browser requests currently create a short-lived page per request, so browsing may be slower than a persistent browser tab.
