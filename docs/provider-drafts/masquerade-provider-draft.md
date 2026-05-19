# Masquerade Provider Draft

Recon date: 2026-05-19

Target: https://www.masqueradeproductions.org

## Goal

Add a MasqueradeAI online provider that can browse, search, preview, import, link, and update public characters without building a new provider from scratch.

Start with public browse/import. Treat saved characters and followed creators as a phase-two account-sync feature after the public provider path is stable.

## Recon Summary

MasqueradeAI is a React single-page app backed by Supabase plus a small backend API.

Useful public surfaces:

- Website: `https://www.masqueradeproductions.org`
- Lightweight catalog API: `https://api.masqueradeproductions.org/api/characters`
- Supabase REST: `https://mqdpdmiujadxdhxxqcqk.supabase.co/rest/v1`
- Supabase RPC: `search_characters_fuzzy`

The site frontend exposes the Supabase project URL and anon key in the public bundle. Do not paste the key into docs, but the provider implementation will need the same public anon key as a constant unless a better discovery path is added.

Public data access works without login:

- `GET /api/characters` returns public catalog rows with images, tags, stats, and display metadata.
- Supabase `characters` table can return full public character rows, including `description`, `greeting`, `scenario`, `alternate_greetings`, `background_url`, and `circle_avatar_url`.
- `POST /rest/v1/rpc/search_characters_fuzzy` returns rich search rows.
- Public browse routes returned normal CORS headers in testing.

Auth-related signals:

- Supabase auth uses storage key `facemasque-auth`.
- Login/signup call `signInWithPassword` and `signUp`.
- Cloudflare Turnstile appears in auth and password reset flows.
- Saved characters use the `subscriptions` table.
- Followed creators use the `user_follows` table.

## Closest Existing Provider

Copy `modules/providers/wyvern/` first.

Why:

- Wyvern is a browser-side API provider.
- It already has a separate API module, browse module, provider class, V2 card builder, auth-token settings, image import, and no required `cl-helper`.
- Masquerade also needs to synthesize V2 cards from JSON records and import remote images.

Borrow ideas from `modules/providers/chub/` only for phase-two account sync:

- saved/following UI patterns
- followed creators manager behavior
- richer provider metadata and stats display

Do not start from `janny` or `datacat` unless the public API path breaks. Masquerade does not currently look like an HTML scraping or server-plugin-first provider.

## Server Plugin Decision

Phase one should be browser-only.

Do not add `cl-helper` at first because:

- Public catalog and full character rows are reachable without login.
- Supabase REST/RPC responds with usable CORS headers.
- The backend catalog endpoint has `Access-Control-Allow-Origin: *`.
- No Cloudflare challenge page appeared on public data routes.

Add optional `cl-helper` support only if one of these becomes true:

- SillyTavern browser fetches fail despite the direct CORS probe.
- Login/session refresh cannot run safely in the extension context.
- Account-sync endpoints require forbidden headers, cookies, or a server-held session.
- Cloudflare/Turnstile blocks the specific account feature users need.

FlareSolverr does not belong in the first draft. There is no evidence that public browse/import needs it.

## Provider Shape

Create:

- `modules/providers/masquerade/masquerade-api.js`
- `modules/providers/masquerade/masquerade-provider.js`
- `modules/providers/masquerade/masquerade-browse.js`
- `modules/providers/masquerade/masquerade-browse.css`

Register it in:

- `modules/module-loader.js`
- `modules/providers/provider-registry.js` through the normal module-loader import path
- README provider matrix after the provider is real

Suggested provider identity:

- `id`: `masquerade`
- `name`: `MasqueradeAI`
- `siteBase`: `https://www.masqueradeproductions.org`
- `apiBase`: `https://api.masqueradeproductions.org`
- `supabaseRestBase`: `https://mqdpdmiujadxdhxxqcqk.supabase.co/rest/v1`

## Data Flow

Browse:

1. Query Supabase `characters` directly with `is_public=eq.true`, `is_unlisted=neq.true`, and a stable limit/range.
2. Default sort can be `total_messages.desc`, with options for newest, quality, subscribers, and possibly NSFW-inclusive popular.
3. Use the backend `/api/characters` endpoint as a fallback or lightweight browse source only.

Search:

1. Call `search_characters_fuzzy` with `{ search_term }`.
2. Filter out `is_unlisted` and private rows.
3. Apply local NSFW filtering based on provider settings.
4. If RPC fails, fall back to PostgREST `or(name.ilike,tagline.ilike,origin_tag.ilike)`.

Detail:

1. Fetch by UUID from Supabase `characters`.
2. Request the full field set needed for import and update checks.
3. Cache a few detail rows with a short TTL, following the Wyvern/Chub cache style.

Import:

1. Build a V2 card from the full row.
2. Download `image_url` as the avatar.
3. Use `assignGalleryId()` and `importFromPng()`.
4. Store provider metadata under `data.extensions.masquerade`.

Update check:

1. Read `data.extensions.masquerade.id`.
2. Fetch the full current row by UUID.
3. Rebuild the V2 card.
4. Compare the same normalized fields used at import.

## V2 Card Mapping

Recommended first mapping:

- `data.name`: `row.name`
- `data.description`: `row.description || row.scenario || ''`
- `data.personality`: `row.personality || row.tagline || ''`
- `data.scenario`: `row.scenario` only when it differs from `row.description`
- `data.first_mes`: `row.greeting || ''`
- `data.alternate_greetings`: `row.alternate_greetings || []`
- `data.tags`: combine `origin_tag`, `identity_tags`, `personality_tags`, plus `masquerade` and `nsfw` when applicable
- `data.creator_notes`: short provider note with source URL, tagline, and stats

Provider metadata:

```js
data.extensions.masquerade = {
  id,
  user_id,
  pageName: name,
  tagline,
  image_url,
  background_url,
  circle_avatar_url,
  is_nsfw,
  is_unlisted,
  subscriber_count,
  total_messages,
  unique_chatters,
  quality_score,
  created_at,
  linkedAt
}
```

Image/gallery handling:

- Avatar: `image_url`
- Optional gallery images: `background_url` and `circle_avatar_url` when distinct from the avatar
- Theme links should stay in extension metadata, not gallery images

## URL Handling

Support at least:

- `https://www.masqueradeproductions.org/character/{uuid}`
- `https://www.masqueradeproductions.org/chat/{uuid}`

Return:

- canonical provider URL: `https://www.masqueradeproductions.org/character/{id}`
- fullPath can be the UUID for this provider

## Account Sync Draft

Leave this out of phase one unless the user explicitly wants auth first.

Possible phase-two features:

- Saved characters from `subscriptions`
- Followed creators from `user_follows`
- Creator profiles from `user_settings` or `public_profiles`

Preferred auth path:

1. Try browser-side Supabase email/password auth, like Wyvern's browser-side token model.
2. Store access and refresh tokens in provider settings.
3. Refresh sessions client-side through Supabase auth.
4. If Turnstile blocks login in the extension, add a manual token/session paste path before adding server routes.
5. Only add `cl-helper` if a real account-sync feature cannot work browser-side.

## Implementation Checklist

1. Copy `modules/providers/wyvern/` to `modules/providers/masquerade/`.
2. Rename IDs, class names, settings keys, logs, DOM IDs, CSS prefixes, and extension metadata keys.
3. Replace Wyvern API constants with Masquerade/Supabase constants.
4. Implement Supabase REST headers with anon key and optional user JWT.
5. Implement browse, search, detail, and import from `characters`.
6. Implement card mapping and extension metadata.
7. Implement URL parsing and batch import routing.
8. Add provider import and CSS load in `modules/module-loader.js`.
9. Add provider settings for NSFW inclusion and optional account token only if phase two begins.
10. Update README only once the provider is implemented.

## Smoke Tests

- Open Online tab and switch to MasqueradeAI.
- Browse public characters without `cl-helper`.
- Search a known name through `search_characters_fuzzy`.
- Toggle NSFW filtering and confirm results change.
- Open preview and confirm full description/greeting are present.
- Import a character and confirm the PNG card opens in SillyTavern.
- Confirm `data.extensions.masquerade` has the UUID and source URL data.
- Run update check against the imported character.
- Paste a `/character/{uuid}` URL into bulk import and confirm provider routing.
- Confirm missing auth does not break public browse.

## Risks And Open Questions

- Direct Supabase access depends on the public anon key exposed by the website bundle. That is normal for Supabase apps, but the provider should use it narrowly and respectfully.
- Search RPC may not support server-side pagination. The first implementation can cap search results locally.
- Backend `/api/characters` is useful but does not return full import fields, so detail/import should prefer Supabase.
- Auth may require Turnstile. Keep account-sync optional until public import works.
- Some fields are semantically fuzzy: `tagline`, `personality`, `description`, and `scenario` can overlap. The first card builder should avoid duplicating long text into multiple SillyTavern fields when the source values are identical.

## Recommendation

Build MasqueradeAI as a Wyvern-style browser-only provider first.

The first useful provider should support public browse, search, preview, import, linking, update checks, and optional extra gallery images. Account sync can follow after that, using Chub as the feature model but Supabase auth as the network model.
