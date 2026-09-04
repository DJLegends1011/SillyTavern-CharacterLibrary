# Update CL AIO Branch — SillyTavern-CharacterLibrary

Guide for updating feature branches and rebuilding the AIO (all-in-one) integration branch after a new upstream release.

## Critical Rule

**Step 1 must be 100% complete before Step 2 begins.**

Step 1 = update every feature branch individually (merge main + align code style).
Step 2 = rebuild the AIO branch by merging the updated feature branches in.

Do NOT skip ahead. Do NOT start AIO assembly while feature branches are still outdated. Every feature branch must be fully updated, style-aligned, and pushed before you touch AIO.

## Context

**Repo location:** `C:\Users\DJLegnds\Downloads\SillyTavern\extension\SillyTavern-CharacterLibrary`

Work happens in that checkout. Long-running `git worktree`s for the feature branches live under
`.worktrees/` inside it (e.g. `.worktrees/compact-datacat`, `.worktrees/compact-bookmarks`,
`.worktrees/compact-janny`) — a branch checked out in a worktree cannot be `git checkout`ed in the
main working copy, so run that branch's merges from its worktree directory instead.

This project (SillyTavern-CharacterLibrary) has two remotes:
- **origin**: `DJLegends1011/SillyTavern-CharacterLibrary` (fork)
- **upstream**: `Sillyanonymous/SillyTavern-CharacterLibrary` (source)

The `main` branch tracks upstream. Feature work lives on long-running branches. The **AIO branch** combines all active feature branches on top of the latest main for real-world testing on mobile via GitHub — the user does NOT test locally.

**Always push immediately after committing.** The user tests from GitHub on mobile, not locally.

## Feature branches (included in AIO)

| Branch | Feature |
|--------|---------|
| `codex/datacat-account-sync` | DataCat "Yours" account sync |
| `extended-bookmarks` | Provider bookmark backups |
| `codex/jannyai-account-sync` | JannyAI account sync + collections (cookie-based) |
| `codex/janitorai-ext-account-sync` | JanitorAI ext account sync (account favorites + Meili latest sort) |
| `codex/fix-chub-tag-exclusions` | Chub tag exclusions beyond the search tag limit |

> **Renamed 2026-09-03:** `codex/janitorai-favorites-meili-latest` is now
> `codex/janitorai-ext-account-sync` (same commit, `94dbf15`); the old ref was deleted from
> origin. Merge commits in `aio-v7.2.1` and earlier still carry the old name in their
> messages — that is expected, do not try to rewrite them.

### Branch state as of 2026-09-03

`main` is at **v7.2.2** (`5c99e79`). The newest AIO branch on origin is **`aio-v7.2.1`**, so the
next rebuild is `aio-v7.2.2` (delete `aio-v7.2.1` once it lands). **All five feature branches are
exactly 1 commit behind main** — none has v7.2.2 merged yet, so Step 1 applies to every one of them.

| Branch | Ahead | Behind | Size vs main |
|--------|-------|--------|--------------|
| `codex/datacat-account-sync` | 88 | 1 | 30 files, +7328 |
| `codex/jannyai-account-sync` | 88 | 1 | 51 files, +31385 |
| `extended-bookmarks` | 28 | 1 | 16 files, +1534 |
| `codex/janitorai-ext-account-sync` | 13 | 1 | 18 files, +3479 |
| `codex/fix-chub-tag-exclusions` | 1 | 1 | 3 files, +332 |

## Branches excluded from AIO

- `QOL` — quality-of-life tweaks (separate track)
- `codex/provider-guide-docs` — documentation only; carries this slash command (`.claude/commands/`)
- `codex/saucepan-hidden-extraction` — **not a feature branch.** This was decoding work done *for the upstream maintainer*, who needed to understand Saucepan's hidden extraction path. It was never meant to ship in AIO, which is why it appears in no AIO version. Do not merge it as-is and do not retire it.
  **Future direction:** this branch is the natural base for a dedicated **Saucepan ext account sync** branch, matching the account-sync pattern already used by DataCat / JannyAI / JanitorAI. If that work starts, cut it from here rather than from `main` — the extraction decoding is the groundwork. Until then it stays out of AIO.

## Retired branches (do NOT recreate or merge)

- `claude/sillytavern-astraprojecta-38nhzn` — native ST wand-menu entry. Abandoned and deleted (origin + local) on 2026-07-06; dropped from AIO. Its `/gallery` slash-command fix lives independently on `fix/gallery-slash-command`.
- `codex/janny-bookmark-sync` and `codex/janny-account-sync` — early Janny bookmark/account-sync attempts, superseded by `codex/jannyai-account-sync`. Deleted from origin (2026-07-11). `jannyai-cloudflare-debug` is a scratch debug branch, not part of AIO.
- `codex/masquerade-provider` — MasqueradeAI provider. Deprecated by the user on 2026-08-06 and dropped from AIO as of `aio-v7.0.0`. Do NOT merge it into AIO or update it on new releases. The branch itself is left in place (not deleted) at its v6.7.0 merge point in case it is ever revived.

---

## STEP 1: Update every feature branch (do ALL of these FIRST)

### 1a: Update main

```
git checkout main
git fetch upstream
git merge upstream/main
git push origin main
```

### 1b: Study the maintainer's current coding style

Before touching any feature branch, read through recent upstream changes on main. Pay attention to:
- Naming conventions (camelCase vs snake_case, variable/function naming patterns)
- Code structure (how modules are organized, import style, event patterns)
- DOM/jQuery patterns (how elements are created, how events are bound)
- CSS class naming and style patterns
- Comment style and documentation patterns

The feature branches must match whatever conventions the upstream maintainer currently uses. If the maintainer changed style between releases, the feature branches need to follow suit.

**Structural changes seen so far (check whether the new release does more of this):**
- **v7.0.0** moved every provider's initial grid load out of `init()` into `activate()` ("No initial load here: init() runs before applyDefaults()"). Any branch that hooked `init()` to decide *what* to load must move that hook to `activate()`, or the feature silently stops applying on entry.
- **v7.0.0** replaced hand-rolled error markup with `renderBrowseError(grid, {...})`, which owns its own retry button — so a branch's `.browse-retry-btn` grid-click handler becomes dead code and should be dropped (keep any bookmark guard in that same handler).
- **v7.0.0** namespaced DataCat's JanitorAI session keys (`janitoraiToken` → `datacatJanitoraiToken`, `window.getValidJanitoraiToken` → `window.datacatJanitoraiGetToken`) to make room for the real JanitorAI provider. The un-prefixed names still exist and belong to `modules/providers/janitor-session.js` — do not "fix" those back.
- **v7.0.0** extracted Saucepan out of DataCat into its own provider and moved `janitor-bridge.js` from `datacat/` up to `providers/`. Saucepan helpers deleted from `datacat-browse.js` must not be resurrected by a union merge.

**Do not let style alignment overwrite a branch's deliberate behavior.** If upstream re-adds something a branch intentionally removed, the branch's guarding test will fail — that test is the signal, not the noise. (Example: `codex/jannyai-account-sync` deliberately keeps `getSearchToken()` from scraping the Cloudflare-gated `/characters/search` page, and asserts it in `tests/janny-collections-ux-static.test.mjs`.)

### 1c: Update each feature branch individually

For **each** of the five feature branches, do all of the following:

1. **Merge main into the branch:**
   ```
   git checkout <branch>
   git merge main
   ```

2. **Resolve any merge conflicts** in the context of that branch's feature.

3. **Align code style with the maintainer's current conventions.** Review the branch's code against what you observed in 1b. Update any code that doesn't match — variable names, patterns, structure. The feature code should look like it was written by the same person who wrote main.

4. **Verify the merge (see "Verifying merges" below)** — syntax-check every changed `.js`, and run the tests to confirm no *new* failures vs the pre-merge baseline.

5. **Push immediately:**
   ```
   git push origin <branch>
   ```

6. **Move to the next branch. Do NOT start Step 2.**

Repeat for all five branches. Only after every feature branch is updated, style-aligned, verified, and pushed do you proceed.

### 1d: Verifying merges

Do this after every feature-branch merge AND after the final AIO assembly.

1. **No conflict markers left:** `git grep -n "^<<<<<<<\|^>>>>>>> " -- .` returns nothing.
2. **Every changed `.js` parses:** `node --check <file>` on each. (`.css` has no checker — verify `{`/`}` balance instead.)
3. **Run the tests** — the tests are standalone `.mjs` files (no root `package.json`, no `test` script):
   ```
   node --test tests/*.test.mjs
   ```

**CRITICAL caveat about the test baseline (learned 2026-07-11, v6.5.0).** Many provider tests are RED and stay red regardless of your work — they do a bare standalone `import()` of a provider module, which hits a pre-existing circular-import TDZ in v6.5.0's `provider-utils.js`: `Cannot access 'CL_HELPER_PLUGIN_BASE' before initialization`. This affects **every** provider identically, including untouched upstream ones (botbooru, chartavern), and does NOT break the real app (which loads `provider-utils` first via `module-loader.js`). So:
- Do **not** chase green. The signal is **"no NEW failures vs the pre-merge baseline,"** not "all pass."
- To get the baseline, run the suite (or the affected file) at the branch's pre-merge tip in a throwaway `git worktree`, note the pass/fail counts, then compare after merging. Identical counts = no regression, even if both are red.
- A genuine regression looks like: a test that *passed* pre-merge now fails, or a NEW error type (a real `ReferenceError`/syntax error in code you merged, not the known `CL_HELPER_PLUGIN_BASE` TDZ).

---

## STEP 2: Rebuild the AIO branch (ONLY after Step 1 is complete for ALL branches)

The AIO branch is NOT maintained incrementally — it's rebuilt from scratch each time.

### 2a: Determine the new version tag

The AIO branch is named `aio-v<version>` matching the Character Library release on main:

```
git log --oneline main -1
```

If main is at `v6.5.0`, the new AIO branch is `aio-v6.5.0`.

### 2b: Reset or create the AIO branch

If an AIO branch already exists for this version, reset it to main:

```
git checkout aio-v<version>
git reset --hard main
```

If this is a new version, create it:

```
git checkout -b aio-v<new-version> main
```

Delete the old version branch if it's no longer needed:

```
git branch -d aio-v<old-version>
git push origin --delete aio-v<old-version>
```

### 2c: Merge feature branches one by one

Merge each updated feature branch with a tagged commit message:

```
git merge codex/fix-chub-tag-exclusions --no-ff -m "[fix-chub-tag-exclusions] Integrate Chub tag exclusions"
git merge codex/datacat-account-sync --no-ff -m "[datacat-account-sync] Integrate DataCat account sync"
git merge extended-bookmarks --no-ff -m "[extended-bookmarks] Integrate provider bookmark backups"
git merge codex/janitorai-ext-account-sync --no-ff -m "[janitorai-ext-account-sync] Integrate JanitorAI ext account sync"
git merge codex/jannyai-account-sync --no-ff -m "[jannyai-account-sync] Integrate JannyAI account sync"
```

Merge order matters: **jannyai must be merged last**, because it conflicts with the
already-merged `extended-bookmarks` over the shared Janny surface (both add
bookmark-like filters to `janny-browse.js`). `janitorai-ext-account-sync`
should be merged after `extended-bookmarks` but before `jannyai`, because it
conflicts with bookmarks over `janitorai-browse.js`. See 2d.

`codex/fix-chub-tag-exclusions` is **order-independent** — it touches only
`chub-browse.js`, the new `chub-tag-filter.js`, and its own test file, and shares
no file with any other feature branch. Merging it first keeps the other four in
their proven relative order. Verified conflict-free 2026-09-03.

### 2d: Handle the known conflict

There are four recurring inter-branch conflict clusters. Clusters A-C are provider files; cluster D is the shared app shell and is the one most often missed.

**A. `modules/providers/datacat/datacat-browse.js` — datacat-account-sync vs extended-bookmarks.** Both add card buttons, handlers, and filter flags.

**Resolution: union — keep everything from both branches.** Specifically:
- Keep `bookmarkBtn` (from extended-bookmarks) in the card footer. (The old `yoursBtn` from datacat-account-sync no longer exists — that feature became the folder picker + `datacatFilterOnlyYours` filter. Don't go looking for it.)
- Keep the datacat folder button AND `${datacatBookmarks.renderMetaAction()}` in the modal meta row — two separate controls.
- Keep both filter flag sets. NOTE: the `updateDatacatFiltersButtonState` count array is ONE expression, not two — **merge** the two arrays into a single `const count = [...]` containing every flag (`datacatFilterOnlyYours` from datacat + `datacatBookmarks.filterMyBookmarks` from bookmarks), don't keep both lines (double `const` = redeclaration error).
- Keep both the `datacatYoursFolderSelect` handler and `datacatBookmarks.attachFilterCheckbox()`.

**B. `modules/providers/janny/janny-browse.js` — extended-bookmarks vs jannyai-account-sync** (only when jannyai is merged after bookmarks). Both add Janny bookmark/account UI. These are **two different features** that look alike: `jannyBookmarks.*` is the local backup module, `jannyFilterOnlyBookmarked` / `jannyBookmarkBtn` is the JannyAI *account's* saved list. Keep both everywhere.
- `janny-browse.js` (5 blocks): union for the imports, the event-wiring, the modal meta row (both `${jannyBookmarks.renderMetaAction()}` AND the `jannyBookmarkBtn` button) and the filter-UI blocks. One needs real merging, not union: `updateJannyFiltersButton`'s `const count = [...]` array — combine both flags into the single array (`jannyBookmarks.filterMyBookmarks` + `jannyFilterOnlyBookmarked`), never two `const` lines.
- As of v7.0.0 `init()` no longer issues the initial load (upstream moved it to `activate()`), so the old init() merge note is obsolete: leave upstream's "No initial load here" comment, keep jannyai's `refreshJannyAccountStatus()` in `init()`, and make sure the bookmarks conditional (`if (jannyBookmarks.filterMyBookmarks) renderBookmarksView() else loadCharacters(false)`) sits in `activate()`.
- `cl-helper/index.js`: **no longer conflicts** (verified 2026-09-03). The old split-import note referenced `extras/cl-helper/janny-account.js`, which no longer exists on any branch — jannyai now ships `janny-browser-policy.js` instead, and cl-helper auto-merges cleanly. Ignore any older instruction to hand-resolve two import statements here.

**C. `modules/providers/janitorai/janitorai-browse.js` — janitorai-ext-account-sync vs extended-bookmarks** (when favorites is merged after bookmarks). Both add features to janitorai. `janitoraiBookmarks.*` is the local backup module; `jaFilterFavorites` / favorite preview is the JanitorAI *account's* favorites list. Keep both everywhere.
- `janitorai-browse.js` (3 blocks): union for `openPreviewModal` (keep `janitoraiBookmarks.syncModalState(hit)` AND the favorites token/identity setup), the `updateFiltersButton` count array (merge `janitoraiBookmarks.filterMyBookmarks` + `jaFilterFavorites` into one array), and the modal meta row (keep both `${janitoraiBookmarks.renderMetaAction()}` AND the `janitoraiCharFavoriteBtn` span).
- Note: 6 janitorai-favorites tests fail in AIO because `bookmark-module.js` calls `window.addEventListener` at import time, which the favorites tests don't mock. This is an expected inter-branch test interaction that doesn't affect the real app.

**D. The shared app shell — `app/library-mobile.js`, `app/library.js`, `app/library.html`, `modules/providers/browse-shared.css`.** These are NOT provider files, and they conflict across several branch pairs. Empirically verified 2026-09-03 by trial-merging each pair onto `main`:

| Pair | Conflicting files |
|------|-------------------|
| datacat x bookmarks | `library-mobile.js`, `browse-shared.css`, `datacat-browse.js` |
| bookmarks x jannyai | `library-mobile.js`, `browse-shared.css`, `janny-browse.js` |
| datacat x jannyai | `library-mobile.js`, `library.js` |
| bookmarks x janitorai | `janitorai-browse.js` |
| janitorai x jannyai | `library.html` |
| chub x anything | *(none)* |

Resolutions differ per file — do NOT blanket-union this cluster:

- **`app/library-mobile.js` — resolve as OURS.** This is the trap. The incoming branch re-adds a `metaAction` visibility guard that HEAD already has, only reformatted across multiple lines. It is the *same* logic, not an addition. A union duplicates the `if (...) return;` and you get a broken/duplicated conditional. Keep HEAD's version, discard the incoming one. `library-mobile.js` conflicts in 3 of the 5 branch pairs, so you will hit this more than once.
- **`modules/providers/browse-shared.css` — union.** Plain adjacent addition: one side is empty, the other appends a self-contained rule block (e.g. the `.cl-bookmark-btn` styles). Keep both sides.
- **`app/library.js` — union.** Plain adjacent addition of independent `const x = document.getElementById(...)` lines. Keep both blocks; no dedup needed.
- **`app/library.html` — take the HIGHEST version per line, not one side wholesale.** The conflict is cache-buster query strings that both branches bumped independently, e.g. HEAD `library.js?v=199` / `module-loader.js?v=51` / `library-mobile.js?v=27` vs incoming `?v=200` / `?v=54` / `?v=26`. Resolve each `?v=` to the max of the two (here: 200, 54, 27), or bump past both. Taking one side wholesale silently *lowers* a cache-buster, which serves stale JS to the mobile browser the user actually tests on.

If other conflicts appear, they're new — investigate before resolving.

### 2e: Push

```
git push origin aio-v<version> --force-with-lease
```

Force-push is expected here because the AIO branch was reset to main. Use `--force-with-lease` as a safety check.

---

## Checklist

Before considering the update complete:

- [ ] `main` is up to date with upstream
- [ ] Maintainer's current coding style has been reviewed
- [ ] **Every** feature branch has main merged in
- [ ] **Every** feature branch has code style aligned with upstream
- [ ] **Every** feature branch verified (no markers, all `.js` parse, no NEW test failures vs baseline)
- [ ] **Every** feature branch is pushed
- [ ] AIO branch is reset to main (not incrementally merged)
- [ ] All five feature branches are merged into AIO (jannyai last among the conflicting four)
- [ ] AIO verified (no markers, parses, no new test failures) and pushed to origin
- [ ] Cluster D checked: `library-mobile.js` resolved OURS, `library.html` `?v=` bumps took the max
- [ ] No QOL, provider-guide-docs, saucepan-hidden-extraction, or masquerade-provider in AIO

## When to use this workflow

- After a new upstream Character Library release lands on main
- When a feature branch has significant new work that should be integration-tested
- When rebuilding AIO after a branch was reverted or restructured
