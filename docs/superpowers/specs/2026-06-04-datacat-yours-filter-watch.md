# DataCat Yours Filter Watch Note

Date: 2026-06-04

Context: after adding DataCat account sync, save/Yours sync, account-backed extraction, and the `Only DataCat Yours` feature filter.

Possible symptom to confirm later:
- A card may appear in Character Library's `Only DataCat Yours` results even when it does not appear on DataCat's `characters/mine?blockedTagIds=4` page.
- The user also wondered whether `Hide Owned Characters` or `Hide Possible Matches` felt inverted, but there was no confirmed reproduction.

Known state:
- `Hide Owned Characters` and `Hide Possible Matches` were not intentionally changed by DataCat account sync.
- `Only DataCat Yours` is a separate filter in the same `Features` menu.
- The direct Yours loader fetches DataCat's `/api/characters` route with the account session and marks returned rows as collected so they pass the CL Yours filter and render saved state.
- DataCat's site URL commonly includes `blockedTagIds=4`; if CL omits that blocked tag when fetching Yours, the API may return rows the website view hides.

Future debugging checklist:
1. Compare the CL proxy request for `Only DataCat Yours` against DataCat's own `characters/mine?blockedTagIds=4` network request.
2. Confirm whether `blockedTagIds=4` should be included by default in CL's direct Yours route.
3. Inspect returned row flags before blaming `Hide Owned Characters` or `Hide Possible Matches`.
4. If reproduced, add a test around the DataCat Yours route builder before changing filter behavior.
