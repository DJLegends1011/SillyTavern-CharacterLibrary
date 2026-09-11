# Saucepan account sync

Branch: `codex/saucepan-account-sync`, based on `codex/saucepan-hidden-extraction` at `8da54fb`.

## Account behavior

- Browse / Following uses Chub's separate Browse and Timeline sections and mode controls. Following includes the shared `BrowseView` creator manager, with search, sorting, follow by handle or profile URL, unfollow, and creator browsing.
- My Favorites appears under Features. In Browse it requests the server's favorites search; in Following or creator browsing it filters returned cards by their favorite state.
- The preview's inline heart and the creator browsing banner's follow control update the Saucepan account. They are separate from local library favorites.
- Requests use the existing saved Saucepan token and direct helper fetch. No Janitor account, managed browser, browser endpoint, or tunnel is required for account sync.
- Account changes invalidate cached results. Pending requests cannot repopulate the previous account's manager or preview. Account writes are not automatically replayed after uncertain outcomes.

Install the complete `extras/cl-helper` folder, version 1.10.1, including `saucepan-request.js`, and restart SillyTavern. Log in under Settings → Online → Saucepan.

Eligible hidden cards mirror JanitorAI's compact notice and Extract now button. Import extracts first, shares any in-flight preview extraction, and reuses the recovered card. The preview header contains Open and Import; it has no follow control.

## API contracts

Checked against Saucepan's public application bundle `https://saucepan.ai/assets/index-DVcW98uV.js` on September 10, 2026:

- POST `/api/v1/search`, with `special_view: { view: "favorites" | "following" }`.
- GET `/api/v1/users/followed`, returning `users`.
- GET `/api/v1/user-page?handle=...&force_generic=true`, returning a `user` with an `id` and `handle`.
- POST/DELETE `/api/v1/companions/favorite`, with `companion_id`.
- POST/DELETE `/api/v1/users/follow`, with `user_id`.

## Browser / extraction experiment

The requested companion `5b120a10-d0cd-4960-b5af-5354da7c5f9b` was viewed signed in: **Ava | Lonesome Half-demon**, by **Kokitadain**, with Mostly Closed visibility and Custom providers allowed. It has not been exported or imported by this task.

The live custom-provider Test Connection form was exercised with a dummy API key/model and the public Example Domain endpoint. It displayed HTTP 405 Method Not Allowed with the Example Domain HTML response. No provider was saved, no chat was created, and no companion definition was used in this test. Cancelling the form returned to No Providers Configured.

A loopback probe was started to compare local reachability. Its log recorded the browser's GET `/probe`, but Codex reported navigation blocked with `ERR_BLOCKED_BY_CLIENT`; no provider connection or generation was tested against it. The probe has stopped. The browser tool available in this session has console logs but no raw network recorder. The comparison and generation capture therefore remain incomplete.

The public frontend posts `/api/v2/chat/generate`, receives generation/stream identifiers, and polls a generation endpoint. This suggests server-side generation, but neither that source inspection nor Test Connection proves that a browser-only extraction path is impossible. The current extractor retains its cloudflared callback; removing it remains unresolved pending an actual generation network trace and an end-to-end capture test with the supplied browser.

The existing extractor also handles the wrapped detail response `{ companion: ... }` before checking creator custom-provider permission.

## Verification

Run `npm test` inside `extras/cl-helper`. Tests cover direct request restrictions and HTTP failures, account contracts, creator lookup, stale requests, shared manager integration, pagination, and extraction cleanup. Run JavaScript syntax and Git whitespace checks as well.

Live account mutations and a full export still need verification in the running SillyTavern installation. Automated tests use synthetic data and contain no account credentials.
