# JanitorAI Favorites Contract Evidence

Date observed: 2026-08-08
Environment: first-party JanitorAI web client, authenticated user session

| Operation | Relative path template | Method | Request keys/types | Response keys/types | Notes |
| --- | --- | --- | --- | --- | --- |
| List favorites | `/hampter/characters?page=<number>&favorites=true&mode=<all|sfw>&sort=<HAMPTER_SORT>` | GET | Query: `page: number`, `favorites: boolean`, `mode: string`, `sort: string` | `data: array`, `page: number`, `size: number`, `total: number`, `filtered_total: number`, `top_custom_tags: array` | Paginated |
| Read membership | `/hampter/favorites/myfavorites/<character-uuid>` | GET | empty | bare `boolean` | Per-character current-account membership source |
| Favorite | `/hampter/favorites/favorite` | POST | JSON: `characterId: string` | JSON `object` with no response keys | HTTP 201; original UI and membership state restored after the paired unfavorite |
| Unfavorite | `/hampter/favorites/unfavorite` | POST | JSON: `characterId: string` | JSON `object` with no response keys | HTTP 201; original UI and membership state restored |

JWT favorite-related paths: absent (`app_metadata` and `user_metadata` were present but contained no favorite or character-membership field)
`/auth/v1/user` favorite-related paths: absent (`app_metadata` and `user_metadata` were present but contained no favorite or character-membership field)
favoriteClaimPaths: `[]`
favoriteAccountPaths: `[]`
Count source: state — `GET /hampter/favorites/character/<character-uuid>/count` returns `characterId: string` and `favoritesCount: number`
Mutation response provides `{ favorited, count }`: no
Browser transport method widening required: no (the observed routes use existing GET and POST support)

## Local integration verification

- SillyTavern-hosted Character Library loaded the authenticated JanitorAI feed without helper or CSRF errors.
- Desktop preview read the authoritative membership state, toggled Favorite/Unfavorite, and restored the original state.
- My Favorites loaded the complete account source, removed a card only after confirmed unfavorite, and showed it again after the favorite was restored and the source refreshed.
- At 390×844, the inline heart stayed hidden and the pancake menu exposed Open, Import, and the current Favorite/Unfavorite action without horizontal overflow; menu rows measured 44px high.
- A stale refresh race discovered during integration is covered by a deterministic test: an older dead refresh cannot clear a newer successful login.
- No account identifiers, credentials, cookies, session values, or character UUIDs were recorded.
