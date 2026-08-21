# DataCat Folder Cache Race Design

## Problem

The DataCat save picker can render only its built-in Main row even when the
account has custom folders. A background preload and an interactive picker
load can run independently while the DataCat account session is being restored.
Any successful empty response is retained for the module lifetime, so the
picker has no reason to fetch the folders again.

## Design

Replace the loose cache variable with a small folder loader that owns both the
last non-empty folder list and the current request promise. Preload and picker
loads use the same promise, preventing duplicate and out-of-order requests.
Empty successful results are returned to the current caller but are not kept as
session-long cache state, allowing a later open to recover. Failed requests are
also never cached.

Account restoration remains best-effort, but startup awaits that already-started
work before preloading folders. Login, restored-login, and logout invalidate the
folder cache so one account cannot reuse another account's folders.

## Error Handling

The loader preserves the existing folder API error text and clears its in-flight
promise in a `finally` block. Picker rendering continues to show the existing
retry UI on failures. A genuinely folderless account still sees Main; it simply
rechecks on the next picker open instead of caching that empty state forever.

## Testing

Unit tests cover concurrent request deduplication, empty-result retry behavior,
invalidation, and recovery after a rejected request. Existing DataCat picker,
account-retry, and utility suites remain the focused regression suite.
