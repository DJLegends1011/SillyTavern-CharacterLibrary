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

function renderPickerBody(el, model, characterId, characterName) {
    el.innerHTML = `
        <div class="datacat-folder-picker-heading">Save to folder</div>
        ${rowHtml({ id: '__main__', title: 'Main', checked: model.mainChecked, icon: 'fa-star' })}
        ${model.rows.map(r => rowHtml(r)).join('')}
        <div class="datacat-folder-create-row">
            <input type="text" class="datacat-folder-create-input" placeholder="New folder name" maxlength="120">
            <button type="button" class="datacat-folder-create-btn" disabled>Save</button>
        </div>`;
    wireRows(el, characterId, characterName);
}

function renderPickerError(el, message, characterId, characterName, { retry = true } = {}) {
    el.innerHTML = `
        <div class="datacat-folder-picker-heading">Save to folder</div>
        <div class="datacat-folder-picker-error">${escapeHtml(message)}</div>
        ${retry ? '<button type="button" class="datacat-folder-retry-btn">Retry</button>' : ''}`;
    el.querySelector('.datacat-folder-retry-btn')?.addEventListener('click', () => loadAndRender(el, characterId, characterName));
}

async function loadAndRender(el, characterId, characterName) {
    el.innerHTML = '<div class="datacat-folder-picker-heading">Save to folder</div><div class="datacat-folder-picker-loading"><i class="fa-solid fa-spinner fa-spin"></i></div>';
    try {
        if (!_folderCache) {
            const res = await fetchDatacatFolders();
            if (!res?.ok) throw new Error(res?.error || 'Could not load folders');
            _folderCache = filterPickerFolders(res.folders);
        }
        const status = await fetchDatacatYoursStatus(characterId);
        const model = buildPickerModel({
            folders: _folderCache,
            collected: status?.ok ? status.collected === true : _hooks.getMainSaved(characterId),
            folderIds: status?.ok ? status.folderIds : [],
        });
        if (_openEl !== el) return; // closed or reopened for another character while loading
        renderPickerBody(el, model, characterId, characterName);
    } catch (err) {
        if (_openEl !== el) return;
        const msg = /session|auth|account|401/i.test(err.message)
            ? 'Session expired - check Settings > Online > DataCat'
            : err.message;
        renderPickerError(el, msg, characterId, characterName);
    }
}

/**
 * DataCat's server rejects folder membership changes for characters not
 * already collected to Main/Yours. Ensure the character is collected first,
 * updating the picker's Main row to match. Returns true when the character
 * is collected by the end (either already was, or the save succeeded).
 * @param {HTMLElement} el picker root element
 * @param {string} characterId
 * @returns {Promise<boolean>}
 */
async function ensureCollected(el, characterId) {
    const mainRow = el.querySelector('.datacat-folder-row[data-folder-id="__main__"]');
    if (mainRow?.classList.contains('checked')) return true;
    await _hooks.toggleMain(characterId);
    const mainSaved = _hooks.getMainSaved(characterId);
    mainRow?.classList.toggle('checked', mainSaved);
    if (!mainSaved) {
        showToast('DataCat folder sync failed: could not save to Yours first', 'error');
        return false;
    }
    return true;
}

/**
 * Sync the open folder picker's Main row checkmark after an external change
 * to a character's Yours/Main status (e.g. the grid-card star). No-op unless
 * the picker is currently open for this character.
 * @param {string|number} characterId
 * @param {boolean} saved
 */
export function syncDatacatFolderPickerMainRow(characterId, saved) {
    if (!_openEl || _openCharId !== String(characterId)) return;
    const mainRow = _openEl.querySelector('.datacat-folder-row[data-folder-id="__main__"]');
    mainRow?.classList.toggle('checked', saved === true);
}

function wireRows(el, characterId, characterName) {
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
                    await _hooks.toggleMain(characterId);
                    row.classList.toggle('checked', _hooks.getMainSaved(characterId));
                } else {
                    if (next) {
                        // DataCat's server rejects folder membership for characters not
                        // already collected to Main/Yours. Auto-save to Main first.
                        const collected = await ensureCollected(el, characterId);
                        if (!collected) {
                            row.classList.toggle('checked', wasChecked); // revert
                            return;
                        }
                    }
                    const res = await setDatacatFolderMembership(folderId, characterId, next);
                    if (!res?.ok) throw new Error(res?.error || 'DataCat folder update failed');
                    const title = row.querySelector('.datacat-folder-row-title')?.textContent || 'folder';
                    showToast(`${next ? 'Added' : 'Removed'} ${characterName} ${next ? 'to' : 'from'} ${title}.`, 'success');
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
            if (newId && await ensureCollected(el, characterId)) {
                const addRes = await setDatacatFolderMembership(newId, characterId, true);
                if (addRes?.ok) showToast(`Added ${characterName} to ${title}.`, 'success');
            }
            if (_openEl === el) await loadAndRender(el, characterId, characterName);
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

    const name = String(characterName || 'character');
    _openCharId = id;
    _openCharName = name;
    const el = document.createElement('div');
    el.className = 'datacat-folder-picker';
    document.body.appendChild(el);
    _openEl = el;

    _outsideHandler = (e) => {
        if (el.contains(e.target) || anchor.contains(e.target)) return;
        closeDatacatFolderPicker();
    };
    document.addEventListener('pointerdown', _outsideHandler, true);

    await loadAndRender(el, id, name);
    if (_openEl === el) positionPicker(el, anchor);
}
