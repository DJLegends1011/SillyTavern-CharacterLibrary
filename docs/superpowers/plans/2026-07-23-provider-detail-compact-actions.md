# Compact Provider Detail Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace oversized provider save/bookmark actions with compact metadata icons, remove DataCat's grid star and duplicate save notifications, and integrate each source-branch fix into `aio-v6.7.0` with the correct prefix.

**Architecture:** Keep account mutations and local-backup persistence in their existing provider modules. Add one compact metadata-action presentation contract and a generic mobile overflow mirror, then let DataCat, JannyAI, and `bookmark-module.js` supply their own icon, state, tooltip, and click behavior. Develop and test each feature on its original source branch before applying it to AIO as a separate prefixed commit.

**Tech Stack:** Browser-native JavaScript modules, HTML template literals, CSS, Node.js `node:test`, Git worktrees, and the in-app browser for desktop/mobile verification.

## Global Constraints

- Source branches are `codex/datacat-account-sync`, `codex/jannyai-account-sync`, and `extended-bookmarks`.
- AIO integration target is `aio-v6.7.0`.
- AIO commit prefixes are `[datacat-account-sync]`, `[jannyai-account-sync]`, and `[extended-bookmarks]`.
- DataCat's provider-native save appears only in character details, never on grid cards, on desktop and mobile.
- DataCat's provider-native save icon is a regular/solid heart.
- DataCat emits one success notification per save action using `Saved to "<folder name>"`.
- JannyAI's account bookmark is a compact regular/solid bookmark in character details.
- Local Backup becomes compact only for CharacterTavern, DataCat, JannyAI, Pygmalion, and Wyvern.
- Local Backup grid icons and persisted backup behavior remain unchanged.
- ChubAI, BotBooru, MasqueradeAI, provider APIs, authentication, and data models are not changed.
- Folder, Add to Collection, Open, Import, and Close remain separate actions.
- Use TDD: add a failing test, confirm the failure, implement the minimum change, and rerun the focused suite before each commit.
- At execution time, use `superpowers:using-git-worktrees` before creating or reusing source-branch worktrees.

## File Map

- `modules/providers/datacat/datacat-browse.js`: DataCat detail heart, save state, grid-star removal, and direct Yours mutation.
- `modules/providers/datacat/datacat-browse.css`: remove obsolete grid-star styles.
- `modules/providers/datacat/datacat-folder-picker.js`: one-toast folder-save behavior and destination-name formatting.
- `modules/providers/janny/janny-browse.js`: compact account bookmark markup and state.
- `modules/providers/bookmark-module.js`: shared compact Local Backup renderer and state synchronization.
- `modules/providers/browse-shared.css`: compact metadata-action visual contract.
- `app/library-mobile.js`: mirror every compact metadata action into the existing mobile overflow menu while preserving the Chub/BotBooru fallback.
- `modules/providers/chartavern/chartavern-browse.js`: place Local Backup in CharacterTavern metadata.
- `modules/providers/pygmalion/pygmalion-browse.js`: place Local Backup in Pygmalion metadata.
- `modules/providers/wyvern/wyvern-browse.js`: place Local Backup in Wyvern metadata.
- `tests/datacat-compact-save-ux-static.test.mjs`: DataCat placement, icon, grid-removal, and mobile contract.
- `tests/datacat-folder-picker.test.mjs`: exact DataCat destination notification copy.
- `tests/janny-compact-bookmark-ux-static.test.mjs`: JannyAI placement, icon state, and mobile contract.
- `tests/extended-bookmarks-contract.test.mjs`: exact five-provider Local Backup placement and behavior.

---

### Task 1: DataCat detail heart and grid-star removal

**Branch/worktree:** `codex/datacat-account-sync` in `.worktrees/compact-datacat`

**Files:**
- Create: `tests/datacat-compact-save-ux-static.test.mjs`
- Modify: `modules/providers/datacat/datacat-browse.js:128-683`
- Modify: `modules/providers/datacat/datacat-browse.js:2898-2907`
- Modify: `modules/providers/datacat/datacat-browse.js:3225-3270`
- Modify: `modules/providers/datacat/datacat-browse.js:3480-3525`
- Modify: `modules/providers/datacat/datacat-browse.js:3945-3957`
- Modify: `modules/providers/datacat/datacat-browse.js:4818-4837`
- Modify: `modules/providers/datacat/datacat-browse.css:51-77`
- Modify: `modules/providers/browse-shared.css`
- Modify: `app/library-mobile.js:3738-3780`

**Interfaces:**
- Consumes: `setDatacatYoursSaved(characterId, saved)`, `fetchDatacatYoursStatus(characterId)`, `isDatacatYoursCollectableHit(hit)`, and the existing `#datacatYoursBtn` click listener.
- Produces: one detail-only `button#datacatYoursBtn.browse-meta-action`, active class `favorited`, and generic mobile discovery through `.browse-meta-action`.

- [ ] **Step 1: Write the failing DataCat UX contract**

```js
// tests/datacat-compact-save-ux-static.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const browse = await readFile(
    new URL('../modules/providers/datacat/datacat-browse.js', import.meta.url),
    'utf8',
);
const css = await readFile(
    new URL('../modules/providers/browse-shared.css', import.meta.url),
    'utf8',
);
const mobile = await readFile(
    new URL('../app/library-mobile.js', import.meta.url),
    'utf8',
);

test('DataCat Yours is a detail-only compact heart', () => {
    assert.match(
        browse,
        /<p class="browse-char-meta">[\s\S]{0,700}id="datacatYoursBtn"[\s\S]{0,250}browse-meta-action[\s\S]{0,250}fa-regular fa-heart/,
    );
    assert.doesNotMatch(
        browse,
        /<div class="modal-controls">[\s\S]{0,500}id="datacatYoursBtn"/,
    );
    assert.doesNotMatch(browse, /class="datacat-yours-btn/);
    assert.doesNotMatch(browse, /data-datacat-probe=/);
    assert.doesNotMatch(browse, /renderDatacatYoursCardButton/);
    assert.doesNotMatch(browse, /observeDatacatYoursProbes/);
});

test('DataCat heart state updates icon, tooltip, and accessible label', () => {
    assert.match(browse, /classList\.toggle\('favorited', saved === true\)/);
    assert.match(
        browse,
        /saved \? '<i class="fa-solid fa-heart"><\/i>' : '<i class="fa-regular fa-heart"><\/i>'/,
    );
    assert.match(browse, /Remove from DataCat Yours/);
    assert.match(browse, /Save to DataCat Yours/);
    assert.match(browse, /setAttribute\('aria-label', title\)/);
});

test('compact metadata actions have shared desktop and mobile treatment', () => {
    assert.match(css, /\.browse-meta-action\s*{/);
    assert.match(css, /\.browse-meta-action\.favorited/);
    assert.match(css, /\.browse-meta-action:disabled/);
    assert.match(mobile, /querySelectorAll\('\.browse-meta-action'\)/);
    assert.match(mobile, /metaAction\.title \|\| metaAction\.getAttribute\('aria-label'\)/);
    assert.match(mobile, /metaAction\.click\(\)/);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```powershell
node --test tests/datacat-compact-save-ux-static.test.mjs
```

Expected: FAIL because DataCat still renders `.datacat-yours-btn`, the modal Save button is in `.modal-controls`, and `.browse-meta-action` does not exist.

- [ ] **Step 3: Add the shared compact metadata-action CSS**

Append this exact shared contract to `modules/providers/browse-shared.css`:

```css
/* Compact actions displayed beside creator/provider metadata in detail modals. */
.browse-meta-action {
    appearance: none;
    border: 0;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    min-height: 24px;
    padding: 3px 5px;
    border-radius: var(--radius-sm);
    color: inherit;
    font: inherit;
    line-height: inherit;
    background: transparent;
    vertical-align: middle;
    transition: background 0.2s ease, opacity 0.2s ease;
}

.browse-meta-action:hover {
    background: rgba(255, 100, 100, 0.15);
}

.browse-meta-action i {
    color: #ff6b6b;
    transition: transform 0.2s ease;
}

.browse-meta-action:hover i {
    transform: scale(1.15);
}

.browse-meta-action.favorited {
    background: rgba(255, 100, 100, 0.1);
}

.browse-meta-action:disabled,
.browse-meta-action.loading {
    pointer-events: none;
    opacity: 0.6;
}
```

- [ ] **Step 4: Replace DataCat's grid-aware eligibility and state code**

Delete these grid-only declarations and functions from
`modules/providers/datacat/datacat-browse.js`:

```js
const datacatExternalCollectableById = new Map();
let datacatYoursProbeObserver = null;
function isDatacatExternalSearchHit(hit) { /* delete the whole function */ }
function probeDatacatExternalCollectable(characterId, hit = null) { /* delete */ }
function observeDatacatYoursProbes(grid) { /* delete */ }
function renderDatacatYoursCardButton(characterId, saved) { /* delete */ }
function updateDatacatCardYoursControl(characterId, hit = null) { /* delete */ }
```

Replace `canShowDatacatYoursControl` and `setDatacatYoursState` with:

```js
function canShowDatacatYoursControl(characterId, hit = null) {
    const id = String(characterId || '').trim();
    return !!(id && isDatacatYoursSyncEnabled() && isDatacatYoursCollectableHit(hit));
}

function setDatacatYoursState(characterId, saved) {
    const id = String(characterId || '').trim();
    if (!id) return;
    datacatYoursStateById.set(id, saved === true);

    const modalBtn = document.getElementById('datacatYoursBtn');
    if (modalBtn?.dataset?.datacatId === id) {
        const title = saved ? 'Remove from DataCat Yours' : 'Save to DataCat Yours';
        modalBtn.classList.toggle('favorited', saved === true);
        modalBtn.innerHTML = saved
            ? '<i class="fa-solid fa-heart"></i>'
            : '<i class="fa-regular fa-heart"></i>';
        modalBtn.title = title;
        modalBtn.setAttribute('aria-label', title);
    }

    syncDatacatFolderPickerMainRow(id, saved === true);
}
```

Remove every call to `updateDatacatCardYoursControl(...)`. Keep
`syncDatacatCollectableCharacter(...)`, but end it after updating the matching
in-memory entries:

```js
function syncDatacatCollectableCharacter(characterId, character) {
    const id = String(characterId || '').trim();
    if (!id || !character || typeof character !== 'object') return;

    const apply = (entry) => {
        if (!entry || String(getCharId(entry)) !== id) return;
        entry._fullCharacter = character;
        entry.isFullyExtractedInDb = true;
        entry.is_fully_extracted_in_db = true;
        entry.hasPartialExtraction = false;
        entry.has_partial_extraction = false;
        if (character.isCollected === true || character.viewer_is_collected === true || character.is_collected === true) {
            entry.isCollected = true;
            entry.viewer_is_collected = true;
            entry.is_collected = true;
        }
    };

    datacatCharacters.forEach(apply);
    datacatFollowingCharacters.forEach(apply);
}
```

- [ ] **Step 5: Remove the DataCat star from every grid-card path**

In `createDatacatCard`, remove `canSyncYours`, `savedToYours`, `yoursBtn`,
`needsYoursProbe`, the `data-datacat-probe` attribute, and `${yoursBtn}`.
On the standalone DataCat source branch, leave its existing footer content
(`statsHtml` and `dateInfo`) unchanged. The final card opening must begin:

```js
return `
    <div class="${cardClass}" data-datacat-id="${escapeHtml(String(charId))}" ${desc ? `title="${escapeHtml(desc)}"` : ''}>
        <div class="browse-card-image">
            <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/ai4.png'">
            ${nsfwBadge}
            ${sourceBadges.length > 0 ? `<div class="browse-feature-badges browse-feature-badges-tl">${sourceBadges.join('')}</div>` : ''}
            ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
        </div>
```

The standalone DataCat source branch does not declare `datacatBookmarks`; do
not introduce a Local Backup reference there. The required result is that no
DataCat Yours control is rendered on the grid.

Remove the `.datacat-yours-btn` branch from both the primary grid click
delegation and `_handleFollowingCardClick`. The standalone source branch has
no Local Backup grid handler to preserve.

Remove `observeDatacatYoursProbes(grid)` from `observeNewCards`,
`renderFollowing`, and any post-render callback.

- [ ] **Step 6: Move the DataCat save control into character metadata**

Replace the DataCat header template with:

```html
<p class="browse-char-meta">
    by <a id="datacatCharCreator" href="#" class="creator-link browse-meta-identity" title="Click to browse this creator's characters">Creator</a> •
    <button
        type="button"
        id="datacatYoursBtn"
        class="browse-meta-action"
        title="Save to DataCat Yours"
        aria-label="Save to DataCat Yours"
        style="display: none;"
    ><i class="fa-regular fa-heart"></i></button>
</p>
```

Delete the old `#datacatYoursBtn.action-btn` block from `.modal-controls`.
Keep `#datacatFolderBtn`, Open, Import, and Close in their existing order. The
AIO integration later preserves its separate Local Backup control until the
extended-bookmarks commit moves that control into metadata.

Delete `.datacat-yours-btn` and `.datacat-yours-modal-btn.saved` rules from
`modules/providers/datacat/datacat-browse.css`; `.browse-meta-action` owns the
new visual state.

- [ ] **Step 7: Mirror compact metadata actions into the mobile overflow**

In `app/library-mobile.js`, insert this block before the existing
`.browse-fav-toggle` fallback:

```js
const modal = controls.closest('.browse-char-modal');
modal?.querySelectorAll('.browse-meta-action').forEach(metaAction => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mobile-more-actions-item';

    const icon = metaAction.querySelector('i')?.cloneNode(true);
    if (icon) item.appendChild(icon);
    const label = metaAction.title || metaAction.getAttribute('aria-label') || 'Action';
    item.append(` ${label}`);
    item.title = label;

    if (metaAction.disabled || metaAction.classList.contains('disabled')) {
        item.disabled = true;
        item.classList.add('disabled');
    }

    item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeMenu();
        metaAction.click();
    });
    menu.appendChild(item);
});
```

Change the old favorite lookup so ChubAI and BotBooru are not duplicated:

```js
const favBtn = modal?.querySelector('.browse-fav-toggle:not(.browse-meta-action)');
```

- [ ] **Step 8: Run focused DataCat verification**

Run:

```powershell
node --test tests/datacat-compact-save-ux-static.test.mjs tests/datacat-folder-picker.test.mjs tests/datacat-account-retry.test.mjs
node --check modules/providers/datacat/datacat-browse.js
node --check app/library-mobile.js
git diff --check
```

Expected: all tests PASS, syntax checks exit 0, and `git diff --check` prints
nothing.

- [ ] **Step 9: Commit the DataCat presentation change**

```powershell
git add app/library-mobile.js modules/providers/browse-shared.css modules/providers/datacat/datacat-browse.js modules/providers/datacat/datacat-browse.css tests/datacat-compact-save-ux-static.test.mjs
git commit -m "fix(datacat): move Yours save into detail metadata"
```

---

### Task 2: DataCat single destination notification

**Branch/worktree:** `codex/datacat-account-sync` in `.worktrees/compact-datacat`

**Files:**
- Modify: `tests/datacat-folder-picker.test.mjs`
- Modify: `modules/providers/datacat/datacat-folder-picker.js:97-299`
- Modify: `modules/providers/datacat/datacat-browse.js:482-510`

**Interfaces:**
- Consumes: folder-picker hook `toggleMain(characterId, options)`.
- Produces: `formatDatacatFolderSuccess(folderName): string`,
  `formatDatacatFolderRemoval(folderName): string`, and
  `toggleDatacatYours(characterId, hit, { notify, destinationName })`.

- [ ] **Step 1: Add failing notification-copy tests**

Extend the import in `tests/datacat-folder-picker.test.mjs`:

```js
import {
    filterPickerFolders,
    buildPickerModel,
    applyDatacatFolderOrder,
    normalizeDatacatYoursFolderSelection,
    buildDatacatYoursFolderFetchOptions,
    formatDatacatFolderSuccess,
    formatDatacatFolderRemoval,
} from '../modules/providers/datacat/datacat-folder-picker.js';
```

Append:

```js
describe('DataCat folder notifications', () => {
    it('uses the site-style destination message', () => {
        assert.equal(formatDatacatFolderSuccess('WIFE!!!'), 'Saved to "WIFE!!!"');
        assert.equal(formatDatacatFolderSuccess(''), 'Saved to "Main"');
        assert.equal(formatDatacatFolderRemoval('WIFE!!!'), 'Removed from "WIFE!!!"');
    });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```powershell
node --test tests/datacat-folder-picker.test.mjs
```

Expected: FAIL because the two formatter exports do not exist.

- [ ] **Step 3: Add exact destination-message helpers**

Add to `modules/providers/datacat/datacat-folder-picker.js`:

```js
function normalizedFolderName(folderName) {
    return String(folderName || '').trim() || 'Main';
}

export function formatDatacatFolderSuccess(folderName) {
    return `Saved to "${normalizedFolderName(folderName)}"`;
}

export function formatDatacatFolderRemoval(folderName) {
    return `Removed from "${normalizedFolderName(folderName)}"`;
}
```

- [ ] **Step 4: Make nested Main collection silent**

Change the default hook contract and `ensureCollected`:

```js
let _hooks = {
    getMainSaved: () => false,
    toggleMain: async (_characterId, _options = {}) => {},
};

async function ensureCollected(el, characterId) {
    if (_hooks.getMainSaved(characterId)) {
        el.dataset.collected = 'true';
        return true;
    }
    await _hooks.toggleMain(characterId, { notify: false });
    const mainSaved = _hooks.getMainSaved(characterId);
    el.dataset.collected = mainSaved ? 'true' : 'false';
    if (!mainSaved) {
        showToast('DataCat folder sync failed: could not save to Yours first', 'error');
        return false;
    }
    return true;
}
```

- [ ] **Step 5: Replace overlapping folder success toasts**

Use exactly one success toast for each completed user action:

```js
// Moving from custom folders to Main
showToast(formatDatacatFolderSuccess('Main'), 'success');

// Adding/removing a custom folder membership
const title = row.querySelector('.datacat-folder-row-title')?.textContent || 'folder';
showToast(
    next ? formatDatacatFolderSuccess(title) : formatDatacatFolderRemoval(title),
    'success',
);
```

Replace the create-and-add flow with:

```js
const res = await createDatacatFolder({ title });
if (!res?.ok) throw new Error(res?.error || 'DataCat folder create failed');
invalidateDatacatFolderCache();
const newId = res.folder?.id != null ? String(res.folder.id) : null;
if (!newId) throw new Error('DataCat did not return the new folder id');
if (!await ensureCollected(el, characterId)) return;

const addRes = await setDatacatFolderMembership(newId, characterId, true);
if (!addRes?.ok) throw new Error(addRes?.error || 'DataCat folder update failed');
showToast(formatDatacatFolderSuccess(title), 'success');

if (_openEl === el) await loadAndRender(el, characterId, characterName);
```

Remove the old `Created ${title}.`, `Added ${characterName} to ${title}.`,
`Moved ${characterName} to Main.`, and
`${next ? 'Added' : 'Removed'} ...` success messages.

- [ ] **Step 6: Give direct heart saves the same one-toast contract**

Import `formatDatacatFolderSuccess` and `formatDatacatFolderRemoval` into
`datacat-browse.js`, then replace `toggleDatacatYours` with:

```js
async function toggleDatacatYours(
    characterId,
    hit = null,
    { notify = true, destinationName = 'Main' } = {},
) {
    const id = String(characterId || '').trim();
    if (!id) return;
    if (!isDatacatYoursSyncEnabled()) {
        showToast('Sign in to DataCat in Settings to sync Yours', 'warning');
        return;
    }
    if (!canShowDatacatYoursControl(id, hit)) {
        showToast('Extract this character first; DataCat saves extracted account characters to Yours automatically.', 'info');
        return;
    }
    if (datacatYoursPendingIds.has(id)) return;

    const wasSaved = getDatacatYoursState(id, hit);
    const nextSaved = !wasSaved;
    datacatYoursPendingIds.add(id);
    setDatacatYoursState(id, nextSaved);
    try {
        const result = await setDatacatYoursSaved(id, nextSaved);
        if (!result?.ok) throw new Error(result?.error || result?.reason || 'DataCat save failed');
        setDatacatYoursState(id, result.collected === true);
        refreshDatacatOnlyYoursFilterIfActive();
        if (notify) {
            showToast(
                result.collected
                    ? formatDatacatFolderSuccess(destinationName)
                    : formatDatacatFolderRemoval(destinationName),
                'success',
            );
        }
    } catch (err) {
        setDatacatYoursState(id, wasSaved);
        showToast(`DataCat Yours sync failed: ${err.message}`, 'error');
    } finally {
        datacatYoursPendingIds.delete(id);
    }
}
```

Pass picker options through the existing hook:

```js
toggleMain: (id, options = {}) =>
    toggleDatacatYours(id, findDatacatHitOrSelected(id), options),
```

- [ ] **Step 7: Run focused notification verification**

Run:

```powershell
node --test tests/datacat-folder-picker.test.mjs tests/datacat-compact-save-ux-static.test.mjs tests/datacat-account-retry.test.mjs
node --check modules/providers/datacat/datacat-folder-picker.js
node --check modules/providers/datacat/datacat-browse.js
git diff --check
```

Expected: all tests PASS and both syntax checks exit 0.

- [ ] **Step 8: Commit the DataCat notification change**

```powershell
git add modules/providers/datacat/datacat-folder-picker.js modules/providers/datacat/datacat-browse.js tests/datacat-folder-picker.test.mjs
git commit -m "fix(datacat): coalesce folder save notifications"
```

---

### Task 3: JannyAI compact account bookmark

**Branch/worktree:** `codex/jannyai-account-sync` in `.worktrees/compact-janny`

**Files:**
- Create: `tests/janny-compact-bookmark-ux-static.test.mjs`
- Modify: `modules/providers/janny/janny-browse.js:1588-1640`
- Modify: `modules/providers/janny/janny-browse.js:2752-2774`
- Modify: `modules/providers/browse-shared.css`
- Modify: `app/library-mobile.js:3738-3780`

**Interfaces:**
- Consumes: `jannyBookmarkIds`, `JANNY_BOOKMARK_UI_LIMIT`,
  `toggleSelectedJannyBookmark()`, and existing Janny account APIs.
- Produces: `button#jannyBookmarkBtn.browse-meta-action`, active class
  `favorited`, state-aware title/ARIA label, and generic mobile discovery.

- [ ] **Step 1: Write the failing JannyAI UX contract**

```js
// tests/janny-compact-bookmark-ux-static.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const browse = await readFile(
    new URL('../modules/providers/janny/janny-browse.js', import.meta.url),
    'utf8',
);
const css = await readFile(
    new URL('../modules/providers/browse-shared.css', import.meta.url),
    'utf8',
);
const mobile = await readFile(
    new URL('../app/library-mobile.js', import.meta.url),
    'utf8',
);

test('Janny account bookmark is a compact metadata action', () => {
    assert.match(
        browse,
        /<p class="browse-char-meta">[\s\S]{0,700}id="jannyBookmarkBtn"[\s\S]{0,250}browse-meta-action[\s\S]{0,250}fa-regular fa-bookmark/,
    );
    assert.doesNotMatch(
        browse,
        /<div class="modal-controls">[\s\S]{0,700}id="jannyBookmarkBtn"/,
    );
    assert.doesNotMatch(browse, /id="jannyBookmarkBtn" class="action-btn/);
});

test('Janny bookmark state remains icon-only and accessible', () => {
    assert.match(browse, /classList\.toggle\('favorited', isBookmarked\)/);
    assert.match(browse, /fa-solid fa-bookmark/);
    assert.match(browse, /fa-regular fa-bookmark/);
    assert.match(browse, /setAttribute\('aria-label', title\)/);
    assert.doesNotMatch(browse, /fa-solid fa-bookmark"><\/i> Bookmarked/);
    assert.doesNotMatch(browse, /fa-regular fa-bookmark"><\/i> Bookmark/);
});

test('Janny compact bookmark is available through mobile overflow', () => {
    assert.match(css, /\.browse-meta-action\s*{/);
    assert.match(mobile, /querySelectorAll\('\.browse-meta-action'\)/);
    assert.match(mobile, /metaAction\.click\(\)/);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```powershell
node --test tests/janny-compact-bookmark-ux-static.test.mjs
```

Expected: FAIL because Janny Bookmark is still a labelled `.action-btn` in
`.modal-controls`.

- [ ] **Step 3: Add the compact metadata-action CSS and mobile mirror**

Add this block to `modules/providers/browse-shared.css`:

```css
/* Compact actions displayed beside creator/provider metadata in detail modals. */
.browse-meta-action {
    appearance: none;
    border: 0;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    min-height: 24px;
    padding: 3px 5px;
    border-radius: var(--radius-sm);
    color: inherit;
    font: inherit;
    line-height: inherit;
    background: transparent;
    vertical-align: middle;
    transition: background 0.2s ease, opacity 0.2s ease;
}

.browse-meta-action:hover {
    background: rgba(255, 100, 100, 0.15);
}

.browse-meta-action i {
    color: #ff6b6b;
    transition: transform 0.2s ease;
}

.browse-meta-action:hover i {
    transform: scale(1.15);
}

.browse-meta-action.favorited {
    background: rgba(255, 100, 100, 0.1);
}

.browse-meta-action:disabled,
.browse-meta-action.loading {
    pointer-events: none;
    opacity: 0.6;
}
```

Add this exact generic block to `openMenuFor` in `app/library-mobile.js`:

```js
const modal = controls.closest('.browse-char-modal');
modal?.querySelectorAll('.browse-meta-action').forEach(metaAction => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mobile-more-actions-item';

    const icon = metaAction.querySelector('i')?.cloneNode(true);
    if (icon) item.appendChild(icon);
    const label = metaAction.title || metaAction.getAttribute('aria-label') || 'Action';
    item.append(` ${label}`);
    item.title = label;

    if (metaAction.disabled || metaAction.classList.contains('disabled')) {
        item.disabled = true;
        item.classList.add('disabled');
    }

    item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeMenu();
        metaAction.click();
    });
    menu.appendChild(item);
});

const favBtn = modal?.querySelector('.browse-fav-toggle:not(.browse-meta-action)');
```

Keep the existing Chub/BotBooru favorite fallback after that final line.

- [ ] **Step 4: Move Janny Bookmark into the metadata line**

Use this final header fragment:

```html
<p class="browse-char-meta">
    by <a id="jannyCharCreator" href="#" class="creator-link browse-meta-identity" title="Click to see all characters by this author">Creator</a> •
    <button
        type="button"
        id="jannyBookmarkBtn"
        class="browse-meta-action"
        title="Save to Janny bookmarks"
        aria-label="Save to Janny bookmarks"
    ><i class="fa-regular fa-bookmark"></i></button>
</p>
```

Delete the old labelled `#jannyBookmarkBtn.action-btn` from `.modal-controls`.
Keep Add to Collection, Open, Import, and Close unchanged.

- [ ] **Step 5: Make Janny state updates icon-only**

Replace `updateJannyBookmarkButton` with:

```js
function updateJannyBookmarkButton() {
    const btn = document.getElementById('jannyBookmarkBtn');
    if (!btn || !jannySelectedChar?.id) return;
    const id = String(jannySelectedChar.id);
    const isBookmarked = jannyBookmarkIds.has(id);
    const atLimit = !isBookmarked
        && (jannyBookmarkTotalCount || jannyBookmarkIds.size) >= JANNY_BOOKMARK_UI_LIMIT;
    const title = atLimit
        ? `Janny bookmark UI is at its max (${JANNY_BOOKMARK_UI_LIMIT}). Remove one on Janny first, or use collections.`
        : (isBookmarked ? 'Remove from Janny bookmarks' : 'Save to Janny bookmarks');

    btn.disabled = false;
    btn.classList.toggle('favorited', isBookmarked);
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = isBookmarked
        ? '<i class="fa-solid fa-bookmark"></i>'
        : '<i class="fa-regular fa-bookmark"></i>';
}
```

At the start of `toggleSelectedJannyBookmark`, replace the labelled loading
content with:

```js
if (btn) {
    btn.disabled = true;
    btn.classList.add('loading');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    btn.setAttribute('aria-label', 'Syncing Janny bookmark');
}
```

In the existing `finally`, remove `loading` before restoring authoritative
state:

```js
if (btn) btn.classList.remove('loading');
updateJannyBookmarkButton();
```

- [ ] **Step 6: Run focused Janny verification**

Run:

```powershell
node --test tests/janny-compact-bookmark-ux-static.test.mjs tests/janny-api-account.test.mjs tests/janny-collections-ux-static.test.mjs tests/janny-settings-account.test.mjs
node --check modules/providers/janny/janny-browse.js
node --check app/library-mobile.js
git diff --check
```

Expected: all tests PASS, syntax checks exit 0, and the collection-control tests
remain unchanged.

- [ ] **Step 7: Commit the JannyAI presentation change**

```powershell
git add app/library-mobile.js modules/providers/browse-shared.css modules/providers/janny/janny-browse.js tests/janny-compact-bookmark-ux-static.test.mjs
git commit -m "fix(janny): compact the account bookmark action"
```

---

### Task 4: Compact Local Backup on its original five providers

**Branch/worktree:** `extended-bookmarks` in `.worktrees/compact-bookmarks`

**Files:**
- Modify: `tests/extended-bookmarks-contract.test.mjs`
- Modify: `modules/providers/bookmark-module.js:165-344`
- Modify: `modules/providers/browse-shared.css:2730-2795`
- Modify: `app/library-mobile.js:3738-3780`
- Modify: `modules/providers/chartavern/chartavern-browse.js:1845-1858`
- Modify: `modules/providers/datacat/datacat-browse.js:4818-4836`
- Modify: `modules/providers/janny/janny-browse.js:2752-2774`
- Modify: `modules/providers/pygmalion/pygmalion-browse.js:2777-2791`
- Modify: `modules/providers/wyvern/wyvern-browse.js:593-608`

**Interfaces:**
- Consumes: bookmark factory configuration, `toggle(hitOrId)`,
  `syncModalState(hit)`, and each provider's existing modal event wiring.
- Produces: `renderMetaAction(): string`, compact Local Backup markup with
  `.browse-meta-action.cl-bookmark-btn`, and unchanged grid `renderCardBtn()`.

- [ ] **Step 1: Replace the Local Backup contract test with exact provider scope**

Keep the existing migration and snapshot tests, then replace the old
`local backups are the default treatment` test and add provider-source reads:

```js
const chartavernBrowseSource = await readFile(
    new URL('../modules/providers/chartavern/chartavern-browse.js', import.meta.url),
    'utf8',
);
const jannyBrowseSource = await readFile(
    new URL('../modules/providers/janny/janny-browse.js', import.meta.url),
    'utf8',
);
const pygmalionBrowseSource = await readFile(
    new URL('../modules/providers/pygmalion/pygmalion-browse.js', import.meta.url),
    'utf8',
);
const mobileSource = await readFile(
    new URL('../app/library-mobile.js', import.meta.url),
    'utf8',
);
const sharedCssSource = await readFile(
    new URL('../modules/providers/browse-shared.css', import.meta.url),
    'utf8',
);

test('Local Backup detail action is compact on exactly the original five providers', () => {
    const supported = [
        [chartavernBrowseSource, 'ctBookmarks'],
        [datacatBrowseSource, 'datacatBookmarks'],
        [jannyBrowseSource, 'jannyBookmarks'],
        [pygmalionBrowseSource, 'pygBookmarks'],
        [wyvernBrowseSource, 'wyvernBookmarks'],
    ];

    for (const [source, factoryName] of supported) {
        assert.match(
            source,
            new RegExp(`<p class="browse-char-meta">[\\s\\S]{0,900}\\$\\{${factoryName}\\.renderMetaAction\\(\\)\\}`),
        );
        assert.doesNotMatch(source, new RegExp(`${factoryName}\\.renderModalBtn\\(\\)`));
    }

    assert.match(bookmarkModuleSource, /\bfunction\s+renderMetaAction\b/);
    assert.match(bookmarkModuleSource, /class="browse-meta-action \$\{BOOKMARK_CLASS\}/);
    assert.doesNotMatch(bookmarkModuleSource, /\bfunction\s+renderModalBtn\b/);
    assert.match(sharedCssSource, /\.browse-meta-action\s*{/);
    assert.match(mobileSource, /querySelectorAll\('\.browse-meta-action'\)/);
});

test('Local Backup grid treatment and persistence stay unchanged', () => {
    assert.match(bookmarkModuleSource, /\bfunction\s+renderCardBtn\b/);
    assert.match(bookmarkModuleSource, /browse-card-stat \$\{BOOKMARK_CLASS\}/);
    assert.match(bookmarkModuleSource, /\bfunction\s+persist\b/);
    assert.match(bookmarkModuleSource, /\bfunction\s+renderBookmarksView\b/);
    assert.match(bookmarkModuleSource, /iconClass\s*=\s*'fa-floppy-disk'/);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```powershell
node --test tests/extended-bookmarks-contract.test.mjs
```

Expected: FAIL because the factory still exposes `renderModalBtn()` and all five
providers place it in `.modal-controls`.

- [ ] **Step 3: Replace the shared modal renderer with a metadata renderer**

In `modules/providers/bookmark-module.js`, replace `renderModalBtn` with:

```js
function renderMetaAction() {
    return `
        <button
            type="button"
            id="${modalBtnId}"
            class="browse-meta-action ${BOOKMARK_CLASS} ${legacyClass}"
            title="${escapeHtml(actionTitle)}"
            aria-label="${escapeHtml(actionTitle)}"
        >${renderIcon(false)}</button>
    `;
}
```

Update `syncUI` and `syncModalState` so each title change also updates ARIA:

```js
const title = favorited ? removeTitle : actionTitle;
btn.title = title;
btn.setAttribute('aria-label', title);
```

Export `renderMetaAction` in the factory return object and remove
`renderModalBtn`. Keep `renderCardBtn`, `attachModalBtn`, persistence, filters,
and bookmark-only views unchanged.

- [ ] **Step 4: Move Local Backup into each supported provider's metadata**

Use this placement in CharacterTavern:

```html
<p class="browse-char-meta">
    by <a id="ctCharCreator" class="browse-meta-identity" href="#" title="Click to see all characters by this author">Creator</a> •
    ${ctBookmarks.renderMetaAction()}
</p>
```

Use this placement in DataCat:

```html
<p class="browse-char-meta">
    by <a id="datacatCharCreator" href="#" class="creator-link browse-meta-identity" title="Click to browse this creator's characters">Creator</a> •
    ${datacatBookmarks.renderMetaAction()}
</p>
```

Use this placement in JannyAI:

```html
<p class="browse-char-meta">
    by <a id="jannyCharCreator" href="#" class="creator-link browse-meta-identity" title="Click to see all characters by this author">Creator</a> •
    ${jannyBookmarks.renderMetaAction()}
</p>
```

Use this placement in Pygmalion:

```html
<p class="browse-char-meta">
    by <a id="pygCharCreator" class="browse-meta-identity" href="#" title="Click to see all characters by this author">Creator</a>
    <a id="pygCreatorExternal" href="#" target="_blank" class="creator-external-link" title="Open author's Pygmalion profile"><i class="fa-solid fa-external-link"></i></a> •
    ${pygBookmarks.renderMetaAction()}
</p>
```

Use this placement in Wyvern:

```html
<p class="browse-char-meta">
    by <a id="wyvernCharCreator" class="browse-meta-identity" href="#" title="Click to see all characters by this author">Creator</a> •
    <span id="wyvernCharMessages" title="Messages"><i class="fa-solid fa-message"></i> 0</span> •
    <span id="wyvernCharLikes" title="Likes"><i class="fa-solid fa-heart"></i> 0</span> •
    ${wyvernBookmarks.renderMetaAction()}
</p>
```

Remove `${...Bookmarks.renderModalBtn()}` from each provider's
`.modal-controls`. Do not add Local Backup to any other provider.

- [ ] **Step 5: Replace modal Local Backup CSS with shared compact-action CSS**

Delete the `.action-btn.cl-bookmark-btn` rules. Add this shared compact-action
contract:

```css
/* Compact actions displayed beside creator/provider metadata in detail modals. */
.browse-meta-action {
    appearance: none;
    border: 0;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    min-height: 24px;
    padding: 3px 5px;
    border-radius: var(--radius-sm);
    color: inherit;
    font: inherit;
    line-height: inherit;
    background: transparent;
    vertical-align: middle;
    transition: background 0.2s ease, opacity 0.2s ease;
}

.browse-meta-action:hover {
    background: rgba(255, 100, 100, 0.15);
}

.browse-meta-action i {
    color: #ff6b6b;
    transition: transform 0.2s ease;
}

.browse-meta-action:hover i {
    transform: scale(1.15);
}

.browse-meta-action.favorited {
    background: rgba(255, 100, 100, 0.1);
}

.browse-meta-action:disabled,
.browse-meta-action.loading {
    pointer-events: none;
    opacity: 0.6;
}
```
Then add:


```css
.browse-meta-action.cl-bookmark-btn i {
    color: #ff6b6b;
}
```

Keep every `.browse-card-footer .cl-bookmark-btn` rule unchanged.

- [ ] **Step 6: Add the generic mobile mirror**

Insert this exact code before the existing Chub/BotBooru favorite fallback in
`app/library-mobile.js`:

```js
const modal = controls.closest('.browse-char-modal');
modal?.querySelectorAll('.browse-meta-action').forEach(metaAction => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'mobile-more-actions-item';

    const icon = metaAction.querySelector('i')?.cloneNode(true);
    if (icon) item.appendChild(icon);
    const label = metaAction.title || metaAction.getAttribute('aria-label') || 'Action';
    item.append(` ${label}`);
    item.title = label;

    if (metaAction.disabled || metaAction.classList.contains('disabled')) {
        item.disabled = true;
        item.classList.add('disabled');
    }

    item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeMenu();
        metaAction.click();
    });
    menu.appendChild(item);
});
```

Keep Chub/BotBooru behavior unchanged with:

```js
const favBtn = modal?.querySelector('.browse-fav-toggle:not(.browse-meta-action)');
```

- [ ] **Step 7: Run focused Local Backup verification**

Run:

```powershell
node --test tests/extended-bookmarks-contract.test.mjs
node --check modules/providers/bookmark-module.js
node --check app/library-mobile.js
node --check modules/providers/chartavern/chartavern-browse.js
node --check modules/providers/datacat/datacat-browse.js
node --check modules/providers/janny/janny-browse.js
node --check modules/providers/pygmalion/pygmalion-browse.js
node --check modules/providers/wyvern/wyvern-browse.js
git diff --check
```

Expected: the contract test PASSes, all syntax checks exit 0, and no whitespace
errors are reported.

- [ ] **Step 8: Commit the Local Backup presentation change**

```powershell
git add app/library-mobile.js modules/providers/bookmark-module.js modules/providers/browse-shared.css modules/providers/chartavern/chartavern-browse.js modules/providers/datacat/datacat-browse.js modules/providers/janny/janny-browse.js modules/providers/pygmalion/pygmalion-browse.js modules/providers/wyvern/wyvern-browse.js tests/extended-bookmarks-contract.test.mjs
git commit -m "fix(bookmarks): compact local backup detail actions"
```

---

### Task 5: Integrate DataCat changes into AIO

**Branch/worktree:** `aio-v6.7.0` in the primary workspace

**Files:**
- Integrate the files committed by Tasks 1 and 2.
- Preserve: `docs/superpowers/specs/2026-07-23-provider-detail-compact-actions-design.md`
- Preserve: `docs/superpowers/plans/2026-07-23-provider-detail-compact-actions.md`

**Interfaces:**
- Consumes: the two exact DataCat source commits identified by their commit subjects.
- Produces: one AIO commit prefixed `[datacat-account-sync]`.

- [ ] **Step 1: Resolve the two DataCat source commit IDs**

Run:

```powershell
$datacatUiCommit = git log codex/datacat-account-sync --format=%H --grep='^fix(datacat): move Yours save into detail metadata$' -n 1
$datacatToastCommit = git log codex/datacat-account-sync --format=%H --grep='^fix(datacat): coalesce folder save notifications$' -n 1
$datacatUiCommit
$datacatToastCommit
```

Expected: two non-empty 40-character commit IDs.

- [ ] **Step 2: Apply both DataCat commits without committing**

```powershell
git cherry-pick -n $datacatUiCommit
git cherry-pick -n $datacatToastCommit
```

If shared CSS or mobile hunks conflict, keep the complete
`.browse-meta-action` rule set (base, hover, icon, favorited, disabled, and
loading states) and the generic loop that clones every `.browse-meta-action`
into `.mobile-more-actions-item`. Preserve AIO's existing Local Backup and
Janny integration code outside those hunks.

- [ ] **Step 3: Run the DataCat AIO suite**

```powershell
node --test tests/datacat-compact-save-ux-static.test.mjs tests/datacat-folder-picker.test.mjs tests/datacat-account-retry.test.mjs tests/extended-bookmarks-contract.test.mjs
node --check modules/providers/datacat/datacat-browse.js
node --check modules/providers/datacat/datacat-folder-picker.js
node --check app/library-mobile.js
git diff --check
```

Expected: all tests PASS and syntax checks exit 0. The extended-bookmarks test
must confirm the Local Backup grid icon still exists after the DataCat star is
removed.

- [ ] **Step 4: Commit the prefixed DataCat AIO integration**

```powershell
git add app/library-mobile.js modules/providers/browse-shared.css modules/providers/datacat/datacat-browse.js modules/providers/datacat/datacat-browse.css modules/providers/datacat/datacat-folder-picker.js tests/datacat-compact-save-ux-static.test.mjs tests/datacat-folder-picker.test.mjs
git commit -m "[datacat-account-sync] Compact DataCat save UX"
```

---

### Task 6: Integrate JannyAI changes into AIO

**Branch/worktree:** `aio-v6.7.0` in the primary workspace

**Files:**
- Integrate the files committed by Task 3.

**Interfaces:**
- Consumes: the JannyAI source commit identified by its exact subject.
- Produces: one AIO commit prefixed `[jannyai-account-sync]`.

- [ ] **Step 1: Resolve and apply the JannyAI source commit**

```powershell
$jannyCommit = git log codex/jannyai-account-sync --format=%H --grep='^fix(janny): compact the account bookmark action$' -n 1
$jannyCommit
git cherry-pick -n $jannyCommit
```

Expected: one non-empty commit ID. If `browse-shared.css` or
`library-mobile.js` reports an already-applied conflict, keep the generic
metadata-action implementation already integrated by Task 5 and stage the
resolved files.

- [ ] **Step 2: Confirm DataCat and Janny provider controls coexist with the current AIO**

After the cherry-pick:

- DataCat metadata still contains exactly one
  `button#datacatYoursBtn.browse-meta-action` with a heart icon.
- Janny metadata contains exactly one
  `button#jannyBookmarkBtn.browse-meta-action` with a bookmark icon.
- Janny's Add to Collection control remains in `.modal-controls`.
- The existing `${jannyBookmarks.renderModalBtn()}` Local Backup control
  remains in `.modal-controls` until the extended-bookmarks integration
  migrates the factory and all five consumers.
- No second DataCat Yours or Janny account bookmark is introduced.

- [ ] **Step 3: Run the JannyAI AIO suite**

```powershell
node --test tests/janny-compact-bookmark-ux-static.test.mjs tests/janny-api-account.test.mjs tests/janny-collections-ux-static.test.mjs tests/janny-settings-account.test.mjs
node --check modules/providers/janny/janny-browse.js
node --check app/library-mobile.js
git diff --check
```

Expected: all tests PASS, Add to Collection remains in `.modal-controls`, and
the account bookmark is icon-only.

- [ ] **Step 4: Commit the prefixed JannyAI AIO integration**

```powershell
git add app/library-mobile.js modules/providers/browse-shared.css modules/providers/janny/janny-browse.js tests/janny-compact-bookmark-ux-static.test.mjs
git commit -m "[jannyai-account-sync] Compact JannyAI bookmark UX"
```

---

### Task 7: Integrate compact Local Backup into AIO

**Branch/worktree:** `aio-v6.7.0` in the primary workspace

**Files:**
- Integrate the files committed by Task 4.

**Interfaces:**
- Consumes: the extended-bookmarks source commit identified by its exact subject.
- Produces: one AIO commit prefixed `[extended-bookmarks]` and the final combined metadata layout.

- [ ] **Step 1: Resolve and apply the extended-bookmarks source commit**

```powershell
$bookmarksCommit = git log extended-bookmarks --format=%H --grep='^fix(bookmarks): compact local backup detail actions$' -n 1
$bookmarksCommit
git cherry-pick -n $bookmarksCommit
```

Expected: one non-empty commit ID. Resolve expected DataCat/Janny template
conflicts by retaining both provider-native compact actions and exactly one
`${...Bookmarks.renderMetaAction()}` in each metadata line.

- [ ] **Step 2: Enforce the final combined DataCat and Janny markup**

DataCat must contain:

```html
<p class="browse-char-meta">
    by <a id="datacatCharCreator" href="#" class="creator-link browse-meta-identity" title="Click to browse this creator's characters">Creator</a> •
    <button type="button" id="datacatYoursBtn" class="browse-meta-action" title="Save to DataCat Yours" aria-label="Save to DataCat Yours" style="display: none;"><i class="fa-regular fa-heart"></i></button> •
    ${datacatBookmarks.renderMetaAction()}
</p>
```

JannyAI must contain:

```html
<p class="browse-char-meta">
    by <a id="jannyCharCreator" href="#" class="creator-link browse-meta-identity" title="Click to see all characters by this author">Creator</a> •
    <button type="button" id="jannyBookmarkBtn" class="browse-meta-action" title="Save to Janny bookmarks" aria-label="Save to Janny bookmarks"><i class="fa-regular fa-bookmark"></i></button> •
    ${jannyBookmarks.renderMetaAction()}
</p>
```

Neither provider may contain a second Local Backup button in
`.modal-controls`.

- [ ] **Step 3: Run the complete automated suite**

```powershell
node --test tests/*.test.mjs
node --check app/library-mobile.js
node --check modules/providers/bookmark-module.js
node --check modules/providers/datacat/datacat-browse.js
node --check modules/providers/datacat/datacat-folder-picker.js
node --check modules/providers/janny/janny-browse.js
git diff --check
```

Expected: every test PASSes, syntax checks exit 0, and no whitespace errors are
reported.

- [ ] **Step 4: Commit the prefixed Local Backup AIO integration**

```powershell
git add app/library-mobile.js modules/providers/bookmark-module.js modules/providers/browse-shared.css modules/providers/chartavern/chartavern-browse.js modules/providers/datacat/datacat-browse.js modules/providers/janny/janny-browse.js modules/providers/pygmalion/pygmalion-browse.js modules/providers/wyvern/wyvern-browse.js tests/extended-bookmarks-contract.test.mjs
git commit -m "[extended-bookmarks] Compact local backup detail actions"
```

---

### Task 8: Desktop, mobile, and final branch verification

**Branch/worktree:** `aio-v6.7.0` in the primary workspace

**Files:**
- Verify only; if a defect is found, return the fix to its source branch task first, then reintegrate it with the matching AIO prefix.

**Interfaces:**
- Consumes: the three prefixed AIO commits from Tasks 5-7.
- Produces: verified desktop/mobile behavior and a clean AIO worktree.

- [ ] **Step 1: Verify commit topology and cleanliness**

```powershell
git status --short --branch
git log --oneline --decorate -8
```

Expected:

- clean `aio-v6.7.0` worktree;
- one `[datacat-account-sync]` compact UX commit;
- one `[jannyai-account-sync]` compact UX commit;
- one `[extended-bookmarks]` compact UX commit;
- the approved spec and plan commits remain in history.

- [ ] **Step 2: Verify DataCat desktop behavior in the in-app browser**

At the normal desktop viewport:

1. Open Online → DataCat.
2. Confirm no DataCat Yours star overlays any grid card.
3. Confirm the Local Backup floppy-disk icon remains in card footers.
4. Open an eligible character.
5. Confirm the metadata line contains a heart and Local Backup icon.
6. Confirm Folder, Open, Import, and Close remain in the action area.
7. Toggle the heart and verify regular/solid state and one
   `Saved to "Main"` notification.
8. Save to a custom folder and verify exactly one
   `Saved to "<folder name>"` notification.

- [ ] **Step 3: Verify JannyAI desktop behavior**

1. Open Online → JannyAI.
2. Open a character.
3. Confirm the metadata line contains an account bookmark and Local Backup icon.
4. Confirm Add to Collection, Open, Import, and Close remain separate.
5. Toggle the account bookmark and verify regular/solid icon, tooltip, and
   existing bookmark-limit behavior.

- [ ] **Step 4: Verify Local Backup provider scope**

Open one character detail in each provider:

- CharacterTavern
- DataCat
- JannyAI
- Pygmalion
- Wyvern

Expected: each has one compact Local Backup icon in metadata and no labelled
Local Backup action button.

Check ChubAI, BotBooru, and MasqueradeAI.

Expected: no Local Backup control was added and their existing detail actions
are unchanged.

- [ ] **Step 5: Repeat responsive checks at the mobile breakpoint**

Use the in-app browser viewport capability at a representative phone size such
as 390×844:

1. Confirm DataCat grid cards have no provider-native star.
2. Confirm supported Local Backup grid icons remain.
3. Open DataCat and JannyAI details.
4. Open the existing kebab/overflow menu.
5. Confirm each compact metadata action appears once with its current icon and
   tooltip-derived label.
6. Activate each item and verify it delegates to the hidden metadata control.
7. Confirm ChubAI/BotBooru Favorite still appears once through the legacy
   `.browse-fav-toggle` fallback.

- [ ] **Step 6: Run final automated verification**

```powershell
node --test tests/*.test.mjs
git diff --check
git status --short --branch
```

Expected: all tests PASS, `git diff --check` prints nothing, and the worktree is
clean.
