# DataCat Folder Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add account-scoped DataCat folder routes and frontend API helpers for custom folders beyond Main.

**Architecture:** Keep the current Yours/Main star behavior on `/collect`. Add custom folder list/create/update/delete and folder item membership routes through `cl-helper`, gated by the existing DataCat account session. Frontend helpers call these routes through the existing account JSON wrapper so saved account tokens recover after helper restarts.

**Tech Stack:** Plain browser JavaScript modules, ESM `cl-helper`, Node built-in test runner, `node --check`.

---

## File Map

- Modify `tests/datacat-utils.test.mjs`: pure tests for folder path and payload helpers.
- Modify `tests/datacat-account-retry.test.mjs`: account route wrapper tests.
- Modify `modules/providers/datacat/datacat-api.js`: folder path builders and exported API wrappers.
- Modify `extras/cl-helper/datacat-utils.js`: folder ID validation helper.
- Modify `extras/cl-helper/index.js`: DataCat account folder routes.
- Create `docs/superpowers/specs/2026-06-27-datacat-folder-sync-design.md`: approved design.
- Create `docs/superpowers/plans/2026-06-27-datacat-folder-sync.md`: this plan.

---

### Task 1: Pure Folder Helper Tests

**Files:**
- Modify: `tests/datacat-utils.test.mjs`
- Modify: `modules/providers/datacat/datacat-api.js`
- Modify: `extras/cl-helper/datacat-utils.js`

- [x] **Step 1: Write failing tests**

Add tests for:

```js
normalizeDatacatFolderId('main') === 'main'
normalizeDatacatFolderId(12) === 12
buildDatacatFoldersPath({ minTotalTokens: 889, activeTagIds: [5], blockedTagIds: [9] })
buildDatacatFolderCharactersPath({ folderId: 'main', limit: 20, offset: 40 })
buildDatacatFolderCharactersPath({ folderId: 12, search: 'maid', sort: 'added' })
buildDatacatFolderItemPath(12, 'abc12345')
normalizeDatacatFolderPayload({ title: '  Favorites  ', description: '  test  ' })
isDataCatFolderId('12') === true
```

- [x] **Step 2: Verify red**

Run:

```bash
node --import ./tests/setup-browser-globals.mjs --test ./tests/datacat-utils.test.mjs
```

Expected: FAIL because the new helper exports do not exist.

- [x] **Step 3: Implement pure helpers**

Add folder helpers in `datacat-api.js` and `datacat-utils.js`.

- [x] **Step 4: Verify green**

Run the same command. Expected: PASS.

---

### Task 2: Account Wrapper Tests

**Files:**
- Modify: `tests/datacat-account-retry.test.mjs`
- Modify: `modules/providers/datacat/datacat-api.js`

- [x] **Step 1: Write failing wrapper tests**

Add tests proving:

- `fetchDatacatFolders()` retries after a 401 by calling `/dc-auth-set`.
- `setDatacatFolderMembership(12, 'abc12345', true)` calls `PUT /dc-folders/12/items/abc12345`.
- `createDatacatFolder({ title: ' Favorites ' })` sends a normalized body.

- [x] **Step 2: Verify red**

Run:

```bash
node --import ./tests/setup-browser-globals.mjs --test ./tests/datacat-account-retry.test.mjs
```

Expected: FAIL because folder API wrappers do not exist.

- [x] **Step 3: Implement wrappers**

Add `fetchDatacatFolders`, `createDatacatFolder`, `updateDatacatFolder`,
`deleteDatacatFolder`, `setDatacatFolderMembership`, and
`fetchDatacatFolderCharacters`.

- [x] **Step 4: Verify green**

Run the same command. Expected: PASS.

---

### Task 3: cl-helper Folder Routes

**Files:**
- Modify: `extras/cl-helper/index.js`

- [x] **Step 1: Add folder route helpers**

Add allow-listed query builders and response forwarding inside the DataCat route
section.

- [x] **Step 2: Add account-gated routes**

Implement:

```text
GET /dc-folders
POST /dc-folders
PATCH /dc-folders/:folderId
DELETE /dc-folders/:folderId
PUT /dc-folders/:folderId/items/:characterId
DELETE /dc-folders/:folderId/items/:characterId
GET /dc-folder-characters
```

- [x] **Step 3: Syntax check**

Run:

```bash
node --check ./extras/cl-helper/index.js
```

Expected: exit 0.

---

### Task 4: Final Verification

**Files:**
- All modified files

- [x] **Step 1: Run tests**

```bash
node --import ./tests/setup-browser-globals.mjs --test ./tests/datacat-utils.test.mjs ./tests/datacat-account-retry.test.mjs
```

Expected: 0 failures.

- [x] **Step 2: Run syntax checks**

```bash
node --check ./extras/cl-helper/datacat-utils.js
node --check ./extras/cl-helper/index.js
node --check ./modules/providers/datacat/datacat-api.js
```

Expected: all exit 0.

- [x] **Step 3: Check git status**

```bash
git status --short --branch
```

Expected: modified files are intentional and ready to commit or push as requested.

---

## Self-Review Notes

- Spec coverage: folder list, create, edit, delete, item add/remove, Main vs custom folder behavior, lazy account recovery, and validation are covered.
- Scope control: no large UI is included in this pass.
- Type consistency: folder IDs are positive integers in helpers and routes; Main is represented as the string `main` or query `mainOnly=1`, never as a DataCat folder row.
