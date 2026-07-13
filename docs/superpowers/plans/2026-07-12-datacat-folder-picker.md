# DataCat Folder Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Save to folder" picker on the DataCat card viewer that toggles a character's membership in the account's custom folders (plus Main), with inline folder create — mirroring datacat.run's own picker.

**Architecture:** New self-contained module `datacat-folder-picker.js` (pure model helpers + a body-appended dropdown component, like the mobile kebab menu pattern). `datacat-browse.js` adds the trigger button to the preview modal, gates its visibility with the existing Yours-sync conditions, and passes hooks so the picker's Main row reuses the star's toggle logic. Server side already exists (phase 1) — this is frontend-only.

**Tech Stack:** Vanilla ES modules, FontAwesome icons, CL's `action-btn`/toast styles, `node --test` with the browser-globals shim.

**Spec:** `docs/superpowers/specs/2026-07-12-datacat-folder-picker-design.md`

## Global Constraints

- Branch: `codex/datacat-account-sync`. Commit and push after every task (user tests from GitHub).
- The star's one-tap save-to-Main behavior must not change.
- Picker shows: Main row, custom folders, inline create. NO rename/delete. NO grid-card buttons.
- Reserved/system folders (`isReserved`, `isPrivateVault`, truthy `systemKey` — e.g. the "Private Vault") must never appear in the picker. Verified live 2026-07-12: `GET /api/user-folders` returns them mixed in with customs.
- DataCat folder `id`s arrive as **strings** (`"2359"`); `dc-yours/:id/status` returns `folderIds` that may be numbers. All membership comparisons must String()-normalize both sides.
- Folder create: title only, trimmed, ≤120 chars (`normalizeDatacatFolderPayload` enforces; don't re-implement).
- Mobile (`html.cl-mobile`): picker becomes a fixed bottom sheet, ≥44px rows, internal scroll. The mobile kebab menu auto-clones `.action-btn`s from `.modal-controls`, so the trigger needs no mobile-specific JS.
- Do NOT toggle the picker with a `.hidden` class (browse-shared.css cascade beats it) — create/remove the element instead, like `mobile-more-actions-menu` does.
- Toast copy: `Added <char> to <folder>.` / `Removed <char> from <folder>.` / `Created <folder>.`
- API wrappers to consume (exist on branch, do not rebuild): `fetchDatacatFolders()`, `fetchDatacatYoursStatus(id)` → `{ok, collected, folderIds}`, `setDatacatFolderMembership(folderId, characterId, member)`, `createDatacatFolder({title})`, `setDatacatYoursSaved(id, saved)`.

---

### Task 1: Pure picker model helpers (TDD)

**Files:**
- Create: `modules/providers/datacat/datacat-folder-picker.js` (pure helpers only in this task)
- Create: `tests/datacat-folder-picker.test.mjs`

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces (Task 2 renders from these; tests import them):
  - `filterPickerFolders(folders) -> [{id: string, title: string}]`
  - `buildPickerModel({ folders, collected, folderIds }) -> { mainChecked: boolean, rows: [{id, title, checked}] }`

Note: the spec's test list mentions "optimistic toggle + revert" state tests. The component (Task 2) implements optimistic state directly as DOM `checked`/`busy` classes with revert-on-error — there is deliberately no pure toggle reducer to test (it would be dead code). The revert behavior is covered by the live manual checklist in Task 5 instead.

- [ ] **Step 1: Write the failing tests**

Create `tests/datacat-folder-picker.test.mjs`:

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    filterPickerFolders,
    buildPickerModel,
} from '../modules/providers/datacat/datacat-folder-picker.js';

describe('filterPickerFolders', () => {
    it('drops reserved/system folders and keeps customs in API order', () => {
        const folders = [
            { id: '1644', title: 'Private Vault', isReserved: true, isPrivateVault: true, systemKey: 'private_vault' },
            { id: '2359', title: 'marvel smut', isReserved: false, isPrivateVault: false, systemKey: null },
            { id: '2360', title: 'DC Smut', isReserved: false, isPrivateVault: false, systemKey: null },
        ];
        assert.deepEqual(filterPickerFolders(folders), [
            { id: '2359', title: 'marvel smut' },
            { id: '2360', title: 'DC Smut' },
        ]);
    });

    it('tolerates junk input', () => {
        assert.deepEqual(filterPickerFolders(null), []);
        assert.deepEqual(filterPickerFolders([{ id: '', title: 'x' }, null, { id: '5' }]), [{ id: '5', title: '' }]);
    });
});

describe('buildPickerModel', () => {
    it('marks membership with string/number id tolerance', () => {
        const model = buildPickerModel({
            folders: [{ id: '2359', title: 'marvel smut' }, { id: '2360', title: 'DC Smut' }],
            collected: true,
            folderIds: [2359],
        });
        assert.equal(model.mainChecked, true);
        assert.deepEqual(model.rows, [
            { id: '2359', title: 'marvel smut', checked: true },
            { id: '2360', title: 'DC Smut', checked: false },
        ]);
    });

    it('defaults to unchecked on missing status', () => {
        const model = buildPickerModel({ folders: [{ id: '7', title: 'a' }] });
        assert.equal(model.mainChecked, false);
        assert.deepEqual(model.rows, [{ id: '7', title: 'a', checked: false }]);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import ./tests/setup-browser-globals.mjs tests/datacat-folder-picker.test.mjs`
Expected: FAIL — `Cannot find module ... datacat-folder-picker.js`

- [ ] **Step 3: Write the minimal implementation**

Create `modules/providers/datacat/datacat-folder-picker.js`:

```js
// DataCat folder picker - "Save to folder" dropdown for the preview modal.
// Pure model helpers here are unit-tested; the DOM component follows in this file.

/**
 * Keep only user-created folders. DataCat mixes reserved/system folders
 * (e.g. the Private Vault) into /api/user-folders; the site's own picker
 * hides them and so do we.
 * @param {Array} folders raw folders from fetchDatacatFolders()
 * @returns {{id: string, title: string}[]}
 */
export function filterPickerFolders(folders) {
    if (!Array.isArray(folders)) return [];
    return folders
        .filter(f => f && !f.isReserved && !f.isPrivateVault && !f.systemKey)
        .map(f => ({ id: String(f.id ?? '').trim(), title: String(f.title ?? '') }))
        .filter(f => f.id);
}

/**
 * Build the render model from the folder list + membership status.
 * @param {{folders?: Array, collected?: boolean, folderIds?: Array}} opts
 * @returns {{mainChecked: boolean, rows: {id: string, title: string, checked: boolean}[]}}
 */
export function buildPickerModel({ folders = [], collected = false, folderIds = [] } = {}) {
    const memberIds = new Set((Array.isArray(folderIds) ? folderIds : []).map(v => String(v)));
    return {
        mainChecked: collected === true,
        rows: folders.map(f => ({ id: f.id, title: f.title, checked: memberIds.has(String(f.id)) })),
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import ./tests/setup-browser-globals.mjs tests/datacat-folder-picker.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add modules/providers/datacat/datacat-folder-picker.js tests/datacat-folder-picker.test.mjs
git commit -m "feat(datacat): folder picker model helpers"
git push
```

---

### Task 2: Picker DOM component

**Files:**
- Modify: `modules/providers/datacat/datacat-folder-picker.js` (append below the pure helpers)

**Interfaces:**
- Consumes: `fetchDatacatFolders`, `fetchDatacatYoursStatus`, `setDatacatFolderMembership`, `createDatacatFolder` from `./datacat-api.js`; `CoreAPI.showToast`, `CoreAPI.escapeHtml`.
- Produces (Task 3 calls these):
  - `initDatacatFolderPicker({ getMainSaved(id) -> boolean, toggleMain(id) -> Promise })`
  - `openDatacatFolderPicker({ anchor: HTMLElement, characterId: string, characterName: string })`
  - `closeDatacatFolderPicker()`
  - `invalidateDatacatFolderCache()`

- [ ] **Step 1: Append the component code**

Append to `modules/providers/datacat/datacat-folder-picker.js`:

```js
import CoreAPI from '../../core-api.js';
import {
    fetchDatacatFolders,
    fetchDatacatYoursStatus,
    setDatacatFolderMembership,
    createDatacatFolder,
} from './datacat-api.js';

const { showToast, escapeHtml } = CoreAPI;

let _hooks = { getMainSaved: () => false, toggleMain: async () => {} };
let _folderCache = null;   // filtered [{id,title}] or null
let _openEl = null;
let _openCharId = '';
let _openCharName = '';
let _outsideHandler = null;

export function initDatacatFolderPicker(hooks) {
    _hooks = { ..._hooks, ...hooks };
}

export function invalidateDatacatFolderCache() {
    _folderCache = null;
}

export function closeDatacatFolderPicker() {
    if (_outsideHandler) {
        document.removeEventListener('pointerdown', _outsideHandler, true);
        _outsideHandler = null;
    }
    _openEl?.remove();
    _openEl = null;
    _openCharId = '';
    _openCharName = '';
}

function rowHtml({ id, title, checked, icon = 'fa-folder' }) {
    return `<button type="button" class="datacat-folder-row${checked ? ' checked' : ''}" data-folder-id="${escapeHtml(id)}">
        <i class="fa-solid ${icon} datacat-folder-row-icon"></i>
        <span class="datacat-folder-row-title">${escapeHtml(title)}</span>
        <i class="fa-solid fa-check datacat-folder-row-check"></i>
    </button>`;
}

function renderPickerBody(el, model) {
    el.innerHTML = `
        <div class="datacat-folder-picker-heading">Save to folder</div>
        ${rowHtml({ id: '__main__', title: 'Main', checked: model.mainChecked, icon: 'fa-star' })}
        ${model.rows.map(r => rowHtml(r)).join('')}
        <div class="datacat-folder-create-row">
            <input type="text" class="datacat-folder-create-input" placeholder="New folder name" maxlength="120">
            <button type="button" class="datacat-folder-create-btn" disabled>Save</button>
        </div>`;
    wireRows(el);
}

function renderPickerError(el, message, { retry = true } = {}) {
    el.innerHTML = `
        <div class="datacat-folder-picker-heading">Save to folder</div>
        <div class="datacat-folder-picker-error">${escapeHtml(message)}</div>
        ${retry ? '<button type="button" class="datacat-folder-retry-btn">Retry</button>' : ''}`;
    el.querySelector('.datacat-folder-retry-btn')?.addEventListener('click', () => loadAndRender(el));
}

async function loadAndRender(el) {
    el.innerHTML = '<div class="datacat-folder-picker-heading">Save to folder</div><div class="datacat-folder-picker-loading"><i class="fa-solid fa-spinner fa-spin"></i></div>';
    try {
        if (!_folderCache) {
            const res = await fetchDatacatFolders();
            if (!res?.ok) throw new Error(res?.error || 'Could not load folders');
            _folderCache = filterPickerFolders(res.folders);
        }
        const status = await fetchDatacatYoursStatus(_openCharId);
        const model = buildPickerModel({
            folders: _folderCache,
            collected: status?.ok ? status.collected === true : _hooks.getMainSaved(_openCharId),
            folderIds: status?.ok ? status.folderIds : [],
        });
        if (!_openEl) return; // closed while loading
        renderPickerBody(el, model);
    } catch (err) {
        if (!_openEl) return;
        const msg = /session|auth|account|401/i.test(err.message)
            ? 'Session expired - check Settings > Online > DataCat'
            : err.message;
        renderPickerError(el, msg);
    }
}

function wireRows(el) {
    el.querySelectorAll('.datacat-folder-row').forEach(row => {
        row.addEventListener('click', async () => {
            if (row.classList.contains('busy')) return;
            const folderId = row.dataset.folderId;
            const wasChecked = row.classList.contains('checked');
            const next = !wasChecked;
            row.classList.add('busy');
            row.classList.toggle('checked', next); // optimistic
            try {
                if (folderId === '__main__') {
                    await _hooks.toggleMain(_openCharId);
                    row.classList.toggle('checked', _hooks.getMainSaved(_openCharId));
                } else {
                    const res = await setDatacatFolderMembership(folderId, _openCharId, next);
                    if (!res?.ok) throw new Error(res?.error || 'DataCat folder update failed');
                    const title = row.querySelector('.datacat-folder-row-title')?.textContent || 'folder';
                    showToast(`${next ? 'Added' : 'Removed'} ${_openCharName} ${next ? 'to' : 'from'} ${title}.`, 'success');
                }
            } catch (err) {
                row.classList.toggle('checked', wasChecked); // revert
                showToast(`DataCat folder sync failed: ${err.message}`, 'error');
            } finally {
                row.classList.remove('busy');
            }
        });
    });

    const input = el.querySelector('.datacat-folder-create-input');
    const createBtn = el.querySelector('.datacat-folder-create-btn');
    if (!input || !createBtn) return;
    input.addEventListener('input', () => { createBtn.disabled = !input.value.trim(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !createBtn.disabled) createBtn.click(); });
    createBtn.addEventListener('click', async () => {
        const title = input.value.trim();
        if (!title || createBtn.disabled) return;
        createBtn.disabled = true;
        try {
            const res = await createDatacatFolder({ title });
            if (!res?.ok) throw new Error(res?.error || 'DataCat folder create failed');
            showToast(`Created ${title}.`, 'success');
            invalidateDatacatFolderCache();
            const newId = res.folder?.id != null ? String(res.folder.id) : null;
            if (newId) {
                const addRes = await setDatacatFolderMembership(newId, _openCharId, true);
                if (addRes?.ok) showToast(`Added ${_openCharName} to ${title}.`, 'success');
            }
            if (_openEl) await loadAndRender(_openEl);
        } catch (err) {
            createBtn.disabled = false; // keep input for retry
            showToast(`DataCat folder create failed: ${err.message}`, 'error');
        }
    });
}

function positionPicker(el, anchor) {
    if (document.documentElement.classList.contains('cl-mobile')) return; // CSS bottom sheet
    const rect = anchor.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    let top = rect.bottom + 6;
    if (top + elRect.height > window.innerHeight - 12) {
        top = Math.max(12, rect.top - elRect.height - 6);
    }
    let left = rect.right - elRect.width;
    if (left < 12) left = 12;
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
}

export async function openDatacatFolderPicker({ anchor, characterId, characterName }) {
    const id = String(characterId || '').trim();
    if (!id || !anchor) return;
    if (_openEl && _openCharId === id) { closeDatacatFolderPicker(); return; } // toggle
    closeDatacatFolderPicker();

    _openCharId = id;
    _openCharName = String(characterName || 'character');
    const el = document.createElement('div');
    el.className = 'datacat-folder-picker';
    document.body.appendChild(el);
    _openEl = el;

    _outsideHandler = (e) => {
        if (el.contains(e.target) || anchor.contains(e.target)) return;
        closeDatacatFolderPicker();
    };
    document.addEventListener('pointerdown', _outsideHandler, true);

    await loadAndRender(el);
    if (_openEl === el) positionPicker(el, anchor);
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check modules/providers/datacat/datacat-folder-picker.js`
Expected: no output (exit 0)

- [ ] **Step 3: Re-run the unit tests (pure helpers must still pass under the shim)**

Run: `node --test --import ./tests/setup-browser-globals.mjs tests/datacat-folder-picker.test.mjs`
Expected: PASS

Contingency: this step now pulls `core-api.js` into the test's module graph. If it throws on a missing browser global at import time, extend `tests/setup-browser-globals.mjs` with the missing stub (same pattern as the existing `window`/`document` shims) — do NOT restructure the imports to dodge it.

- [ ] **Step 4: Commit**

```bash
git add modules/providers/datacat/datacat-folder-picker.js
git commit -m "feat(datacat): folder picker dropdown component"
git push
```

---

### Task 3: Wire the trigger button into the preview modal

**Files:**
- Modify: `modules/providers/datacat/datacat-browse.js` — four spots: imports, modal HTML (~line 4571), visibility control (`updateDatacatModalYoursControl`, ~line 466), event wiring (~line 4154).

**Interfaces:**
- Consumes: `initDatacatFolderPicker`, `openDatacatFolderPicker`, `closeDatacatFolderPicker` from `./datacat-folder-picker.js`; existing `getDatacatYoursState`, `toggleDatacatYours`, `findDatacatHitById`, `canShowDatacatYoursControl`, `isDatacatYoursSyncEnabled`.
- Produces: `#datacatFolderBtn` in the modal controls (the mobile kebab picks it up automatically).

- [ ] **Step 1: Add the import**

Near the other `./datacat-api.js` imports at the top of `datacat-browse.js`, add:

```js
import {
    initDatacatFolderPicker,
    openDatacatFolderPicker,
    closeDatacatFolderPicker,
} from './datacat-folder-picker.js';
```

- [ ] **Step 2: Add the button to the modal HTML**

In `renderModals()`, directly after the `datacatYoursBtn` button element, add:

```html
                    <button id="datacatFolderBtn" class="action-btn secondary datacat-folder-modal-btn" title="Save to folder" style="display: none;">
                        <i class="fa-solid fa-folder-plus"></i> Folder
                    </button>
```

- [ ] **Step 3: Gate visibility alongside the star**

At the end of `updateDatacatModalYoursControl(characterId, hit, { refresh })`, add (inside the function, after the existing logic):

```js
    const folderBtn = document.getElementById('datacatFolderBtn');
    if (folderBtn) {
        folderBtn.dataset.datacatId = id;
        folderBtn.style.display = canShowDatacatYoursControl(id, hit) ? '' : 'none';
    }
```

Note: `updateDatacatModalYoursControl` early-returns when `#datacatYoursBtn` is missing; both buttons render together in `renderModals()`, so this placement is safe.

- [ ] **Step 4: Wire the click + hooks + close-on-modal-close**

In the event-listener setup, directly after the `on('datacatYoursBtn', 'click', ...)` block, add:

```js
    initDatacatFolderPicker({
        getMainSaved: (id) => getDatacatYoursState(id, findDatacatHitById(id)),
        toggleMain: (id) => toggleDatacatYours(id, findDatacatHitById(id)),
    });

    on('datacatFolderBtn', 'click', () => {
        const btn = document.getElementById('datacatFolderBtn');
        const charId = btn?.dataset?.datacatId;
        if (!charId) return;
        const hit = findDatacatHitById(charId) || datacatSelectedChar;
        openDatacatFolderPicker({
            anchor: btn,
            characterId: charId,
            characterName: hit?.name || 'character',
        });
    });
```

Then find `closePreviewModal()` and add `closeDatacatFolderPicker();` as its first line, so a dangling picker never outlives the modal.

- [ ] **Step 5: Syntax check + full test suite**

Run: `node --check modules/providers/datacat/datacat-browse.js`
Expected: exit 0
Run: `node --test --import ./tests/setup-browser-globals.mjs tests/*.test.mjs`
Expected: all PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
git add modules/providers/datacat/datacat-browse.js
git commit -m "feat(datacat): Save to folder button in preview modal"
git push
```

---

### Task 4: Picker styles (desktop dropdown + mobile sheet)

**Files:**
- Modify: `modules/providers/datacat/datacat-browse.css` (append at end)

**Interfaces:**
- Consumes: class names from Task 2 (`datacat-folder-picker`, `-heading`, `-row`, `-row-icon`, `-row-title`, `-row-check`, `-create-row`, `-create-input`, `-create-btn`, `-picker-error`, `-picker-loading`, `-retry-btn`, row states `checked`/`busy`).
- Produces: nothing consumed later.

- [ ] **Step 1: Append the styles**

```css
/* ===== DataCat folder picker ===== */
.datacat-folder-picker {
    position: fixed;
    z-index: 10010; /* above the preview modal overlay */
    min-width: 240px;
    max-width: 320px;
    max-height: 55vh;
    overflow-y: auto;
    padding: 8px;
    border-radius: 12px;
    background: rgba(24, 26, 32, 0.97);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
}
.datacat-folder-picker-heading {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.6;
    padding: 4px 8px 8px;
}
.datacat-folder-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 40px;
    padding: 8px 10px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
}
.datacat-folder-row:hover { background: rgba(255, 255, 255, 0.07); }
.datacat-folder-row.busy { opacity: 0.55; pointer-events: none; }
.datacat-folder-row-icon { opacity: 0.7; width: 16px; text-align: center; }
.datacat-folder-row-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.datacat-folder-row-check { visibility: hidden; color: var(--accent-color, #4a9eff); }
.datacat-folder-row.checked .datacat-folder-row-check { visibility: visible; }
.datacat-folder-create-row {
    display: flex;
    gap: 6px;
    padding: 8px 4px 2px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    margin-top: 6px;
}
.datacat-folder-create-input {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: rgba(0, 0, 0, 0.3);
    color: inherit;
}
.datacat-folder-create-btn {
    padding: 8px 12px;
    border: none;
    border-radius: 8px;
    background: var(--accent-color, #4a9eff);
    color: #fff;
    cursor: pointer;
}
.datacat-folder-create-btn:disabled { opacity: 0.4; cursor: default; }
.datacat-folder-picker-error { padding: 10px; font-size: 0.9rem; opacity: 0.85; }
.datacat-folder-picker-loading { padding: 16px; text-align: center; opacity: 0.7; }
.datacat-folder-retry-btn {
    margin: 0 10px 8px;
    padding: 6px 12px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    background: transparent;
    color: inherit;
    cursor: pointer;
}

/* Mobile: bottom sheet inside the viewport, big touch targets */
html.cl-mobile .datacat-folder-picker {
    left: 12px !important;
    right: 12px;
    top: auto !important;
    bottom: 12px;
    max-width: none;
    max-height: 60vh;
}
html.cl-mobile .datacat-folder-row { min-height: 44px; }
```

- [ ] **Step 2: Commit**

```bash
git add modules/providers/datacat/datacat-browse.css
git commit -m "style(datacat): folder picker dropdown + mobile sheet styles"
git push
```

---

### Task 5: Full verification (suite + live)

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `node --test --import ./tests/setup-browser-globals.mjs tests/*.test.mjs`
Expected: all PASS

- [ ] **Step 2: Syntax-check every edited file**

Run:
```bash
node --check modules/providers/datacat/datacat-folder-picker.js
node --check modules/providers/datacat/datacat-browse.js
```
Expected: exit 0 for both

- [ ] **Step 3: Live manual verification (per spec's manual checklist)**

With the user's ST (http://127.0.0.1:8001, DataCat account signed in):

1. Open a DataCat character preview → `Folder` button visible next to the star; absent when logged out of DataCat.
2. Click it → picker lists Main + real custom folders with correct checkmarks; "Private Vault" absent.
3. Toggle a custom folder on → toast; confirm membership on datacat.run (folder picker there shows it checked).
4. Toggle it off → confirm removal on datacat.run.
5. Toggle Main in the picker → the modal's star flips too (and vice versa).
6. Create a folder (e.g. `CL test folder`) → appears checked with the character inside; verify on datacat.run, then delete it there.
7. Mobile viewport (`html.cl-mobile`): kebab menu shows the Folder item; picker renders as a bottom sheet with 44px rows and internal scroll.

- [ ] **Step 4: Final push and report**

```bash
git push
```
Report results to the user, including anything that deviated from the plan.
