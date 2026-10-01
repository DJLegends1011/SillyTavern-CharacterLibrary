// JannyAI collections for the Online tab: the public directory, the account's own
// collections, a collector's public collections, one collection's characters, and the
// preview modal's add-to-collection picker.
//
// Directory cards are the shared browse-collection-card (cover mosaic on the BrowseView
// image loader); a collection's characters are ordinary Janny browse cards. Grid fetches
// paint renderSkeletonGrid first, so every surface follows the shimmer contract.
//
// Screens form a stack (nav): a directory at the root, then detail or collector views
// pushed on top, so Back always returns to exactly where you were. Account-bound work
// re-checks the host's account generation after every await: a login swap mid-request
// must never write the old account's data into the new one.
//
// janny-browse.js owns the account, the preview modal and the API imports; it hands them
// in through createJannyCollections(host).

import CoreAPI from '../../core-api.js';
import { formatNumber, skeletonLines } from '../provider-utils.js';
import { renderCollectionCard, wireCollectionGrid } from '../browse-collection-card.js';
import { orderJannyCollectionCharacters, orderByIds } from './janny-collection-order.js';
import { collectionEntryCharacterId, collectionEntryMatchesCharacter } from './janny-collection-membership.js';
import {
    COLLECTION_COVER_LIMIT as COVER_LIMIT,
    normalizeJannyCharacter,
    embeddedEntries,
    collectionCount,
    isCollectionPrivate,
    collectionCoverSources,
    parseJannyCharacterId,
} from './janny-collection-model.js';

const { escapeHtml, showToast, debugLog, getSetting, renderSkeletonGrid, showConfirm, initCustomSelect } = CoreAPI;

const SKELETON_COLLECTIONS = 8;

// ========================================
// HELPERS
// ========================================

function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
}

function arrangeCharacters(characters) {
    return orderJannyCollectionCharacters(characters, {
        randomize: getSetting('jannyRandomizeCollectionCards') === true,
    });
}

// ========================================
// CONTROLLER
// ========================================

/**
 * @param {Object} host
 * @param {Object} host.api - fetchCollections, fetchCollectionCharacters, fetchPublicCollections,
 *   fetchPublicCollection, fetchCollectorCollections, fetchCharactersByIds, fetchPublicCharactersByIds,
 *   createCollection, updateCollection, deleteCollection, addCharacterToCollection,
 *   removeCharacterFromCollection, sessionStatus
 * @param {string} host.siteBase - https://jannyai.com
 * @param {() => import('../browse-view.js').BrowseView} host.getView
 * @param {() => number} host.getGeneration - bumps whenever the JannyAI account changes
 * @param {() => boolean} host.isAccountActive
 * @param {() => Promise<boolean>} host.ensureAccountReady - toasts + opens Settings when not ready
 * @param {(err: Error, generation: number) => void} host.handleAccountFailure
 * @param {(err: Error) => string} host.describeError
 * @param {(src: string) => string} host.resolveAvatarUrl
 * @param {(character: Object) => string} host.createCard - Janny browse card HTML
 * @param {() => Object|null} host.getSelectedCharacter - the character open in the preview
 * @param {(character: Object) => void} host.openPreview
 * @param {() => void} host.closePreview
 * @param {(name: string) => void} host.filterByAuthor
 */
export function createJannyCollections(host) {
    const api = host.api;
    const el = (id) => document.getElementById(id);
    const generation = () => host.getGeneration();
    const selectedId = () => String(host.getSelectedCharacter()?.id || '');

    const freshOwned = (signedOut = false) => ({ items: [], loaded: false, loading: false, error: '', promise: null, signedOut });
    const freshPicker = () => ({ open: false, memberIds: new Set(), checkedFor: '', error: '', pending: new Set() });

    let rootTab = 'public';
    /** @type {Array<Object>} screen stack; the last entry is on screen */
    let nav = [];
    let createFormOpen = false;
    let creating = false;
    let hydrateToken = 0;
    let pickerDocumentWired = false;
    const pub = { items: [], page: 1, hasMore: true, loading: false, loaded: false, error: '', sort: 'latest', token: 0 };
    let owned = freshOwned();
    /** owned collection id -> Set of member character ids, filled by every characters fetch */
    let members = new Map();
    let picker = freshPicker();

    const current = () => nav[nav.length - 1] || null;
    const isOwnedDetail = (v) => v?.kind === 'detail' && v.source === 'owned';

    function isOpen() {
        const section = el('jannyCollectionsSection');
        return !!section && !section.classList.contains('hidden');
    }

    // ── Account-bound data ───────────────────────────────

    async function fetchMembers(collectionId, gen) {
        const entries = await api.fetchCollectionCharacters(collectionId);
        const list = Array.isArray(entries) ? entries : [];
        if (gen === generation()) {
            members.set(String(collectionId), new Set(list.map(collectionEntryCharacterId).filter(Boolean).map(String)));
        }
        return list;
    }

    /**
     * Normalized characters for a member list, in list order. Entries can be full characters
     * or bare relation rows ({ characterId }); a row with neither a name nor an avatar is only
     * an id, so its details are fetched (at most `limit` characters in total).
     */
    async function hydrateEntries(entries, gen, limit = Infinity) {
        const rows = entries.map(entry => {
            const c = normalizeJannyCharacter(entry);
            if (!c) return { id: collectionEntryCharacterId(entry), c: null };
            return { id: String(c.id), c: c.avatar || c.name !== 'Unknown' ? c : null };
        }).filter(row => row.id);
        const known = rows.filter(row => row.c).length;
        const missing = rows.filter(row => !row.c).map(row => row.id).slice(0, Math.max(0, limit - known));
        if (missing.length) {
            const fetched = await api.fetchCharactersByIds(missing);
            if (gen === generation()) {
                const byId = new Map(fetched.map(normalizeJannyCharacter).filter(Boolean).map(c => [String(c.id), c]));
                for (const row of rows) if (!row.c && byId.has(row.id)) row.c = byId.get(row.id);
            }
        }
        return rows.map(row => row.c).filter(Boolean);
    }

    function loadOwned(force = false) {
        if (owned.loading) return owned.promise;
        if (owned.loaded && !force) return Promise.resolve(owned.items);
        const gen = generation();
        owned.loading = true;
        owned.error = '';
        owned.signedOut = false;
        paintOwned();
        owned.promise = (async () => {
            try {
                if (!await host.ensureAccountReady() || gen !== generation()) {
                    if (gen === generation()) owned.signedOut = true;
                    return [];
                }
                const items = await api.fetchCollections();
                if (gen !== generation()) return [];
                owned.items = Array.isArray(items) ? items : [];
                owned.loaded = true;
                hydrateOwnedCovers().catch(err => debugLog('[JannyCollections] cover hydration failed:', err.message));
                return owned.items;
            } catch (err) {
                if (gen !== generation()) return [];
                host.handleAccountFailure(err, gen);
                const message = host.describeError(err);
                if (gen === generation()) owned.error = message;
                showToast(`Could not load your Janny collections: ${message}`, 'error', 8000);
                return [];
            } finally {
                if (gen === generation()) {
                    owned.loading = false;
                    owned.promise = null;
                    paintOwned();
                    renderPicker();
                }
            }
        })();
        return owned.promise;
    }

    // /api/collections/mine carries no images, so fill each card's mosaic from its members,
    // one collection at a time, swapping just that card when its covers arrive.
    async function hydrateOwnedCovers() {
        const token = ++hydrateToken;
        const gen = generation();
        for (const collection of owned.items) {
            if (!collection?.id || !(collectionCount(collection) > 0) || collectionCoverSources(collection).length) continue;
            try {
                const entries = await fetchMembers(collection.id, gen);
                if (token !== hydrateToken || gen !== generation()) return;
                const chars = await hydrateEntries(entries, gen, COVER_LIMIT);
                if (token !== hydrateToken || gen !== generation()) return;
                const covers = arrangeCharacters(chars.filter(c => c.avatar)).slice(0, COVER_LIMIT);
                if (!covers.length) continue;
                collection.coverCharacters = covers;
                replaceOwnedCard(collection);
            } catch (err) {
                if (gen !== generation()) return;
                host.handleAccountFailure(err, gen);
                debugLog('[JannyCollections] cover hydration failed:', err.message);
                if (gen !== generation()) return;
            }
        }
    }

    async function loadPublic({ reset = false } = {}) {
        if (reset) {
            pub.token++;
            Object.assign(pub, { items: [], page: 1, hasMore: true, loading: false, loaded: false, error: '' });
        }
        if (pub.loading || (!reset && !pub.hasMore)) return;
        const token = pub.token;
        const append = pub.items.length > 0;
        pub.loading = true;
        if (append) updateLoadMore(); else paintIfTop('public');
        try {
            const data = await api.fetchPublicCollections({ sort: pub.sort, page: pub.page });
            if (token !== pub.token) return;
            const seen = new Set(pub.items.map(c => String(c.path || c.id)));
            const fresh = [];
            for (const collection of (Array.isArray(data?.collections) ? data.collections : [])) {
                const key = String(collection?.path || collection?.id || '');
                if (!key || seen.has(key)) continue;
                seen.add(key);
                fresh.push(collection);
            }
            pub.items.push(...fresh);
            // A page that adds nothing new ends paging, so a looping "next" link can't spin forever
            pub.hasMore = !!data?.hasMore && fresh.length > 0;
            pub.page += 1;
            pub.loaded = true;
            pub.error = '';
            pub.loading = false;
            if (current()?.kind !== 'public') return;
            if (append) appendDirectoryCards(fresh, 'public');
            else paintDirectoryGrid(current());
        } catch (err) {
            if (token !== pub.token) return;
            pub.loading = false;
            const message = host.describeError(err);
            if (!append) pub.error = message;
            showToast(`Could not load public Janny collections: ${message}`, 'error', 8000);
            if (current()?.kind !== 'public') return;
            if (append) updateLoadMore(); else paintDirectoryGrid(current());
        }
    }

    async function loadCollector(view) {
        const token = view.token = (view.token || 0) + 1;
        view.loading = true;
        view.error = '';
        if (current() === view) { renderHeader(view); paintDirectoryGrid(view); }
        try {
            const data = await api.fetchCollectorCollections(view.name);
            if (token !== view.token) return;
            view.items = Array.isArray(data?.collections) ? data.collections : [];
        } catch (err) {
            if (token !== view.token) return;
            view.error = host.describeError(err);
            showToast(`Could not load collections by ${view.name}: ${view.error}`, 'error', 8000);
        } finally {
            if (token === view.token) {
                view.loading = false;
                if (current() === view) { renderHeader(view); paintDirectoryGrid(view); }
            }
        }
    }

    async function loadDetail(view) {
        const token = view.token = (view.token || 0) + 1;
        const gen = generation();
        view.loading = true;
        view.error = '';
        if (current() === view) paintCharGrid(view);
        try {
            if (view.source === 'owned') {
                if (!await host.ensureAccountReady() || gen !== generation()) {
                    if (token === view.token && gen === generation()) view.error = 'Your JannyAI login is needed to open this collection.';
                    return;
                }
                const entries = await fetchMembers(view.key, gen);
                if (token !== view.token || gen !== generation()) return;
                const chars = await hydrateEntries(entries, gen);
                if (token !== view.token || gen !== generation()) return;
                view.collection = owned.items.find(c => String(c.id) === view.key) || view.collection;
                view.characters = arrangeCharacters(chars);
            } else {
                const data = await api.fetchPublicCollection(view.key);
                if (token !== view.token) return;
                const ids = Array.isArray(data?.characterIds) ? data.characterIds : [];
                const fetched = await api.fetchPublicCharactersByIds(ids);
                if (token !== view.token) return;
                view.collection = { ...view.collection, ...(data?.collection || {}), path: view.key };
                // characterIds are in page order; get-characters answers in its own
                view.characters = arrangeCharacters(orderByIds(fetched.map(normalizeJannyCharacter).filter(Boolean), ids));
            }
        } catch (err) {
            if (token !== view.token) return;
            if (view.source === 'owned') {
                if (gen !== generation()) return;
                host.handleAccountFailure(err, gen);
                if (gen !== generation()) return;
            }
            view.error = host.describeError(err);
        } finally {
            if (token === view.token) {
                view.loading = false;
                if (current() === view) { renderDetailHeader(view); paintCharGrid(view); }
            }
        }
    }

    // ── Membership (shared by the picker and the editor) ──

    /** Apply a confirmed add/remove everywhere it shows: picker, caches, counts, covers, open views. */
    function applyMembership(collectionId, character, isMember, { countChanged = true } = {}) {
        const cid = String(collectionId);
        const charId = String(character?.id || '');
        if (!charId) return;
        if (selectedId() === charId) {
            if (isMember) picker.memberIds.add(cid); else picker.memberIds.delete(cid);
        }
        const set = members.get(cid);
        if (set) { if (isMember) set.add(charId); else set.delete(charId); }

        const collection = owned.items.find(c => String(c.id) === cid);
        if (collection) {
            const entries = embeddedEntries(collection);
            if (entries) {
                // Embedded lists are both the count and the membership source; keep them true
                const has = entries.some(e => collectionEntryMatchesCharacter(e, charId));
                if (isMember && !has) entries.push({ characterId: charId });
                if (!isMember && has) {
                    const kept = entries.filter(e => !collectionEntryMatchesCharacter(e, charId));
                    entries.splice(0, entries.length, ...kept);
                }
            } else if (countChanged) {
                const next = Math.max(0, (collectionCount(collection) || 0) + (isMember ? 1 : -1));
                collection.characterCount = next;
                if (collection._count && typeof collection._count === 'object') collection._count.collectionCharacters = next;
            }
            if (Array.isArray(collection.coverCharacters)) {
                const covers = collection.coverCharacters.filter(c => String(c.id) !== charId);
                const normalized = isMember ? normalizeJannyCharacter(character) : null;
                if (normalized?.avatar && covers.length < COVER_LIMIT) covers.push(normalized);
                collection.coverCharacters = covers;
            }
            replaceOwnedCard(collection);
        }

        for (const view of nav) {
            if (!isOwnedDetail(view) || view.key !== cid || !Array.isArray(view.characters)) continue;
            const present = view.characters.some(c => String(c.id) === charId);
            if (isMember && !present) {
                const normalized = normalizeJannyCharacter(character);
                if (normalized) view.characters = [...view.characters, normalized];
            } else if (!isMember && present) {
                view.characters = view.characters.filter(c => String(c.id) !== charId);
            }
            if (current() === view) { renderDetailBanner(view); paintCharGrid(view); }
        }
    }

    /**
     * JannyAI answers an add of a character that's already in the collection with a 401,
     * which looks exactly like a rejected login. The browser transport has spent its one
     * recovery attempt by now, so ask the browser: only a still-active session plus a
     * re-fetch that shows the character present counts as a duplicate. Anything else stays
     * a login failure and fails closed.
     */
    async function isDuplicateAdd(err, { wasMember, collectionId, characterId, gen }) {
        if (wasMember || err?.status !== 401) return false;
        try {
            const status = await api.sessionStatus();
            if (gen !== generation() || status?.active !== true) return false;
            const entries = await fetchMembers(collectionId, gen);
            if (gen !== generation()) return false;
            return entries.some(entry => collectionEntryMatchesCharacter(entry, characterId));
        } catch (checkErr) {
            debugLog('[JannyCollections] duplicate-add membership check failed:', checkErr.message);
            return false;
        }
    }

    // ── Preview picker ───────────────────────────────────

    async function refreshMembership() {
        const gen = generation();
        const charId = selectedId();
        if (!charId || !owned.loaded) return picker.memberIds;
        const found = new Set();
        for (const collection of owned.items) {
            const cid = String(collection?.id || '');
            if (!cid) continue;
            const entries = embeddedEntries(collection);
            if (entries) {
                if (entries.some(e => collectionEntryMatchesCharacter(e, charId))) found.add(cid);
                continue;
            }
            if (members.has(cid)) {
                if (members.get(cid).has(charId)) found.add(cid);
                continue;
            }
            if (!(collectionCount(collection) > 0)) continue;
            try {
                const list = await fetchMembers(cid, gen);
                if (gen !== generation() || selectedId() !== charId) return picker.memberIds;
                if (list.some(e => collectionEntryMatchesCharacter(e, charId))) found.add(cid);
            } catch (err) {
                if (gen !== generation()) return picker.memberIds;
                host.handleAccountFailure(err, gen);
                if (gen === generation() && selectedId() === charId) picker.error = host.describeError(err);
                debugLog('[JannyCollections] membership check failed:', err.message);
                return picker.memberIds;
            }
        }
        if (gen !== generation() || selectedId() !== charId) return picker.memberIds;
        picker.memberIds = found;
        picker.checkedFor = charId;
        picker.error = '';
        return picker.memberIds;
    }

    function renderPicker() {
        const menu = el('jannyCollectionDropdown');
        if (!menu) return;
        menu.classList.toggle('hidden', !picker.open);
        el('jannyCollectionDropdownBtn')?.setAttribute('aria-expanded', String(picker.open));
        if (!picker.open) return;

        const title = '<div class="janny-collection-picker-title">Add to collection</div>';
        const note = (text) => `<div class="janny-collection-picker-empty">${escapeHtml(text)}</div>`;
        const newRow = `<button type="button" class="janny-collection-picker-row janny-collection-picker-new" data-picker-action="new"><i class="fa-solid fa-folder-plus"></i><span class="janny-collection-picker-name">New collection...</span></button>`;

        if (!host.isAccountActive()) {
            menu.innerHTML = title + note('Install your browser-owned login in JannyAI Settings to use your collections.');
            return;
        }
        const error = picker.error || (!owned.loaded && owned.error);
        if (error) {
            menu.innerHTML = title + note(error);
            return;
        }
        if (!owned.loaded || picker.checkedFor !== selectedId()) {
            menu.innerHTML = `${title}<div class="janny-collection-picker-loading" aria-busy="true">${skeletonLines(3)}</div>`;
            return;
        }
        const rows = owned.items.map(collection => {
            const id = String(collection.id || '');
            const member = picker.memberIds.has(id);
            const busy = picker.pending.has(id);
            const count = collectionCount(collection);
            const icon = busy ? 'fa-spinner fa-spin' : member ? 'fa-check' : 'fa-plus';
            return `
                <button type="button" class="janny-collection-picker-row${member ? ' is-member' : ''}" data-collection-id="${escapeHtml(id)}" role="menuitemcheckbox" aria-checked="${member}"${busy ? ' aria-busy="true"' : ''}>
                    <i class="fa-solid ${icon}"></i>
                    <span class="janny-collection-picker-name">${escapeHtml(collection.name || 'Untitled')}</span>
                    <span class="janny-collection-picker-meta">${count !== null ? formatNumber(count) : ''} <i class="fa-solid ${isCollectionPrivate(collection) ? 'fa-lock' : 'fa-globe'}"></i></span>
                </button>`;
        }).join('');
        menu.innerHTML = title + (rows || note('No collections yet.')) + newRow;
    }

    async function togglePicker() {
        if (picker.open) { closePicker(); return; }
        picker.open = true;
        picker.error = '';
        renderPicker();
        const gen = generation();
        if (!await host.ensureAccountReady() || gen !== generation()) { renderPicker(); return; }
        await loadOwned(false);
        if (gen !== generation() || !picker.open) return;
        if (selectedId() && picker.checkedFor !== selectedId()) await refreshMembership();
        renderPicker();
    }

    function closePicker() {
        picker.open = false;
        renderPicker();
    }

    /** Called when the preview opens a (possibly different) character. */
    function resetPicker() {
        picker = freshPicker();
        renderPicker();
    }

    /** Warm the owned list in the background so the picker opens instantly. */
    function preload() {
        if (!host.isAccountActive() || owned.loaded || owned.loading || owned.signedOut) return;
        loadOwned(false).catch(err => debugLog('[JannyCollections] preload failed:', err.message));
    }

    async function toggleMembership(collectionId) {
        const gen = generation();
        const character = host.getSelectedCharacter();
        const charId = String(character?.id || '');
        const cid = String(collectionId || '');
        if (!charId || !cid || picker.pending.has(cid)) return;
        if (!await host.ensureAccountReady() || gen !== generation()) return;
        const name = owned.items.find(c => String(c.id) === cid)?.name || 'collection';
        const charName = character?.name || 'character';
        const wasMember = picker.memberIds.has(cid);
        picker.pending.add(cid);
        renderPicker();
        try {
            if (wasMember) {
                await api.removeCharacterFromCollection(cid, charId);
                if (gen !== generation()) return;
                applyMembership(cid, character, false);
                showToast(`Removed ${charName} from ${name}.`, 'success');
            } else {
                await api.addCharacterToCollection(cid, charId);
                if (gen !== generation()) return;
                applyMembership(cid, character, true);
                showToast(`Added ${charName} to ${name}.`, 'success');
            }
        } catch (err) {
            if (gen !== generation()) return;
            if (await isDuplicateAdd(err, { wasMember, collectionId: cid, characterId: charId, gen })) {
                if (gen !== generation()) return;
                applyMembership(cid, character, true, { countChanged: false });
                showToast(`${charName} is already in ${name}. Membership refreshed.`, 'info');
            } else {
                if (gen !== generation()) return;
                host.handleAccountFailure(err, gen);
                showToast(`Could not update collection: ${host.describeError(err)}`, 'error', 8000);
            }
        } finally {
            if (gen === generation()) {
                picker.pending.delete(cid);
                if (selectedId() === charId) renderPicker();
            }
        }
    }

    function wirePicker() {
        const btn = el('jannyCollectionDropdownBtn');
        if (btn && !btn.dataset.pickerWired) {
            btn.dataset.pickerWired = '1';
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                togglePicker();
            });
        }
        const menu = el('jannyCollectionDropdown');
        if (menu && !menu.dataset.pickerWired) {
            menu.dataset.pickerWired = '1';
            menu.addEventListener('click', (e) => {
                e.stopPropagation();
                if (e.target.closest('[data-picker-action="new"]')) {
                    closePicker();
                    host.closePreview();
                    openCreateForm();
                    return;
                }
                const row = e.target.closest('.janny-collection-picker-row[data-collection-id]');
                if (row) toggleMembership(row.dataset.collectionId);
            });
        }
        if (!pickerDocumentWired) {
            pickerDocumentWired = true;
            document.addEventListener('click', (e) => {
                if (picker.open && !e.target.closest?.('#jannyCollectionAction')) closePicker();
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && picker.open) closePicker();
            });
        }
    }

    // ── Navigation ───────────────────────────────────────

    function setOpen(open) {
        const section = el('jannyCollectionsSection');
        const browse = el('jannyBrowseSection');
        if (!section || !browse) return;
        section.classList.toggle('hidden', !open);
        browse.classList.toggle('hidden', !!open);
        el('jannyCollectionsBtn')?.classList.toggle('active', !!open);
        if (!open) return;
        if (!nav.length) nav = [{ kind: rootTab }];
        render();
        window.pushOverlayGuard?.();
    }

    function setTab(tab) {
        rootTab = tab === 'owned' ? 'owned' : 'public';
        if (rootTab !== 'owned') createFormOpen = false;
        if (rootTab === 'owned') owned.signedOut = false;
        nav = [{ kind: rootTab }];
        render();
    }

    function push(view) {
        nav.push(view);
        render();
        window.pushOverlayGuard?.();
    }

    function back() {
        const top = current();
        if (isOwnedDetail(top) && top.editing) {
            top.editing = false;
            render();
            return;
        }
        if (nav.length > 1) {
            nav.pop();
            render();
            return;
        }
        setOpen(false);
    }

    function openFromDirectory(key) {
        const top = current();
        if (!top || top.kind === 'detail') return;
        const isOwned = top.kind === 'owned';
        const seed = directoryItems(top).find(c => String(isOwned ? c.id : c.path) === String(key));
        if (!seed) return;
        push({
            kind: 'detail',
            source: isOwned ? 'owned' : 'public',
            key: String(key),
            // Owned views share the list's object, so a rename or count change shows in both
            collection: isOwned ? seed : { ...seed },
            characters: null,
            loading: false,
            error: '',
            editing: false,
        });
    }

    function openCreateForm() {
        createFormOpen = true;
        setOpen(true);
        setTab('owned');
        el('jannyNewCollectionName')?.focus?.();
    }

    /** Topbar refresh: re-fetch whatever is on screen. */
    function refresh() {
        const top = current();
        if (!top) return;
        if (top.kind === 'public') loadPublic({ reset: true });
        else if (top.kind === 'owned') {
            members = new Map();
            owned.signedOut = false;
            loadOwned(true);
        } else if (top.kind === 'collector') {
            top.items = undefined;
            loadCollector(top);
        } else {
            top.characters = null;
            top.editing = false;
            render();
        }
    }

    function canLoadMore() {
        return current()?.kind === 'public' && pub.loaded && pub.hasMore && !pub.loading;
    }

    function loadMore() {
        if (canLoadMore()) loadPublic();
    }

    /** The account changed or was rejected: drop everything it owned, on screen and off. */
    function invalidate() {
        hydrateToken++;
        owned = freshOwned(true);
        members = new Map();
        picker = freshPicker();
        const menu = el('jannyCollectionDropdown');
        if (menu) { menu.innerHTML = ''; menu.classList.add('hidden'); }
        if (nav.some(v => v.kind === 'owned' || isOwnedDetail(v))) {
            nav = [{ kind: rootTab }];
            for (const id of ['jannyCollectionDetailBanner', 'jannyCollectionEditor', 'jannyCollectionCharGrid']) {
                const node = el(id);
                if (node) node.innerHTML = '';
            }
        }
        if (el('jannyCollectionsSection') && nav.length) render();
    }

    // ── Rendering ────────────────────────────────────────

    function directoryItems(top) {
        if (top.kind === 'public') return pub.items;
        if (top.kind === 'owned') return owned.items;
        return top.items || [];
    }

    function render() {
        const top = current();
        if (!top) return;
        if (top.kind === 'detail') showDetail(top);
        else showDirectory(top);
        if (isOpen()) ensureLoaded(top);
    }

    function ensureLoaded(top) {
        if (top.kind === 'public') {
            if (!pub.loaded && !pub.loading && !pub.error) loadPublic({ reset: true });
        } else if (top.kind === 'owned') {
            if (!owned.loaded && !owned.loading && !owned.error && !owned.signedOut) loadOwned(false);
        } else if (top.kind === 'collector') {
            if (top.items === undefined && !top.loading && !top.error) loadCollector(top);
        } else if (top.characters === null && !top.loading && !top.error) {
            loadDetail(top);
        }
    }

    function setSurface(surface) {
        el('jannyCollectionsDirectory')?.classList.toggle('hidden', surface !== 'directory');
        el('jannyCollectionDetail')?.classList.toggle('hidden', surface !== 'detail');
    }

    function banner({ back: backAction, backLabel, title, metaHtml = '', actionsHtml = '' }) {
        return `
            <div class="browse-author-banner janny-collection-banner">
                <div class="browse-author-banner-content">
                    <button type="button" class="glass-btn icon-only" data-coll-action="${backAction}" title="${escapeHtml(backLabel)}" aria-label="${escapeHtml(backLabel)}">
                        <i class="fa-solid fa-arrow-left"></i>
                    </button>
                    <div class="janny-collection-banner-text">
                        <strong>${escapeHtml(title)}</strong>
                        ${metaHtml ? `<span class="janny-collection-banner-meta">${metaHtml}</span>` : ''}
                    </div>
                </div>
                ${actionsHtml ? `<div class="browse-author-banner-actions">${actionsHtml}</div>` : ''}
            </div>`;
    }

    function openOnJannyLink(url) {
        return url
            ? `<a class="glass-btn icon-only" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Open on JannyAI" aria-label="Open on JannyAI"><i class="fa-solid fa-external-link"></i></a>`
            : '';
    }

    function renderHeader(top) {
        const header = el('jannyCollectionsHeader');
        if (!header) return;
        if (top.kind === 'collector') {
            header.innerHTML = banner({
                back: 'back',
                backLabel: 'Back',
                title: `Collections by ${top.name}`,
                metaHtml: Array.isArray(top.items) ? `${formatNumber(top.items.length)} public` : '',
                actionsHtml: openOnJannyLink(`${host.siteBase}/collectors/${encodeURIComponent(top.name)}`),
            });
            return;
        }
        header.innerHTML = banner({
            back: 'close',
            backLabel: 'Back to browse',
            title: 'Janny Collections',
            metaHtml: top.kind === 'owned' ? 'Your collections, synced with JannyAI' : 'Public collections from JannyAI',
        });
    }

    function showDirectory(top) {
        setSurface('directory');
        renderHeader(top);
        const isCollector = top.kind === 'collector';
        el('jannyCollectionsTabs')?.classList.toggle('hidden', isCollector);
        for (const [id, tab] of [['jannyCollectionsPublicBtn', 'public'], ['jannyCollectionsMineBtn', 'owned']]) {
            const btn = el(id);
            if (!btn) continue;
            btn.classList.toggle('active', top.kind === tab);
            btn.setAttribute('aria-selected', String(top.kind === tab));
        }
        el('jannyCollectionsPublicTools')?.classList.toggle('hidden', top.kind !== 'public');
        el('jannyCollectionsOwnedTools')?.classList.toggle('hidden', top.kind !== 'owned');
        el('jannyCollectionsCreateForm')?.classList.toggle('hidden', !(top.kind === 'owned' && createFormOpen));
        const sort = el('jannyPublicCollectionsSort');
        if (sort && sort.value !== pub.sort) sort.value = pub.sort;
        paintDirectoryGrid(top);
    }

    function collectionCardHtml(collection, kind) {
        const isOwned = kind === 'owned';
        const owner = collection?.ownerName || collection?.creatorUsername || collection?.user?.username || '';
        const byline = [];
        if (isOwned) byline.push(isCollectionPrivate(collection) ? 'Private' : 'Public');
        else if (owner && kind !== 'collector') byline.push(`by ${owner}`);
        if (typeof collection?.viewCount === 'number') byline.push(`${formatNumber(collection.viewCount)} views`);
        const updated = formatDate(collection?.updatedAt || collection?.updated_at || collection?.createdAt);
        const count = collectionCount(collection) || 0;
        return renderCollectionCard({
            id: String((isOwned ? collection?.id : collection?.path) ?? ''),
            title: collection?.name,
            byline: byline.join(' · '),
            count,
            countLabel: count === 1 ? 'card' : 'cards',
            coverUrls: collectionCoverSources(collection).map(src => host.resolveAvatarUrl(src)),
            footer: updated ? `Updated ${updated}` : '',
        });
    }

    function message(container, { icon, title, hint = '', action = '', actionLabel = '' }) {
        container.innerHTML = `
            <div class="cl-empty-state">
                <div class="cl-empty-state-icon"><i class="${icon}"></i></div>
                <h3 class="cl-empty-state-title">${escapeHtml(title)}</h3>
                ${hint ? `<p class="cl-empty-state-hint">${escapeHtml(hint)}</p>` : ''}
                ${action ? `<button type="button" class="action-btn primary cl-empty-state-action" data-coll-action="${action}">${escapeHtml(actionLabel)}</button>` : ''}
            </div>`;
    }

    function directoryStatus(top) {
        if (top.kind === 'public') return pub;
        if (top.kind === 'owned') return owned;
        return { items: top.items || [], loading: !!top.loading, loaded: Array.isArray(top.items), error: top.error || '', hasMore: false };
    }

    function paintDirectoryGrid(top) {
        const grid = el('jannyCollectionsGrid');
        if (!grid) return;
        const status = directoryStatus(top);
        updateLoadMore();
        if (status.items.length) {
            grid.innerHTML = status.items.map(c => collectionCardHtml(c, top.kind)).join('');
            host.getView().observeImages(grid);
            return;
        }
        if (status.loading) {
            renderSkeletonGrid(grid, SKELETON_COLLECTIONS, 'Loading collections');
            return;
        }
        if (status.error) {
            message(grid, { icon: 'fa-solid fa-triangle-exclamation', title: 'Could not load collections', hint: status.error, action: 'reload', actionLabel: 'Retry' });
            return;
        }
        if (top.kind === 'owned' && !status.loaded) {
            message(grid, {
                icon: 'fa-solid fa-user-lock',
                title: 'Sign in to see your collections',
                hint: 'Install your browser-owned login in JannyAI Settings, then retry.',
                action: 'reload',
                actionLabel: 'Retry',
            });
            return;
        }
        if (!status.loaded) {
            grid.innerHTML = '';
            return;
        }
        if (top.kind === 'owned') {
            message(grid, { icon: 'fa-solid fa-layer-group', title: 'No collections yet', hint: 'Group cards you like into a collection on JannyAI.', action: 'new', actionLabel: 'New collection' });
        } else if (top.kind === 'collector') {
            message(grid, { icon: 'fa-solid fa-user', title: `No public collections by ${top.name}` });
        } else {
            message(grid, { icon: 'fa-solid fa-globe', title: 'No public collections found' });
        }
    }

    function paintIfTop(kind) {
        if (current()?.kind === kind) paintDirectoryGrid(current());
    }

    function paintOwned() {
        paintIfTop('owned');
    }

    function appendDirectoryCards(items, kind) {
        const grid = el('jannyCollectionsGrid');
        if (!grid) return;
        grid.insertAdjacentHTML('beforeend', items.map(c => collectionCardHtml(c, kind)).join(''));
        host.getView().observeImages(grid);
        updateLoadMore();
    }

    function replaceOwnedCard(collection) {
        if (current()?.kind !== 'owned') return;
        const grid = el('jannyCollectionsGrid');
        if (!grid) return;
        const id = String(collection.id);
        const selector = `.browse-collection-card[data-collection-id="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id}"]`;
        const node = grid.querySelector(selector);
        if (!node) { paintDirectoryGrid(current()); return; }
        node.outerHTML = collectionCardHtml(collection, 'owned');
        host.getView().observeImages(grid);
    }

    function updateLoadMore() {
        const wrap = el('jannyCollectionsLoadMore');
        if (!wrap) return;
        const show = current()?.kind === 'public' && pub.items.length > 0 && pub.hasMore;
        wrap.classList.toggle('hidden', !show);
        const btn = el('jannyCollectionsLoadMoreBtn');
        if (!btn) return;
        btn.disabled = pub.loading;
        btn.innerHTML = pub.loading
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Loading...'
            : '<i class="fa-solid fa-plus"></i> Load More';
    }

    function showDetail(view) {
        setSurface('detail');
        renderDetailHeader(view);
        renderEditor(view);
        paintCharGrid(view);
    }

    /** Banner + description: everything above the grid that a finished fetch can change. */
    function renderDetailHeader(view) {
        renderDetailBanner(view);
        const desc = el('jannyCollectionDetailDescription');
        if (!desc) return;
        const text = String(view.collection?.description || '').replace(/<[^>]*>/g, '').trim();
        desc.textContent = text;
        desc.classList.toggle('hidden', !text || !!view.editing);
    }

    function detailUrl(view) {
        const c = view.collection || {};
        if (view.source === 'owned') return c.id ? `${host.siteBase}/collections/${c.id}` : '';
        return c.url || (c.path ? `${host.siteBase}${c.path}` : '');
    }

    function renderDetailBanner(view) {
        const target = el('jannyCollectionDetailBanner');
        if (!target) return;
        const c = view.collection || {};
        const count = collectionCount(c) ?? (Array.isArray(view.characters) ? view.characters.length : null);
        const owner = view.source === 'owned' ? '' : (c.ownerName || c.creatorUsername || '');
        const updated = formatDate(c.updatedAt || c.updated_at || '');
        const meta = [
            count !== null ? `<span><i class="fa-solid fa-layer-group"></i> ${formatNumber(count)} ${count === 1 ? 'card' : 'cards'}</span>` : '',
            owner ? `<span><i class="fa-solid fa-user"></i> <a href="#" class="creator-link" data-coll-action="collector" data-owner="${escapeHtml(owner)}" title="More collections by ${escapeHtml(owner)}">${escapeHtml(owner)}</a></span>` : '',
            typeof c.viewCount === 'number' ? `<span><i class="fa-solid fa-eye"></i> ${formatNumber(c.viewCount)} views</span>` : '',
            view.source === 'owned' ? `<span><i class="fa-solid ${isCollectionPrivate(c) ? 'fa-lock' : 'fa-globe'}"></i> ${isCollectionPrivate(c) ? 'Private' : 'Public'}</span>` : '',
            updated ? `<span><i class="fa-solid fa-clock"></i> ${escapeHtml(updated)}</span>` : '',
        ].filter(Boolean).join('');
        const manage = isOwnedDetail(view) && !view.editing
            ? `<button type="button" class="glass-btn icon-only" data-coll-action="edit" title="Edit collection" aria-label="Edit collection"><i class="fa-solid fa-pen"></i></button>
               <button type="button" class="glass-btn icon-only" data-coll-action="delete" title="Delete collection" aria-label="Delete collection"><i class="fa-solid fa-trash"></i></button>`
            : '';
        target.innerHTML = banner({
            back: 'back',
            backLabel: view.editing ? 'Stop editing' : 'Back',
            title: c.name || 'Collection',
            metaHtml: meta,
            actionsHtml: manage + openOnJannyLink(detailUrl(view)),
        });
    }

    function renderEditor(view) {
        const editor = el('jannyCollectionEditor');
        if (!editor) return;
        const editing = isOwnedDetail(view) && view.editing;
        editor.classList.toggle('hidden', !editing);
        if (!editing) { editor.innerHTML = ''; return; }
        const c = view.collection || {};
        editor.innerHTML = `
            <form class="janny-collections-form" data-coll-form="edit" autocomplete="off">
                <label class="janny-collections-field">Name
                    <input id="jannyEditCollectionName" class="glass-input" value="${escapeHtml(c.name || '')}" autocomplete="one-time-code">
                </label>
                <label class="janny-collections-field">Description
                    <textarea id="jannyEditCollectionDescription" class="glass-input" rows="3">${escapeHtml(c.description || '')}</textarea>
                </label>
                <label class="janny-collections-check"><input type="checkbox" id="jannyEditCollectionPrivate"${isCollectionPrivate(c) ? ' checked' : ''}> <i class="fa-solid fa-lock"></i> Private</label>
                <div class="janny-collections-add">
                    <input id="jannyEditAddCharacterInput" class="glass-input" placeholder="Add a card: paste a JannyAI character URL or ID" autocomplete="one-time-code">
                    <button type="button" class="glass-btn" data-coll-action="add-character"><i class="fa-solid fa-plus"></i> Add</button>
                </div>
                <p class="janny-collections-form-hint">Tap <i class="fa-solid fa-xmark"></i> on a card below to remove it from this collection.</p>
                <div class="janny-collections-form-actions">
                    <button type="button" class="glass-btn" data-coll-action="cancel-edit">Cancel</button>
                    <button type="submit" id="jannyEditCollectionSaveBtn" class="glass-btn janny-collections-primary"><i class="fa-solid fa-floppy-disk"></i> Save</button>
                </div>
            </form>`;
    }

    function paintCharGrid(view) {
        const grid = el('jannyCollectionCharGrid');
        if (!grid) return;
        if (view.loading || (view.characters === null && !view.error)) {
            renderSkeletonGrid(grid, 12, 'Loading collection');
            return;
        }
        if (view.error) {
            message(grid, { icon: 'fa-solid fa-triangle-exclamation', title: 'Could not open this collection', hint: view.error, action: 'reload', actionLabel: 'Retry' });
            return;
        }
        if (!view.characters.length) {
            message(grid, {
                icon: 'fa-solid fa-inbox',
                title: 'No cards here yet',
                hint: isOwnedDetail(view) ? 'Add cards from a character preview with Add to collection.' : 'This collection has no public cards right now.',
            });
            return;
        }
        grid.innerHTML = view.characters.map(c => host.createCard(c)).join('');
        if (isOwnedDetail(view) && view.editing) {
            for (const card of grid.querySelectorAll('.browse-card[data-janny-id]')) {
                const id = escapeHtml(card.dataset.jannyId);
                card.querySelector('.browse-card-image')?.insertAdjacentHTML('beforeend',
                    `<button type="button" class="janny-collection-remove" data-coll-action="remove" data-character-id="${id}" title="Remove from collection" aria-label="Remove from collection"><i class="fa-solid fa-xmark"></i></button>`);
            }
        }
        host.getView().observeImages(grid);
    }

    // ── Owned collection actions ─────────────────────────

    async function createFromForm() {
        if (creating) return;
        const gen = generation();
        const nameEl = el('jannyNewCollectionName');
        const descEl = el('jannyNewCollectionDescription');
        const privateEl = el('jannyNewCollectionPrivate');
        const errorEl = el('jannyCreateCollectionError');
        const submitBtn = el('jannyCreateCollectionBtn');
        const name = (nameEl?.value || '').trim();
        if (errorEl) { errorEl.classList.add('hidden'); errorEl.innerHTML = ''; }
        if (!name) {
            showToast('Name the collection first', 'warning');
            nameEl?.focus?.();
            return;
        }
        creating = true;
        if (submitBtn) submitBtn.disabled = true;
        try {
            if (!await host.ensureAccountReady() || gen !== generation()) return;
            await api.createCollection({ name, description: descEl?.value || '', isPrivate: privateEl ? !!privateEl.checked : true });
            if (gen !== generation()) return;
            if (nameEl) nameEl.value = '';
            if (descEl) descEl.value = '';
            createFormOpen = false;
            el('jannyCollectionsCreateForm')?.classList.add('hidden');
            await loadOwned(true);
            if (gen !== generation()) return;
            showToast('Collection created', 'success');
        } catch (err) {
            if (gen !== generation()) return;
            host.handleAccountFailure(err, gen);
            const reason = host.describeError(err);
            if (errorEl && gen === generation()) {
                errorEl.classList.remove('hidden');
                errorEl.innerHTML = `Couldn't create it here (${escapeHtml(reason)}). <a href="${escapeHtml(host.siteBase)}/collections/new" target="_blank" rel="noopener noreferrer">Create it on JannyAI</a> instead.`;
            } else {
                showToast(`Could not create collection: ${reason}`, 'error', 8000);
            }
        } finally {
            creating = false;
            if (submitBtn) submitBtn.disabled = false;
        }
    }

    async function saveEdit() {
        const view = current();
        if (!isOwnedDetail(view) || !view.editing || view.saving) return;
        const gen = generation();
        const name = (el('jannyEditCollectionName')?.value || '').trim();
        const description = el('jannyEditCollectionDescription')?.value || '';
        const isPrivate = !!el('jannyEditCollectionPrivate')?.checked;
        if (!name) {
            showToast('Name the collection first', 'warning');
            return;
        }
        view.saving = true;
        const saveBtn = el('jannyEditCollectionSaveBtn');
        if (saveBtn) saveBtn.disabled = true;
        try {
            if (!await host.ensureAccountReady() || gen !== generation()) return;
            await api.updateCollection({ id: view.key, name, description, isPrivate });
            if (gen !== generation()) return;
            Object.assign(view.collection, { name, description, isPrivate });
            view.editing = false;
            if (current() === view) render();
            showToast('Collection saved', 'success');
        } catch (err) {
            if (gen !== generation()) return;
            host.handleAccountFailure(err, gen);
            showToast(`Could not save collection: ${host.describeError(err)}`, 'error', 8000);
        } finally {
            view.saving = false;
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    async function deleteCurrent() {
        const view = current();
        if (!isOwnedDetail(view)) return;
        const gen = generation();
        const ok = await showConfirm({
            title: 'Delete this collection?',
            message: `"${view.collection?.name || 'This collection'}" will be deleted on JannyAI. This can't be undone from Character Library.`,
            confirmText: 'Delete',
            cancelText: 'Cancel',
            danger: true,
            icon: 'fa-solid fa-trash',
        });
        if (!ok || gen !== generation()) return;
        try {
            await api.deleteCollection(view.key);
            if (gen !== generation()) return;
            owned.items = owned.items.filter(c => String(c.id) !== view.key);
            members.delete(view.key);
            rootTab = 'owned';
            nav = [{ kind: 'owned' }];
            render();
            showToast('Collection deleted', 'success');
        } catch (err) {
            if (gen !== generation()) return;
            host.handleAccountFailure(err, gen);
            showToast(`Could not delete collection: ${host.describeError(err)}`, 'error', 8000);
        }
    }

    async function addFromInput() {
        const view = current();
        if (!isOwnedDetail(view) || !view.editing) return;
        const gen = generation();
        const input = el('jannyEditAddCharacterInput');
        const id = parseJannyCharacterId(input?.value);
        if (!id) {
            showToast('Paste a JannyAI character URL or ID', 'warning');
            return;
        }
        if (members.get(view.key)?.has(id) || view.characters?.some(c => String(c.id) === id)) {
            showToast('That card is already in this collection', 'info');
            return;
        }
        if (!await host.ensureAccountReady() || gen !== generation()) return;
        try {
            await api.addCharacterToCollection(view.key, id);
            if (gen !== generation()) return;
            const fetched = await api.fetchCharactersByIds([id]);
            if (gen !== generation()) return;
            const character = fetched.map(normalizeJannyCharacter).filter(Boolean)[0] || { id, name: id, avatar: '' };
            applyMembership(view.key, character, true);
            if (input) input.value = '';
            showToast('Card added to the collection', 'success');
        } catch (err) {
            if (gen !== generation()) return;
            if (await isDuplicateAdd(err, { wasMember: false, collectionId: view.key, characterId: id, gen })) {
                if (gen !== generation()) return;
                showToast('That card is already in this collection', 'info');
                if (current() === view) refresh();
                return;
            }
            if (gen !== generation()) return;
            host.handleAccountFailure(err, gen);
            showToast(`Could not add card: ${host.describeError(err)}`, 'error', 8000);
        }
    }

    async function removeFromCurrent(characterId) {
        const view = current();
        if (!isOwnedDetail(view) || !characterId) return;
        const gen = generation();
        if (!await host.ensureAccountReady() || gen !== generation()) return;
        try {
            await api.removeCharacterFromCollection(view.key, characterId);
            if (gen !== generation()) return;
            applyMembership(view.key, { id: characterId }, false);
            showToast('Card removed from the collection', 'success');
        } catch (err) {
            if (gen !== generation()) return;
            host.handleAccountFailure(err, gen);
            showToast(`Could not remove card: ${host.describeError(err)}`, 'error', 8000);
        }
    }

    // ── Markup + wiring ──────────────────────────────────

    function renderSection() {
        return `
            <div id="jannyCollectionsSection" class="browse-section janny-collections hidden">
                <div id="jannyCollectionsDirectory">
                    <div id="jannyCollectionsHeader"></div>
                    <div class="janny-collections-bar">
                        <div id="jannyCollectionsTabs" class="janny-collections-tabs" role="tablist" aria-label="Janny collections">
                            <button type="button" id="jannyCollectionsPublicBtn" class="glass-btn active" role="tab" aria-selected="true" data-coll-action="tab" data-tab="public"><i class="fa-solid fa-globe"></i> Public</button>
                            <button type="button" id="jannyCollectionsMineBtn" class="glass-btn" role="tab" aria-selected="false" data-coll-action="tab" data-tab="owned"><i class="fa-solid fa-user-lock"></i> Mine</button>
                        </div>
                        <div id="jannyCollectionsPublicTools" class="janny-collections-tools">
                            <select id="jannyPublicCollectionsSort" class="glass-select" title="Sort public collections">
                                <option value="latest" selected>Latest</option>
                                <option value="popular">Most popular</option>
                            </select>
                        </div>
                        <div id="jannyCollectionsOwnedTools" class="janny-collections-tools hidden">
                            <button type="button" id="jannyCollectionsNewBtn" class="glass-btn" data-coll-action="new"><i class="fa-solid fa-plus"></i> New collection</button>
                        </div>
                    </div>
                    <form id="jannyCollectionsCreateForm" class="janny-collections-form hidden" data-coll-form="create" autocomplete="off">
                        <label class="janny-collections-field">Name
                            <input id="jannyNewCollectionName" class="glass-input" placeholder="Collection name" autocomplete="one-time-code">
                        </label>
                        <label class="janny-collections-field">Description
                            <textarea id="jannyNewCollectionDescription" class="glass-input" rows="2" placeholder="Optional"></textarea>
                        </label>
                        <label class="janny-collections-check"><input type="checkbox" id="jannyNewCollectionPrivate" checked> <i class="fa-solid fa-lock"></i> Private</label>
                        <div id="jannyCreateCollectionError" class="janny-collections-form-error hidden"></div>
                        <div class="janny-collections-form-actions">
                            <button type="button" class="glass-btn" data-coll-action="cancel-create">Cancel</button>
                            <button type="submit" id="jannyCreateCollectionBtn" class="glass-btn janny-collections-primary"><i class="fa-solid fa-plus"></i> Create</button>
                        </div>
                    </form>
                    <div id="jannyCollectionsGrid" class="browse-collection-grid"></div>
                    <div id="jannyCollectionsLoadMore" class="browse-load-more hidden">
                        <button type="button" id="jannyCollectionsLoadMoreBtn" class="glass-btn" data-coll-action="more"><i class="fa-solid fa-plus"></i> Load More</button>
                    </div>
                </div>
                <div id="jannyCollectionDetail" class="hidden">
                    <div id="jannyCollectionDetailBanner"></div>
                    <div id="jannyCollectionEditor" class="hidden"></div>
                    <p id="jannyCollectionDetailDescription" class="janny-collection-description hidden"></p>
                    <div id="jannyCollectionCharGrid" class="browse-grid"></div>
                </div>
            </div>`;
    }

    function handleAction(action, target) {
        switch (action) {
            case 'close': setOpen(false); break;
            case 'back': back(); break;
            case 'tab': setTab(target.dataset.tab); break;
            case 'reload': refresh(); break;
            case 'more': loadMore(); break;
            case 'new':
                createFormOpen = true;
                if (current()?.kind === 'owned') render(); else setTab('owned');
                el('jannyNewCollectionName')?.focus?.();
                break;
            case 'cancel-create':
                createFormOpen = false;
                el('jannyCollectionsCreateForm')?.classList.add('hidden');
                break;
            case 'collector': {
                const name = String(target.dataset.owner || '').trim();
                if (name) push({ kind: 'collector', name, items: undefined, loading: false, error: '' });
                break;
            }
            case 'edit': {
                const view = current();
                if (isOwnedDetail(view)) { view.editing = true; render(); el('jannyEditCollectionName')?.focus?.(); }
                break;
            }
            case 'cancel-edit': {
                const view = current();
                if (isOwnedDetail(view)) { view.editing = false; render(); }
                break;
            }
            case 'delete': deleteCurrent(); break;
            case 'add-character': addFromInput(); break;
            case 'remove': removeFromCurrent(target.dataset.characterId); break;
        }
    }

    /** Attach delegated listeners to a freshly rendered section; safe to call on every init. */
    function wire() {
        const section = el('jannyCollectionsSection');
        if (!section || section.dataset.collectionsWired) return;
        section.dataset.collectionsWired = '1';

        const sort = el('jannyPublicCollectionsSort');
        if (sort) initCustomSelect(sort);

        wireCollectionGrid(el('jannyCollectionsGrid'), (key) => openFromDirectory(key));

        section.addEventListener('click', (e) => {
            const actionEl = e.target.closest('[data-coll-action]');
            if (actionEl && section.contains(actionEl)) {
                e.preventDefault();
                e.stopPropagation();
                handleAction(actionEl.dataset.collAction, actionEl);
                return;
            }
            // A collection's characters: creator link searches the creator, card opens the preview
            if (!e.target.closest('#jannyCollectionCharGrid')) return;
            const creator = e.target.closest('.browse-card-creator-link');
            if (creator) {
                e.stopPropagation();
                const author = creator.dataset.author;
                if (author) { setOpen(false); host.filterByAuthor(author); }
                return;
            }
            const card = e.target.closest('.browse-card[data-janny-id]');
            const view = current();
            if (!card || view?.kind !== 'detail') return;
            const hit = view.characters?.find(c => String(c.id) === String(card.dataset.jannyId));
            if (hit) host.openPreview(hit);
        });

        section.addEventListener('submit', (e) => {
            e.preventDefault();
            const form = e.target.closest?.('[data-coll-form]');
            if (form?.dataset.collForm === 'create') createFromForm();
            else if (form?.dataset.collForm === 'edit') saveEdit();
        });

        section.addEventListener('keydown', (e) => {
            // Enter in the add-card field adds the card instead of submitting the whole form
            if (e.key === 'Enter' && e.target?.id === 'jannyEditAddCharacterInput') {
                e.preventDefault();
                addFromInput();
            }
        });

        section.addEventListener('change', (e) => {
            if (e.target?.id !== 'jannyPublicCollectionsSort') return;
            pub.sort = e.target.value === 'popular' ? 'popular' : 'latest';
            loadPublic({ reset: true });
        });

        // Phone back steps back one screen (stops editing first). Escape is left alone so it
        // can't throw away a half-typed edit on desktop.
        window.registerOverlay?.({
            id: 'jannyCollectionsSection',
            tier: 8,
            escape: false,
            close: () => back(),
            visible: (node) => !node.classList.contains('hidden') && node.offsetParent !== null,
        });
    }

    return {
        renderSection,
        wire,
        wirePicker,
        isOpen,
        setOpen,
        refresh,
        canLoadMore,
        loadMore,
        invalidate,
        preload,
        resetPicker,
        closePicker,
        togglePicker,
        gridIds: ['jannyCollectionsGrid', 'jannyCollectionCharGrid'],
        // Test seams: read-only views of internal state plus the async operations themselves
        _debug: {
            get nav() { return nav; },
            get owned() { return owned; },
            get pub() { return pub; },
            get members() { return members; },
            get picker() { return picker; },
            loadOwned,
            loadPublic,
            refreshMembership,
            toggleMembership,
            hydrateOwnedCovers,
            createFromForm,
            saveEdit,
            deleteCurrent,
            addFromInput,
            removeFromCurrent,
            openFromDirectory,
            setTab,
            push,
            back,
        },
    };
}
