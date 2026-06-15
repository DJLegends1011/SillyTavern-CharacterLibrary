# Provider Bookmarks Backup Note

Date: 2026-06-04

Local provider bookmarks are intended to become a backup/failsafe layer as providers gain real account sync.

Future direction:
- If a provider has account-backed saves/favorites, that provider save should be the primary user-facing bookmark.
- Local CL bookmarks should remain available as a backup/exportable mirror.
- When feasible, account-backed saves should sync into the local bookmark backup after refresh so users can export a safety copy.
- This is especially useful if a provider account disappears, loses access, or has remote favorites reset.

Current example:
- DataCat Yours is the account/site-backed collection.
- DataCat local bookmarks are still visible, but use the local-backup disk icon so they are not confused with DataCat Yours.
