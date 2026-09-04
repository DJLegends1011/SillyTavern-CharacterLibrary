# DataCat Folder Cache Race Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the DataCat save picker from becoming stuck with only Main after a transient or racing folder load.

**Architecture:** Introduce a testable single-flight folder loader inside the existing picker module. Use it for preloads and interactive loads, sequence startup preloading after account restoration, and invalidate it when the account lifecycle changes.

**Tech Stack:** Browser JavaScript ES modules and Node's built-in test runner.

## Global Constraints

- Keep the change inside the existing DataCat provider, picker, and tests.
- Do not add dependencies or change visible picker behavior beyond recovery from stale empty folder state.

---

### Task 1: Single-flight folder loader

**Files:**
- Modify: `modules/providers/datacat/datacat-folder-picker.js`
- Test: `tests/datacat-folder-picker.test.mjs`

**Interfaces:**
- Produces: `createDatacatFolderLoader(fetchFolders)` with `load()` and `invalidate()` methods.
- Consumes: the existing `filterPickerFolders()` normalization helper and `fetchDatacatFolders()` API function.

- [ ] **Step 1: Write failing loader tests**

Add tests that start two loads before resolving the fetch, verify one request,
verify empty results are fetched again, verify invalidation forces a refresh,
and verify a rejection does not poison later loads.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import ./tests/setup-browser-globals.mjs --test tests/datacat-folder-picker.test.mjs`

Expected: FAIL because `createDatacatFolderLoader` is not exported.

- [ ] **Step 3: Implement the loader and route picker/preload calls through it**

The loader shares one in-flight promise, retains only non-empty normalized
folder lists, clears the promise in `finally`, and exposes invalidation.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --import ./tests/setup-browser-globals.mjs --test tests/datacat-folder-picker.test.mjs`

Expected: PASS.

### Task 2: Account lifecycle sequencing

**Files:**
- Modify: `modules/providers/datacat/datacat-browse.js`
- Modify: `modules/providers/datacat/datacat-provider.js`

**Interfaces:**
- Consumes: `preloadDatacatFolderCache()` and `invalidateDatacatFolderCache()`.
- Produces: account startup that restores before preloading and account wrappers that clear stale folders.

- [ ] **Step 1: Await startup account restoration before preloading**

Keep the restore promise non-fatal, await it after anonymous session bootstrap,
then start the deduplicated preload.

- [ ] **Step 2: Invalidate folders on successful login, restore, and logout**

Wrap the existing window-exposed account functions without changing their
return shapes.

- [ ] **Step 3: Run the focused DataCat suite**

Run: `node --import ./tests/setup-browser-globals.mjs --test tests/datacat-folder-picker.test.mjs tests/datacat-account-retry.test.mjs tests/datacat-utils.test.mjs`

Expected: PASS.

### Task 3: Verification and publication

**Files:**
- Verify all modified files and the complete test directory.

**Interfaces:**
- Consumes: final working tree.
- Produces: one scoped commit pushed to the current branch.

- [ ] **Step 1: Run all repository tests**

Run: `node --import ./tests/setup-browser-globals.mjs --test tests/*.test.mjs`

Expected: PASS.

- [ ] **Step 2: Inspect diff and syntax**

Run: `git diff --check` and inspect `git diff --stat` plus the complete diff.

- [ ] **Step 3: Commit and push**

Stage only the DataCat implementation, tests, design, and plan. Commit with
`fix(datacat): stabilize folder cache loading`, then push the current branch to
`origin` with upstream tracking.
