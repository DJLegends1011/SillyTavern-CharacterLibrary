// JannyBrowseView - JannyAI browse/search UI for the Online tab

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber, BROWSE_PURIFY_CONFIG, skeletonLines, deferRender, deferCall, isMobileViewport } from '../provider-utils.js';
import {
    JANNY_SEARCH_URL,
    JANNY_IMAGE_BASE,
    JANNY_SITE_BASE,
    TAG_MAP,
    getSearchToken,
    fetchWithProxy,
    slugify,
    stripHtml,
    resolveTagNames,
    checkJannyPluginAvailable,
    getJannySessionStatus,
    setJannySessionCookie,
    validateJannySession,
    fetchJannyBookmarks,
    addJannyBookmarks,
    removeJannyBookmarks,
    fetchJannyCollections,
    fetchJannyCollectionCharacters,
    fetchJannyPublicCollections,
    fetchJannyPublicCollection,
    fetchJannyPublicCharactersByIds,
    createJannyCollection,
    updateJannyCollection,
    deleteJannyCollection,
    addJannyCharacterToCollection,
    removeJannyCharacterFromCollection,
    fetchJannyCharactersByIds
} from './janny-api.js';

const {
    onElement: on,
    showToast,
    escapeHtml,
    debugLog,
    getSetting,
    fetchCharacters,
    fetchAndAddCharacter,
    checkCharacterForDuplicatesAsync,
    showPreImportDuplicateWarning,
    deleteCharacter,
    getCharacterGalleryId,
    showImportSummaryModal,
    formatRichText,
    safePurify,
    renderCreatorNotesSecure,
    cleanupCreatorNotesContainer,
    debounce,
    getProviderExcludeTags,
    setSetting,
    renderLoadingState,
    renderSkeletonGrid,
    showConfirm,
} = CoreAPI;

// ========================================
// CONSTANTS
// ========================================



// ========================================
// STATE
// ========================================

let jannyCharacters = [];
let jannyCurrentPage = 1;
let jannyHasMore = true;
let jannyIsLoading = false;
let jannyLoadToken = 0;
let jannyCurrentSearch = '';
let jannyNsfwEnabled = false;
let jannySortMode = 'newest';
let jannySelectedChar = null;
let jannyGridRenderedCount = 0;

// Filter state - mirrors Chub's filter model for parity
let jannyShowLowQuality = false;
let jannyMinTokens = 29;
let jannyMaxTokens = 100000;
let jannyFilterHideOwned = false;
let jannyFilterHidePossible = false;
let jannyFilterOnlyBookmarked = false;
/** @type {Set<number>} Active include tag IDs */
let jannyIncludeTags = new Set();
let jannyAuthorFilter = null;

let view; // module-scoped BrowseView instance reference (set once in constructor)

// Account sync state
const JANNY_BOOKMARK_UI_LIMIT = 220;
let jannyBookmarkIds = new Set();
let jannyBookmarksLoaded = false;
let jannyBookmarkTotalCount = null;
let jannyBookmarkLimitToastShown = false;
let jannyAccountStatus = { plugin: false, active: false, valid: false, cloudflare: false, reason: '' };
let jannyOwnedCollections = [];
let jannyOwnedCollectionsLoaded = false;
let jannyOwnedPreviewHydrationToken = 0;
let jannyModalCollectionIds = new Set();
let jannyModalCollectionChecksLoadedFor = '';
let jannyCollectionDropdownOpen = false;
let jannyCollectionRowMutations = new Set();
let jannyCollectionsMode = 'public';
let jannyPublicCollections = [];
let jannyPublicCollectionsPage = 1;
let jannyPublicCollectionsHasMore = true;
let jannyPublicCollectionsLoading = false;
let jannyPublicCollectionsLoaded = false;
let jannyPublicCollectionsError = '';
let jannyPublicCollectionsSort = 'latest';
let jannyCollectionDetailLoadToken = 0;
let jannyCollectionManageLoadToken = 0;
let jannyCollectionCharacters = [];
let jannyActiveCollection = null;
let jannyManageCollection = null;

// ========================================
// SEARCH API
// ========================================

async function searchJanny(opts = {}) {
    const { search = '', page = 1, limit = 80, sort = 'newest' } = opts;

    // Build MeiliSearch filter array from state
    const filters = [];
    filters.push(`totalToken >= ${jannyMinTokens}`);
    filters.push(`totalToken <= ${jannyMaxTokens}`);
    if (!jannyNsfwEnabled) filters.push('isNsfw = false');
    if (!jannyShowLowQuality) filters.push('isLowQuality = false');
    if (jannyIncludeTags.size > 0) {
        const tagClauses = [...jannyIncludeTags].map(id => `tagIds = ${id}`);
        filters.push(tagClauses.join(' AND '));
    }

    // MeiliSearch sort
    const sortMap = {
        newest: ['createdAtStamp:desc'],
        oldest: ['createdAtStamp:asc'],
        tokens_desc: ['totalToken:desc'],
        tokens_asc: ['totalToken:asc'],
        relevant: []
    };
    let sortArr = sortMap[sort] || sortMap.newest;

    const body = {
        queries: [{
            indexUid: 'janny-characters',
            q: search,
            facets: ['isLowQuality', 'isNsfw', 'tagIds', 'totalToken'],
            attributesToCrop: ['description:300'],
            cropMarker: '...',
            filter: filters,
            attributesToHighlight: ['name', 'description'],
            highlightPreTag: '__ais-highlight__',
            highlightPostTag: '__/ais-highlight__',
            hitsPerPage: limit,
            page
        }]
    };

    if (sortArr.length > 0) {
        body.queries[0].sort = sortArr;
    }

    const token = await getSearchToken();
    const headers = {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': JANNY_SITE_BASE,
        'Referer': `${JANNY_SITE_BASE}/`,
        'x-meilisearch-client': 'Meilisearch instant-meilisearch (v0.19.0) ; Meilisearch JavaScript (v0.41.0)'
    };

    let response;
    try {
        response = await fetch(JANNY_SEARCH_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (_) {
        response = await fetchWithProxy(JANNY_SEARCH_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`JannyAI search error ${response.status}: ${text}`);
    }

    return response.json();
}

// ========================================
// LOCAL LIBRARY LOOKUP
// ========================================

function isCharInLocalLibrary(jannyChar) {
    if (jannyChar.id && view._lookup.byProviderId.has(String(jannyChar.id))) return true;

    const name = (jannyChar.name || '').toLowerCase().trim();
    const creator = (jannyChar.creatorUsername || '').toLowerCase().trim();
    if (name && creator && view._lookup.byNameAndCreator.has(`${name}|${creator}`)) return true;

    return false;
}

function isCharPossibleMatchObj(h) {
    if (isCharInLocalLibrary(h)) return false;
    return view.isCharPossibleMatch(h.name || '', h.creatorUsername || '');
}

// ========================================
// CARD RENDERING
// ========================================

function applyTagsClamp(tagsEl) {
    if (!tagsEl) return;

    const existingToggle = tagsEl.querySelector('.browse-tags-more');
    if (existingToggle) existingToggle.remove();

    tagsEl.querySelectorAll('.browse-tag-hidden').forEach(tag => {
        tag.classList.remove('browse-tag-hidden');
    });

    tagsEl.classList.remove('browse-tags-collapsed', 'browse-tags-expanded');

    const tags = Array.from(tagsEl.querySelectorAll('.browse-tag'));
    if (!tags.length) return;

    tagsEl.classList.add('browse-tags-collapsed');

    const maxHeightValue = getComputedStyle(tagsEl).getPropertyValue('--browse-tags-max-height').trim();
    const maxHeight = parseFloat(maxHeightValue) || tagsEl.clientHeight || 64;

    let overflowIndex = -1;
    for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        const tagBottom = tag.offsetTop + tag.offsetHeight;
        if (tagBottom > maxHeight + 2) {
            overflowIndex = i;
            break;
        }
    }

    if (overflowIndex === -1) {
        tagsEl.classList.remove('browse-tags-collapsed');
        return;
    }

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'browse-tag browse-tags-more';
    toggle.textContent = '...';
    toggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isCollapsed = tagsEl.classList.contains('browse-tags-collapsed');
        if (isCollapsed) {
            tagsEl.classList.remove('browse-tags-collapsed');
            tagsEl.classList.add('browse-tags-expanded');
            tagsEl.querySelectorAll('.browse-tag-hidden').forEach(tag => tag.classList.remove('browse-tag-hidden'));
            tagsEl.appendChild(toggle);
        } else {
            applyTagsClamp(tagsEl);
        }
    });

    const insertIndex = Math.max(overflowIndex - 1, 0);
    tagsEl.insertBefore(toggle, tags[insertIndex]);
    for (let i = insertIndex; i < tags.length; i++) {
        tags[i].classList.add('browse-tag-hidden');
    }
}

function createJannyCard(hit) {
    const name = hit.name || 'Unknown';
    const desc = stripHtml(hit.description) || '';
    const avatarUrl = resolveJannyAvatarUrl(hit.avatar);
    const tags = resolveTagNames(hit.tagIds).slice(0, 3);
    const tokens = formatNumber(hit.totalToken || 0);
    const charId = hit.id || '';
    const slug = slugify(name);
    const creatorName = hit.creatorUsername || '';
    const inLibrary = isCharInLocalLibrary(hit);
    const possibleTier = inLibrary ? null : view.getPossibleMatchTier(hit.name || '', creatorName);
    const possibleMatch = !!possibleTier?.show;

    const badges = [];
    if (inLibrary) {
        badges.push('<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    } else if (possibleMatch) {
        badges.push(`<span class="browse-feature-badge possible-library pl-${possibleTier.tier}" title="${possibleTier.tooltip}"><i class="fa-solid fa-check"></i></span>`);
    }

    const createdDate = hit.createdAt
        ? new Date(hit.createdAt).toLocaleDateString()
        : (hit.createdAtStamp ? new Date(hit.createdAtStamp * 1000).toLocaleDateString() : '');
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';

    const cardClass = inLibrary ? 'browse-card in-library' : possibleMatch ? 'browse-card possible-library' : 'browse-card';

    return `
        <div class="${cardClass}" data-janny-id="${escapeHtml(String(charId))}" data-slug="${escapeHtml(slug)}" ${desc ? `title="${escapeHtml(desc)}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/ai4.png'">
                ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                ${creatorName ? `<span class="browse-card-creator-link" data-author="${escapeHtml(creatorName)}" title="Click to see all characters by ${escapeHtml(creatorName)}">${escapeHtml(creatorName)}</span>` : ''}
                <div class="browse-card-tags">
                    ${tags.map(t => `<span class="browse-card-tag" title="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('')}
                </div>
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Tokens"><i class="fa-solid fa-font"></i> ${tokens}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}

// ========================================
// IMAGE OBSERVER
// ========================================

function observeNewCards() {
    const grid = document.getElementById('jannyGrid');
    if (grid) jannyBrowseView.observeImages(grid);
}

// ========================================
// GRID RENDERING
// ========================================

function renderGrid(characters, append = false) {
    const grid = document.getElementById('jannyGrid');
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
        jannyGridRenderedCount = 0;
    }

    const startIdx = jannyGridRenderedCount;
    const html = characters.slice(startIdx).map(c => createJannyCard(c)).join('');
    grid.insertAdjacentHTML('beforeend', html);
    jannyGridRenderedCount = characters.length;

    observeNewCards(startIdx);
    updateLoadMore();
}

function updateLoadMore() {
    jannyBrowseView.updateLoadMoreVisibility('jannyLoadMore', jannyHasMore, jannyCharacters.length > 0);
}

// ========================================
// SEARCH / LOAD
// ========================================

async function loadCharacters(append = false) {
    if (append && jannyIsLoading) return;
    const thisToken = ++jannyLoadToken;
    jannyIsLoading = true;

    const grid = document.getElementById('jannyGrid');
    const loadMoreBtn = document.getElementById('jannyLoadMoreBtn');

    if (!append && grid) {
        renderSkeletonGrid(grid);
    }

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        if (jannyFilterOnlyBookmarked) {
            await loadBookmarkedIntoGrid(thisToken);
            return;
        }

        const effectiveSearch = jannyAuthorFilter || jannyCurrentSearch;
        const data = await searchJanny({
            search: effectiveSearch,
            page: jannyCurrentPage,
            limit: 80,
            sort: jannySortMode
        });

        if (thisToken !== jannyLoadToken) return;
        if (!delegatesInitialized) return;

        const result = data?.results?.[0];
        let hits = result?.hits || [];
        const totalPages = result?.totalPages || 1;

        // Client-side: persistent exclude tags from settings
        const jannyPersistentExclude = getProviderExcludeTags('janny');
        if (jannyPersistentExclude.length > 0) {
            const lowerExclude = jannyPersistentExclude.map(t => t.toLowerCase());
            hits = hits.filter(h => {
                const names = resolveTagNames(h.tagIds).map(n => n.toLowerCase());
                return !lowerExclude.some(et => names.includes(et));
            });
        }

        // Client-side: hide owned / possible match characters
        if (jannyFilterHideOwned) {
            hits = hits.filter(h => !isCharInLocalLibrary(h));
        }
        if (jannyFilterHidePossible) {
            hits = hits.filter(h => !isCharPossibleMatchObj(h));
        }

        // Auto-fetch when client-side filters remove too many results
        const hasClientFilters = jannyFilterHideOwned || jannyFilterHidePossible || jannyPersistentExclude.length > 0;
        if (hasClientFilters && jannyCurrentPage < totalPages) {
            let autoFetches = 0;
            while (hits.length < 80 && jannyCurrentPage < totalPages && autoFetches < 3 && delegatesInitialized) {
                autoFetches++;
                jannyCurrentPage++;
                const moreData = await searchJanny({
                    search: effectiveSearch,
                    page: jannyCurrentPage,
                    limit: 80,
                    sort: jannySortMode
                });
                if (thisToken !== jannyLoadToken || !delegatesInitialized) return;
                const moreResult = moreData?.results?.[0];
                let moreHits = moreResult?.hits || [];
                if (jannyPersistentExclude.length > 0) {
                    const lowerExclude = jannyPersistentExclude.map(t => t.toLowerCase());
                    moreHits = moreHits.filter(h => {
                        const names = resolveTagNames(h.tagIds).map(n => n.toLowerCase());
                        return !lowerExclude.some(et => names.includes(et));
                    });
                }
                if (jannyFilterHideOwned) moreHits = moreHits.filter(h => !isCharInLocalLibrary(h));
                if (jannyFilterHidePossible) moreHits = moreHits.filter(h => !isCharPossibleMatchObj(h));
                hits = hits.concat(moreHits);
            }
            if (autoFetches > 0) {
                debugLog(`[JannyBrowse] Auto-fetched ${autoFetches} extra page(s) to compensate for "hide owned" filter`);
            }
        }

        if (append) {
            const existingIds = new Set(jannyCharacters.map(c => c.id));
            jannyCharacters = jannyCharacters.concat(hits.filter(h => !h.id || !existingIds.has(h.id)));
        } else {
            jannyCharacters = hits;
        }

        jannyHasMore = jannyCurrentPage < totalPages;

        renderGrid(jannyCharacters, append);

        if (!append && jannyCharacters.length === 0) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid fa-ghost" style="font-size: 2rem; opacity: 0.5;"></i>
                    <p style="margin-top: 12px; font-weight: 600;">No matches on JannyAI</p>
                    <p style="margin-top: 8px; font-size: 0.9em;">Try a different search term or relax your tag filters. JannyAI search is keyword-based, broad terms tend to surface more results.</p>
                </div>
            `;
        }

        debugLog('[JannyBrowse] Loaded', hits.length, 'characters, page', jannyCurrentPage, '/', totalPages);

    } catch (err) {
        if (thisToken !== jannyLoadToken) return;
        console.error('[JannyBrowse] Search error:', err);
        showToast(`JannyAI search failed: ${err.message}`, 'error');
        if (!append && grid) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid fa-exclamation-triangle" style="font-size: 2rem; color: var(--cl-error-bright);"></i>
                    <p style="margin-top: 12px;">Search failed: ${escapeHtml(err.message)}</p>
                    <button class="glass-btn" style="margin-top: 12px;" id="jannyRetryBtn">
                        <i class="fa-solid fa-redo"></i> Retry
                    </button>
                </div>
            `;
            const retryBtn = document.getElementById('jannyRetryBtn');
            if (retryBtn) retryBtn.addEventListener('click', () => loadCharacters(false));
        }
    } finally {
        if (thisToken === jannyLoadToken) {
            jannyIsLoading = false;
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
            }
        }
    }
}

// Renders the account's bookmarked characters instead of search results while
// the "Only Bookmarked" feature filter is active. fetchJannyCharactersByIds
// chunks internally to respect cl-helper's path-length cap.
async function loadBookmarkedIntoGrid(thisToken) {
    const grid = document.getElementById('jannyGrid');
    const ids = [...await loadJannyBookmarks(true)];
    const fetched = await fetchJannyCharactersByIds(ids, jannyAccountOptions());
    if (thisToken !== jannyLoadToken || !delegatesInitialized) return;
    let chars = fetched.map(normalizeJannyCollectionCharacter).filter(Boolean);

    const query = (jannyAuthorFilter || jannyCurrentSearch || '').trim().toLowerCase();
    if (query) {
        chars = chars.filter(c => (c.name || '').toLowerCase().includes(query)
            || (c.description || '').toLowerCase().includes(query)
            || (c.creatorUsername || '').toLowerCase().includes(query));
    }
    if (jannyFilterHideOwned) chars = chars.filter(h => !isCharInLocalLibrary(h));
    if (jannyFilterHidePossible) chars = chars.filter(h => !isCharPossibleMatchObj(h));

    jannyCharacters = chars;
    jannyHasMore = false;
    renderGrid(jannyCharacters, false);

    if (jannyCharacters.length === 0 && grid) {
        grid.innerHTML = `
            <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                <i class="fa-regular fa-bookmark" style="font-size: 2rem; opacity: 0.5;"></i>
                <p style="margin-top: 12px; font-weight: 600;">${query ? 'No bookmarks match your search' : 'No Janny bookmarks yet'}</p>
                <p style="margin-top: 8px; font-size: 0.9em;">${query ? 'Clear the search to see all bookmarked cards.' : 'Bookmark cards from their preview to see them here.'}</p>
            </div>
        `;
    }
    debugLog('[JannyBrowse] Loaded', jannyCharacters.length, 'bookmarked characters');
}

// ========================================
// PREVIEW MODAL
// ========================================

let jannyDetailFetchToken = 0;
let jannyDetailFetchPromise = null;

function openPreviewModal(hit) {
    jannySelectedChar = hit;
    jannyCollectionDropdownOpen = false;
    jannyModalCollectionIds = new Set();
    jannyModalCollectionChecksLoadedFor = '';
    jannyCollectionRowMutations = new Set();

    const modal = document.getElementById('jannyCharModal');
    if (!modal) return;
    window.resetBrowseSectionCollapseState?.(modal);

    const name = hit.name || 'Unknown';
    const creatorNotes = stripHtml(hit.description) || '';
    const avatarUrl = resolveJannyAvatarUrl(hit.avatar);
    const tags = resolveTagNames(hit.tagIds);
    const tokens = formatNumber(hit.totalToken || 0);
    const charId = hit.id || '';
    const slug = slugify(name);
    const jannyUrl = `${JANNY_SITE_BASE}/characters/${charId}_character-${slug}`;
    const inLibrary = isCharInLocalLibrary(hit);
    const possibleMatch = !inLibrary && view.isCharPossibleMatch(hit.name || '', hit.creatorUsername || '');

    const createdDate = hit.createdAt
        ? new Date(hit.createdAt).toLocaleDateString()
        : (hit.createdAtStamp ? new Date(hit.createdAtStamp * 1000).toLocaleDateString() : '');

    // Header
    const avatarImg = document.getElementById('jannyCharAvatar');
    avatarImg.src = avatarUrl;
    avatarImg.onerror = () => { avatarImg.src = '/img/ai4.png'; };
    BrowseView.adjustPortraitPosition(avatarImg);
    document.getElementById('jannyCharName').textContent = name;
    document.getElementById('jannyCharCreator').textContent = hit.creatorUsername || hit.creatorId || 'Unknown';
    document.getElementById('jannyOpenInBrowserBtn').href = jannyUrl;

    // Stats
    document.getElementById('jannyCharTokens').textContent = tokens;
    document.getElementById('jannyCharDate').textContent = createdDate || 'Unknown';

    // Tags
    const tagsEl = document.getElementById('jannyCharTags');
    tagsEl.innerHTML = tags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
    requestAnimationFrame(() => applyTagsClamp(tagsEl));

    // Creator's Notes (website description - may include inline images from ella.janitorai.com)
    const rawDescription = hit.description || '';
    const creatorNotesSection = document.getElementById('jannyCharCreatorNotesSection');
    const creatorNotesEl = document.getElementById('jannyCharCreatorNotes');
    if (rawDescription.trim()) {
        creatorNotesSection.style.display = 'block';
        if (creatorNotesEl && !creatorNotesEl.querySelector('iframe')) creatorNotesEl.innerHTML = skeletonLines(3);
        deferCall(creatorNotesEl, () => renderCreatorNotesSecure(rawDescription, name, creatorNotesEl));
    } else {
        creatorNotesSection.style.display = 'none';
        if (creatorNotesEl) creatorNotesEl.innerHTML = '';
    }

    // Skeletons across all heavy sections during the fetchAndPopulate network wait.
    const descSection = document.getElementById('jannyCharDescriptionSection');
    const descEl = document.getElementById('jannyCharDescription');
    const scenarioSection = document.getElementById('jannyCharScenarioSection');
    const scenarioEl = document.getElementById('jannyCharScenario');
    const firstMsgSection = document.getElementById('jannyCharFirstMsgSection');
    const firstMsgEl = document.getElementById('jannyCharFirstMsg');
    const examplesSection = document.getElementById('jannyCharExamplesSection');
    const examplesEl = document.getElementById('jannyCharExamples');
    if (descSection && descEl) { descSection.style.display = 'block'; descEl.innerHTML = skeletonLines(3); }
    if (scenarioSection && scenarioEl) { scenarioSection.style.display = 'block'; scenarioEl.innerHTML = skeletonLines(2); }
    if (firstMsgSection && firstMsgEl) { firstMsgSection.style.display = 'block'; firstMsgEl.innerHTML = skeletonLines(4); }
    if (examplesSection && examplesEl) { examplesSection.style.display = 'block'; examplesEl.innerHTML = skeletonLines(3); }

    // Import button state
    const importBtn = document.getElementById('jannyImportBtn');
    if (inLibrary) {
        importBtn.innerHTML = '<i class="fa-solid fa-check"></i> In Library';
        importBtn.classList.add('secondary');
        importBtn.classList.remove('primary', 'warning');
    } else if (possibleMatch) {
        importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import (Possible Match)';
        importBtn.classList.add('warning');
        importBtn.classList.remove('primary', 'secondary');
    } else {
        importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
        importBtn.classList.add('primary');
        importBtn.classList.remove('secondary', 'warning');
    }
    importBtn.disabled = false;

    modal.classList.remove('hidden');
    const charBody = modal.querySelector('.browse-char-body');
    if (charBody) charBody.scrollTop = 0;

    // Fetch full details in background - store promise so Import can await it
    const fetchToken = ++jannyDetailFetchToken;
    jannyDetailFetchPromise = fetchAndPopulateDetails(hit, fetchToken);
    refreshJannyAccountControlsForSelection();
}

async function fetchAndPopulateDetails(hit, token) {
    const charId = hit.id || '';
    const slug = slugify(hit.name || 'character');
    const name = hit.name || 'Unknown';

    try {
        const provider = CoreAPI.getProvider('jannyai');
        if (!provider) return;

        let charData = null;
        try {
            const data = await provider.fetchMetadata(`${charId}_character-${slug}`);
            if (data) charData = data;
        } catch (e) {
            console.warn('[JannyBrowse] Detail fetch failed:', e.message);
        }

        // Stale check - user may have opened a different card
        if (token !== jannyDetailFetchToken) return;

        if (!charData) {
            const descSection = document.getElementById('jannyCharDescriptionSection');
            const descEl = document.getElementById('jannyCharDescription');
            if (descSection && descEl) {
                descSection.style.display = 'block';
                descEl.innerHTML = '<em style="color: var(--text-secondary, #888)">Could not load character definition. Cloudflare may be blocking the request; the character can still be imported with basic info.</em>';
            }
            return;
        }

        // Store full data on the selected char for import
        if (jannySelectedChar?.id === hit.id) {
            jannySelectedChar._fullData = charData;
        }

        // Update creator display with scraped username (MeiliSearch only has UUID)
        if (charData.creatorUsername && token === jannyDetailFetchToken) {
            const creatorEl = document.getElementById('jannyCharCreator');
            if (creatorEl) creatorEl.textContent = charData.creatorUsername;
            if (jannySelectedChar?.id === hit.id) {
                jannySelectedChar.creatorUsername = charData.creatorUsername;
            }
        }

        const personality = charData.personality || '';
        const scenario = charData.scenario || '';
        const firstMessage = charData.firstMessage || '';
        const exampleDialogs = charData.exampleDialogs || '';

        const descSection = document.getElementById('jannyCharDescriptionSection');
        const descEl = document.getElementById('jannyCharDescription');
        if (descSection) {
            if (personality) {
                descSection.style.display = 'block';
                if (descEl) deferRender(descEl, () => safePurify(formatRichText(personality, name, true), BROWSE_PURIFY_CONFIG));
            } else {
                descSection.style.display = 'none';
            }
        }

        const scenarioSection = document.getElementById('jannyCharScenarioSection');
        const scenarioEl = document.getElementById('jannyCharScenario');
        if (scenarioSection && scenario) {
            scenarioSection.style.display = 'block';
            if (scenarioEl) deferRender(scenarioEl, () => safePurify(formatRichText(scenario, name, true), BROWSE_PURIFY_CONFIG));
        } else if (scenarioSection) {
            scenarioSection.style.display = 'none';
        }

        const firstMsgSection = document.getElementById('jannyCharFirstMsgSection');
        const firstMsgEl = document.getElementById('jannyCharFirstMsg');
        if (firstMsgSection && firstMessage) {
            firstMsgSection.style.display = 'block';
            if (firstMsgEl) {
                deferRender(firstMsgEl, () => safePurify(formatRichText(firstMessage, name, true), BROWSE_PURIFY_CONFIG));
                firstMsgEl.dataset.fullContent = firstMessage;
            }
        } else if (firstMsgSection) {
            firstMsgSection.style.display = 'none';
        }

        const examplesSection = document.getElementById('jannyCharExamplesSection');
        const examplesEl = document.getElementById('jannyCharExamples');
        if (examplesSection && exampleDialogs) {
            examplesSection.style.display = 'block';
            if (examplesEl) deferRender(examplesEl, () => safePurify(formatRichText(exampleDialogs, name, true), BROWSE_PURIFY_CONFIG));
        } else if (examplesSection) {
            examplesSection.style.display = 'none';
        }
    } catch (err) {
        debugLog('[JannyBrowse] Detail fetch error:', err);
        if (token === jannyDetailFetchToken) {
            const descEl = document.getElementById('jannyCharDescription');
            if (descEl) descEl.innerHTML = '<em style="color: var(--text-secondary, #888)">Could not load character definition. The character can still be imported with basic info.</em>';
        }
    }
}

function cleanupJannyCharModal() {
    BrowseView.closeAvatarViewer();
    window.currentBrowseAltGreetings = null;
    const creatorEl = document.getElementById('jannyCharCreator');
    if (creatorEl) creatorEl.textContent = '';
    const sectionIds = [
        'jannyCharDescription',
        'jannyCharScenario',
        'jannyCharFirstMsg',
        'jannyCharExamples',
        'jannyCharAltGreetings',
        'jannyCharTags',
    ];
    for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    const notesEl = document.getElementById('jannyCharCreatorNotes');
    if (notesEl) cleanupCreatorNotesContainer(notesEl);
}

function closePreviewModal() {
    jannyDetailFetchToken++;
    closeJannyCollectionDropdown();
    jannyDetailFetchPromise = null;
    cleanupJannyCharModal();
    const modal = document.getElementById('jannyCharModal');
    if (modal) modal.classList.add('hidden');
    jannySelectedChar = null;
}

// ========================================
// IMPORT
// ========================================

async function importCharacter(charData) {
    if (!charData?.id) return;

    const charId = charData.id;
    const slug = slugify(charData.name || 'character');
    const identifier = `${charId}_character-${slug}`;

    const importBtn = document.getElementById('jannyImportBtn');
    if (importBtn) {
        importBtn.disabled = true;
        importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    }

    let inheritedGalleryId = null;

    try {
        const provider = CoreAPI.getProvider('jannyai');
        if (!provider?.importCharacter) throw new Error('JannyAI provider not available');

        // Wait for the detail fetch to finish so _fullData is populated
        if (jannyDetailFetchPromise) {
            try { await jannyDetailFetchPromise; } catch { /* ignore */ }
        }

        const fallbackData = charData._fullData || charData;
        if (!fallbackData.tagIds && charData.tagIds) {
            fallbackData.tagIds = charData.tagIds;
        }

        const charName = fallbackData.name || charData.name || '';
        const charCreator = charData.creatorUsername || fallbackData.creatorUsername || '';

        // === PRE-IMPORT DUPLICATE CHECK ===
        const duplicateMatches = await checkCharacterForDuplicatesAsync({
            name: charName,
            creator: charCreator,
            fullPath: identifier,
            description: fallbackData.personality || fallbackData.description || '',
            first_mes: fallbackData.firstMessage || '',
            scenario: fallbackData.scenario || ''
        });

        if (duplicateMatches && duplicateMatches.length > 0) {
            if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Duplicate found...';

            const avatarUrl = charData.avatar ? `${JANNY_IMAGE_BASE}${charData.avatar}` : '/img/ai4.png';
            const result = await showPreImportDuplicateWarning({
                name: charName,
                creator: charCreator,
                fullPath: identifier,
                avatarUrl
            }, duplicateMatches);

            if (result.choice === 'skip') {
                showToast('Import cancelled', 'info');
                if (importBtn) {
                    importBtn.disabled = false;
                    importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
                }
                return;
            }

            if (result.choice === 'replace') {
                const toReplace = duplicateMatches[0].char;
                inheritedGalleryId = getCharacterGalleryId(toReplace);
                if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Replacing...';
                const deleteSuccess = await deleteCharacter(toReplace, false);
                if (!deleteSuccess) {
                    console.warn('[JannyBrowse] Could not delete existing character, proceeding with import anyway');
                }
            }
        }
        // === END DUPLICATE CHECK ===

        if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';

        const result = await provider.importCharacter(identifier, fallbackData, { inheritedGalleryId });
        if (!result.success) throw new Error(result.error || 'Import failed');

        const mediaUrls = result.embeddedMediaUrls || [];
        const galleryPageUrls = result.galleryPageUrls || [];
        const showSummary = (mediaUrls.length > 0 || galleryPageUrls.length > 0)
            && getSetting('importMediaAction') !== 'none';

        const summaryArgs = {
            mediaCharacters: [{
                characterName: result.characterName,
                name: result.characterName,
                fileName: result.fileName,
                avatar: result.fileName,
                galleryId: result.galleryId,
                mediaUrls,
                galleryPageUrls,
                cardData: result.cardData
            }]
        };

        // Mobile holds preview behind summary for the fade; desktop snaps preview off first then opens summary.
        if (showSummary) {
            if (window.matchMedia?.('(max-width: 768px)').matches) {
                showImportSummaryModal(summaryArgs);
                await new Promise(r => setTimeout(r, 220));
                closePreviewModal();
            } else {
                closePreviewModal();
                await new Promise(r => requestAnimationFrame(r));
                showImportSummaryModal(summaryArgs);
            }
        } else {
            if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-check"></i> Imported';
            await new Promise(r => setTimeout(r, 350));
            closePreviewModal();
        }

        showToast(`Imported "${result.characterName}"`, 'success');

        // Lightweight single-character add (avoids OOM from full list reload on mobile)
        const added = await fetchAndAddCharacter(result.fileName);
        if (added) view.addCharToLookup(added);
        else await fetchCharacters(true);
        markCardAsImported(charId);

    } catch (err) {
        console.error('[JannyBrowse] Import failed:', err);
        showToast(`Import failed: ${err.message}`, 'error');
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
        }
    }
}

function markCardAsImported(charId) {
    const grid = document.getElementById('jannyGrid');
    if (!grid) return;
    const card = grid.querySelector(`[data-janny-id="${charId}"]`);
    if (!card) return;
    card.classList.add('in-library');
    card.classList.remove('possible-library');
    let badgesEl = card.querySelector('.browse-feature-badges');
    if (!badgesEl) {
        const imgWrap = card.querySelector('.browse-card-image');
        if (imgWrap) {
            imgWrap.insertAdjacentHTML('beforeend', '<div class="browse-feature-badges"></div>');
            badgesEl = imgWrap.querySelector('.browse-feature-badges');
        }
    }
    if (badgesEl) {
        badgesEl.querySelector('.possible-library')?.remove();
        if (!badgesEl.querySelector('.in-library')) {
            badgesEl.insertAdjacentHTML('afterbegin', '<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
        }
    }
}

// ========================================
// TAGS RENDERING
// ========================================

const ALL_TAGS = Object.entries(TAG_MAP)
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((a, b) => a.name.localeCompare(b.name));

function renderTagsList(filter = '') {
    const container = document.getElementById('jannyTagsList');
    if (!container) return;

    const filtered = filter
        ? ALL_TAGS.filter(t => t.name.toLowerCase().includes(filter.toLowerCase()))
        : ALL_TAGS;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    container.innerHTML = filtered.map(tag => {
        const included = jannyIncludeTags.has(tag.id);
        const stateClass = included ? 'state-include' : 'state-neutral';
        const stateIcon = included ? '<i class="fa-solid fa-plus"></i>' : '';
        const stateTitle = included ? 'Included (click to remove)' : 'Click to include';
        return `
            <div class="browse-tag-filter-item" data-tag-id="${tag.id}">
                <button class="browse-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label">${escapeHtml(tag.name)}</span>
            </div>
        `;
    }).join('');

    // Bind click handlers on tag items
    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const tagId = Number(item.dataset.tagId);
        const stateBtn = item.querySelector('.browse-tag-state-btn');

        item.addEventListener('click', () => {
            if (jannyIncludeTags.has(tagId)) {
                jannyIncludeTags.delete(tagId);
            } else {
                jannyIncludeTags.add(tagId);
            }
            cycleTagState(stateBtn, jannyIncludeTags.has(tagId));
            updateJannyTagsButton();
            jannyCurrentPage = 1;
            loadCharacters(false);
        });
    });
}

function cycleTagState(btn, included) {
    btn.className = 'browse-tag-state-btn';
    if (included) {
        btn.classList.add('state-include');
        btn.innerHTML = '<i class="fa-solid fa-plus"></i>';
        btn.title = 'Included (click to remove)';
    } else {
        btn.classList.add('state-neutral');
        btn.innerHTML = '';
        btn.title = 'Click to include';
    }
}

function updateJannyTagsButton() {
    const btn = document.getElementById('jannyTagsBtn');
    const label = document.getElementById('jannyTagsBtnLabel');
    if (!btn) return;

    const count = jannyIncludeTags.size;
    if (count > 0) {
        btn.classList.add('has-filters');
        if (label) label.innerHTML = `Tags <span class="tag-count">(${count})</span>`;
    } else {
        btn.classList.remove('has-filters');
        if (label) label.textContent = 'Tags';
    }
}

function updateJannyFiltersButton() {
    const btn = document.getElementById('jannyFiltersBtn');
    if (!btn) return;

    const active = jannyShowLowQuality || jannyFilterHideOwned || jannyFilterHidePossible || jannyFilterOnlyBookmarked;
    btn.classList.toggle('has-filters', active);
}

// ========================================
// EVENT WIRING
// ========================================

let delegatesInitialized = false;
let modalEventsAttached = false;

function initJannyView() {
    jannyNsfwEnabled = getSetting('jannyNsfw') === true;

    if (delegatesInitialized) return;
    delegatesInitialized = true;

    // Convert native selects to styled custom dropdowns
    const sortEl = document.getElementById('jannySortSelect');
    if (sortEl) CoreAPI.initCustomSelect?.(sortEl);
    const publicCollectionsSortEl = document.getElementById('jannyPublicCollectionsSort');
    if (publicCollectionsSortEl) CoreAPI.initCustomSelect?.(publicCollectionsSortEl);

    // Grid card click → open preview (delegation)
    const grid = document.getElementById('jannyGrid');
    if (grid) {
        grid.addEventListener('click', (e) => {
            const authorLink = e.target.closest('.browse-card-creator-link');
            if (authorLink) {
                e.stopPropagation();
                const author = authorLink.dataset.author;
                if (author) filterByAuthor(author);
                return;
            }

            const card = e.target.closest('.browse-card');
            if (!card) return;
            const charId = card.dataset.jannyId;
            if (!charId) return;
            const hit = jannyCharacters.find(c => String(c.id) === charId);
            if (hit) openPreviewModal(hit);
        });
    }

    // Search
    const collectionPanel = document.getElementById('jannyCollectionDetailPanel');
    if (collectionPanel) {
        collectionPanel.addEventListener('click', (e) => {
            const authorLink = e.target.closest('.browse-card-creator-link');
            if (authorLink) {
                e.stopPropagation();
                const author = authorLink.dataset.author;
                if (author) filterByAuthor(author);
                return;
            }
            const card = e.target.closest('.browse-card');
            if (!card) return;
            const charId = card.dataset.jannyId;
            const hit = jannyCollectionCharacters.find(c => String(c.id) === String(charId));
            if (hit) openPreviewModal(hit);
        });
    }
    on('jannySearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch();
        }
    });
    on('jannySearchInput', 'input', (e) => {
        const clearBtn = document.getElementById('jannyClearSearchBtn');
        if (clearBtn) clearBtn.classList.toggle('hidden', !e.target.value.trim());
    });
    on('jannySearchBtn', 'click', () => doSearch());
    on('jannyClearSearchBtn', 'click', () => {
        const input = document.getElementById('jannySearchInput');
        const clearBtn = document.getElementById('jannyClearSearchBtn');
        if (input) input.value = '';
        if (clearBtn) clearBtn.classList.add('hidden');
        jannyCurrentSearch = '';
        jannyAuthorFilter = null;
        jannyCurrentPage = 1;
        const authorBanner = document.getElementById('jannyAuthorBanner');
        if (authorBanner) authorBanner.classList.add('hidden');
        loadCharacters(false);
    });

    // Load More
    on('jannyLoadMoreBtn', 'click', () => {
        jannyCurrentPage++;
        loadCharacters(true);
    });

    // NSFW toggle
    on('jannyNsfwToggle', 'click', () => {
        jannyNsfwEnabled = !jannyNsfwEnabled;
        setSetting('jannyNsfw', jannyNsfwEnabled);
        updateNsfwToggle();
        jannyCurrentPage = 1;
        loadCharacters(false);
    });
    updateNsfwToggle();

    // Sort mode
    on('jannySortSelect', 'change', () => {
        const el = document.getElementById('jannySortSelect');
        if (el) jannySortMode = el.value;

        // Sync search input if user typed without pressing Enter
        const input = document.getElementById('jannySearchInput');
        if (input) jannyCurrentSearch = input.value.trim();

        jannyCurrentPage = 1;
        loadCharacters(false);
    });

    // Refresh
    // Author filter banner
    on('jannyClearAuthorBtn', 'click', () => clearAuthorFilter());

    on('jannyRefreshBtn', 'click', () => {
        const collectionsSection = document.getElementById('jannyCollectionsSection');
        if (collectionsSection && !collectionsSection.classList.contains('hidden')) {
            reloadJannyCollections();
            return;
        }
        jannyCurrentPage = 1;
        loadCharacters(false);
    });
    on('jannyCollectionsBtn', 'click', () => switchJannyCollectionsPanel(true));
    on('jannyBackToBrowseBtn', 'click', () => switchJannyCollectionsPanel(false));
    on('jannyCollectionsPublicBtn', 'click', () => setJannyCollectionsMode('public'));
    on('jannyCollectionsMineBtn', 'click', () => setJannyCollectionsMode('owned'));
    on('jannyPublicCollectionsSort', 'change', () => {
        const el = document.getElementById('jannyPublicCollectionsSort');
        jannyPublicCollectionsSort = el?.value === 'popular' ? 'popular' : 'latest';
        loadJannyPublicCollections({ reset: true });
    });
    on('jannyCreateCollectionBtn', 'click', () => createCollectionFromPanel());
    on('jannyNewCollectionName', 'keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); createCollectionFromPanel(); }
    });

    const collectionsSection = document.getElementById('jannyCollectionsSection');
    if (collectionsSection) {
        collectionsSection.addEventListener('click', (e) => {
            const ownerLink = e.target.closest('.janny-collection-owner-link');
            if (ownerLink) {
                e.preventDefault();
                const author = ownerLink.dataset.author;
                if (author) {
                    switchJannyCollectionsPanel(false);
                    filterByAuthor(author);
                }
                return;
            }
            const publicOpen = e.target.closest('.janny-public-collection-open');
            if (publicOpen) { openJannyPublicCollection(publicOpen.dataset.collectionPath); return; }
            const loadMorePublic = e.target.closest('#jannyPublicCollectionsLoadMoreBtn');
            if (loadMorePublic) { loadJannyPublicCollections(); return; }
            const ownedOpen = e.target.closest('.janny-owned-collection-open');
            if (ownedOpen) { openJannyOwnedCollection(ownedOpen.dataset.collectionId); return; }
            const ownedEdit = e.target.closest('.janny-owned-collection-edit');
            if (ownedEdit) { openJannyCollectionManage(ownedEdit.dataset.collectionId); return; }
            const ownedDelete = e.target.closest('.janny-owned-collection-delete');
            if (ownedDelete) { confirmAndDeleteJannyCollection(ownedDelete.dataset.collectionId); return; }
            const detailBack = e.target.closest('#jannyCollectionDetailBackBtn');
            if (detailBack) { setJannyCollectionsMode(jannyActiveCollection?.kind === 'owned' ? 'owned' : 'public'); return; }
            const manageBack = e.target.closest('#jannyManageBackBtn');
            if (manageBack) { setJannyCollectionsMode('owned'); return; }
            const manageSave = e.target.closest('#jannyManageSaveBtn');
            if (manageSave) { saveJannyManagedCollection(); return; }
            const managePrivate = e.target.closest('#jannyManagePrivateBtn');
            if (managePrivate && jannyManageCollection?.collection) { jannyManageCollection.collection.isPrivate = true; renderJannyCollectionManage(); return; }
            const managePublic = e.target.closest('#jannyManagePublicBtn');
            if (managePublic && jannyManageCollection?.collection) { jannyManageCollection.collection.isPrivate = false; renderJannyCollectionManage(); return; }
            const manageAdd = e.target.closest('#jannyManageAddCharacterBtn');
            if (manageAdd) { addCharacterToManagedCollection(); return; }
            const manageRemove = e.target.closest('.janny-manage-character-remove');
            if (manageRemove) { removeCharacterFromManagedCollection(manageRemove.dataset.characterId); return; }
            const manageDelete = e.target.closest('#jannyManageDeleteBtn');
            if (manageDelete) confirmAndDeleteJannyCollection(jannyManageCollection?.collection?.id);
        });
        collectionsSection.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target?.id === 'jannyManageAddCharacterInput') {
                e.preventDefault();
                addCharacterToManagedCollection();
            }
        });
    }
    // ── Tags dropdown ──
    const tagsDropdown = document.getElementById('jannyTagsDropdown');

    on('jannyTagsBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        if (filtersDropdown) filtersDropdown.classList.add('hidden');
        if (tagsDropdown) tagsDropdown.classList.toggle('hidden');
    });

    if (tagsDropdown) tagsDropdown.addEventListener('click', (e) => e.stopPropagation());

    renderTagsList();

    const tagSearchInput = document.getElementById('jannyTagsSearchInput');
    if (tagSearchInput) {
        const debouncedFilter = debounce((val) => renderTagsList(val), 200);
        tagSearchInput.addEventListener('input', () => debouncedFilter(tagSearchInput.value));
    }

    on('jannyTagsClearBtn', 'click', () => {
        jannyIncludeTags.clear();
        renderTagsList(document.getElementById('jannyTagsSearchInput')?.value || '');
        updateJannyTagsButton();
        jannyCurrentPage = 1;
        loadCharacters(false);
    });

    // Min/Max tokens
    const tokenDebounce = debounce(() => {
        jannyCurrentPage = 1;
        loadCharacters(false);
    }, 500);

    on('jannyMinTokens', 'change', () => {
        const el = document.getElementById('jannyMinTokens');
        if (el) jannyMinTokens = parseInt(el.value, 10) || 0;
        tokenDebounce();
    });
    on('jannyMaxTokens', 'change', () => {
        const el = document.getElementById('jannyMaxTokens');
        if (el) jannyMaxTokens = parseInt(el.value, 10) || 100000;
        tokenDebounce();
    });

    // ── Features dropdown ──
    const filtersDropdown = document.getElementById('jannyFiltersDropdown');

    on('jannyFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        if (tagsDropdown) tagsDropdown.classList.add('hidden');
        if (filtersDropdown) filtersDropdown.classList.toggle('hidden');
    });

    if (filtersDropdown) filtersDropdown.addEventListener('click', (e) => e.stopPropagation());

    on('jannyFilterLowQuality', 'change', () => {
        const el = document.getElementById('jannyFilterLowQuality');
        if (el) jannyShowLowQuality = el.checked;
        updateJannyFiltersButton();
        jannyCurrentPage = 1;
        loadCharacters(false);
    });

    on('jannyFilterHideOwned', 'change', () => {
        const el = document.getElementById('jannyFilterHideOwned');
        if (el) jannyFilterHideOwned = el.checked;
        updateJannyFiltersButton();
        jannyCurrentPage = 1;
        loadCharacters(false);
    });

    on('jannyFilterHidePossible', 'change', () => {
        const el = document.getElementById('jannyFilterHidePossible');
        if (el) jannyFilterHidePossible = el.checked;
        updateJannyFiltersButton();
        jannyCurrentPage = 1;
        loadCharacters(false);
    });

    on('jannyFilterOnlyBookmarked', 'change', async () => {
        const el = document.getElementById('jannyFilterOnlyBookmarked');
        if (!el) return;
        if (el.checked && !await ensureJannyAccountReady()) {
            el.checked = false;
            return;
        }
        jannyFilterOnlyBookmarked = el.checked;
        updateJannyFiltersButton();
        jannyCurrentPage = 1;
        loadCharacters(false);
    });

    // Close dropdowns when clicking outside
    jannyBrowseView._registerDropdownDismiss([
        { dropdownId: 'jannyTagsDropdown', buttonId: 'jannyTagsBtn' },
        { dropdownId: 'jannyFiltersDropdown', buttonId: 'jannyFiltersBtn' }
    ]);

    // ── Preview modal events (only attach once - modal DOM persists across provider switches) ──
    if (!modalEventsAttached) {
        modalEventsAttached = true;

        const jannyOverlay = document.getElementById('jannyCharModal');
        BrowseView.wireTitleScroll(document.getElementById('jannyCharName'), jannyOverlay, jannyOverlay?.querySelector('.browse-char-modal'));

        on('jannyCharClose', 'click', () => closePreviewModal());

        const creatorLink = document.getElementById('jannyCharCreator');
        if (creatorLink) {
            creatorLink.addEventListener('click', (e) => {
                e.preventDefault();
                const name = creatorLink.textContent.trim();
                if (name && name !== 'Unknown') {
                    closePreviewModal();
                    filterByAuthor(name);
                }
            });
        }

        // Avatar click → full-size image viewer (desktop only at event time; on mobile
        // bail before stopPropagation so the delegated tap runs)
        const jannyAvatar = document.getElementById('jannyCharAvatar');
        if (jannyAvatar) {
            jannyAvatar.addEventListener('click', (e) => {
                if (isMobileViewport()) return;
                e.stopPropagation();
                if (!jannyAvatar.src || jannyAvatar.src.endsWith('/img/ai4.png')) return;
                BrowseView.openAvatarViewer(jannyAvatar.src);
            });
        }

        on('jannyBookmarkBtn', 'click', () => toggleSelectedJannyBookmark());
        on('jannyCollectionDropdownBtn', 'click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openJannyCollectionDropdown();
        });
        on('jannyImportBtn', 'click', () => {
            if (jannySelectedChar) importCharacter(jannySelectedChar);
        });

        const collectionDropdown = document.getElementById('jannyCollectionDropdown');
        if (collectionDropdown) {
            collectionDropdown.addEventListener('click', (e) => {
                e.stopPropagation();
                const showOwned = e.target.closest('[data-action="show-owned"]');
                if (showOwned) {
                    closeJannyCollectionDropdown();
                    closePreviewModal();
                    switchJannyCollectionsPanel(true);
                    setJannyCollectionsMode('owned');
                    return;
                }
                const row = e.target.closest('.janny-collection-toggle-row[data-collection-id]');
                if (row) toggleSelectedJannyCollectionMembership(row.dataset.collectionId);
            });
        }

        document.addEventListener('click', (e) => {
            if (!jannyCollectionDropdownOpen) return;
            if (!e.target.closest('#jannyCollectionAction')) closeJannyCollectionDropdown();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && jannyCollectionDropdownOpen) closeJannyCollectionDropdown();
        });
        const modalOverlay = document.getElementById('jannyCharModal');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) closePreviewModal();
            });
        }

        window.registerOverlay?.({ id: 'jannyCharModal', tier: 7, close: () => closePreviewModal() });
        window.registerOverlay?.({ id: 'jannyAuthorBanner', tier: 9, close: () => clearAuthorFilter() });
    }
}

function doSearch() {
    const input = document.getElementById('jannySearchInput');
    const clearBtn = document.getElementById('jannyClearSearchBtn');
    const val = (input?.value || '').trim();

    if (jannyAuthorFilter) {
        jannyAuthorFilter = null;
        const banner = document.getElementById('jannyAuthorBanner');
        if (banner) banner.classList.add('hidden');
    }

    jannyCurrentSearch = val;
    jannyCurrentPage = 1;

    if (clearBtn) {
        clearBtn.classList.toggle('hidden', !val);
    }

    // When searching with text, default to relevance sort
    const sortSelect = document.getElementById('jannySortSelect');
    if (val && sortSelect && jannySortMode === 'newest') {
        jannySortMode = 'relevant';
        sortSelect.value = 'relevant';
    }

    loadCharacters(false);
}

function filterByAuthor(authorName) {
    jannyAuthorFilter = authorName;
    jannyCurrentSearch = '';
    jannyCurrentPage = 1;
    jannySortMode = 'relevant';

    const sortSelect = document.getElementById('jannySortSelect');
    if (sortSelect) sortSelect.value = 'relevant';

    const searchInput = document.getElementById('jannySearchInput');
    if (searchInput) searchInput.value = '';
    const clearBtn = document.getElementById('jannyClearSearchBtn');
    if (clearBtn) clearBtn.classList.add('hidden');

    const banner = document.getElementById('jannyAuthorBanner');
    const bannerName = document.getElementById('jannyAuthorBannerName');
    if (banner && bannerName) {
        bannerName.textContent = authorName;
        banner.classList.remove('hidden');
        window.pushOverlayGuard?.();
    }

    loadCharacters(false);
}

function clearAuthorFilter() {
    jannyAuthorFilter = null;

    const banner = document.getElementById('jannyAuthorBanner');
    if (banner) banner.classList.add('hidden');

    jannyCharacters = [];
    jannyCurrentPage = 1;
    loadCharacters(false);
}

function updateNsfwToggle() {
    const btn = document.getElementById('jannyNsfwToggle');
    if (!btn) return;

    if (jannyNsfwEnabled) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa-solid fa-fire"></i> <span>NSFW On</span>';
        btn.title = 'NSFW content enabled - click to show SFW only';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>';
        btn.title = 'Showing SFW only - click to include NSFW';
    }
}

// ========================================
// ACCOUNT SYNC
// ========================================

function jannyAccountOptions() {
    return {};
}

function describeJannyAccountError(err) {
    if (err?.cloudflare) {
        return 'Cloudflare challenged direct helper requests. Refresh the Janny Cookie header from a normal JannyAI tab; if it still 403s, JannyAI is rejecting non-browser helper sync.';
    }
    return err?.message || String(err || 'unknown error');
}

function collectionCharacterCount(collection) {
    if (Array.isArray(collection?.collectionCharacters)) return collection.collectionCharacters.length;
    if (Array.isArray(collection?.characters)) return collection.characters.length;
    return collection?.characterCount || collection?._count?.collectionCharacters || 0;
}

function normalizeJannyCollectionCharacter(item) {
    const raw = item?.character || item?.characters || item;
    if (!raw) return null;
    const c = raw.character || raw;
    const id = c.id || c.characterId || c.character_id || item?.characterId || item?.character_id || '';
    if (!id) return null;
    const name = c.name || c.title || 'Unknown';
    return {
        ...c,
        id,
        name,
        avatar: c.avatar || c.avatarUrl || c.image || c.imageUrl || c.image_url || c.botAvatar || c.profilePicture || c.profile_picture || '',
        description: c.description || c.creatorNotes || c.tagline || '',
        tagIds: c.tagIds || c.tag_ids || [],
        totalToken: c.totalToken || c.total_tokens || c.token_counts?.total_tokens || 0,
        creatorUsername: c.creatorUsername || c.creator_username || c.user?.username || c.creator?.username || '',
    };
}

// The cookie is persisted in extension settings (like every other provider's
// credentials). cl-helper only holds it in memory, so on load — after a server
// restart wiped that memory — re-push the saved cookie so the session survives.
async function restoreJannySessionFromSettings() {
    const savedCookie = getSetting('jannyCookie');
    if (!savedCookie) return;
    try {
        if (!await checkJannyPluginAvailable()) return;
        const session = await getJannySessionStatus();
        if (session?.active) return; // cl-helper still has it
        await setJannySessionCookie(savedCookie, getSetting('jannyUserAgent') || '');
        debugLog('[JannyBrowse] Restored saved account cookie into cl-helper');
    } catch (err) {
        debugLog('[JannyBrowse] Could not restore saved Janny cookie:', err.message);
    }
}

// Tracks account readiness for gating (ensureJannyAccountReady) only. There is
// no browse-view status indicator — cookie/login state is shown in Settings,
// matching every other provider.
async function refreshJannyAccountStatus({ validate = false } = {}) {
    const plugin = await checkJannyPluginAvailable();
    if (!plugin) {
        jannyAccountStatus = { plugin: false, active: false, valid: false, cloudflare: false, reason: 'cl-helper plugin not available' };
        return jannyAccountStatus;
    }

    const session = await getJannySessionStatus();
    jannyAccountStatus = { plugin: true, active: !!session?.active, valid: false, cloudflare: false, reason: session?.active ? '' : 'No JannyAI cookie stored' };
    if (validate && session?.active) {
        const result = await validateJannySession(jannyAccountOptions());
        jannyAccountStatus = {
            plugin: true,
            active: true,
            valid: !!result?.valid,
            cloudflare: !!result?.cloudflare,
            reason: result?.reason || '',
        };
    }
    return jannyAccountStatus;
}

async function ensureJannyAccountReady() {
    if (!jannyAccountStatus.plugin || !jannyAccountStatus.active) {
        await refreshJannyAccountStatus({ validate: false });
    }
    // cl-helper may have lost its in-memory session (e.g. server restarted
    // mid-session); re-push the persisted cookie before giving up.
    if (jannyAccountStatus.plugin && !jannyAccountStatus.active && getSetting('jannyCookie')) {
        await restoreJannySessionFromSettings();
        await refreshJannyAccountStatus({ validate: false });
    }
    if (!jannyAccountStatus.plugin) {
        showToast('Install cl-helper to use Janny account sync', 'warning');
        return false;
    }
    if (!jannyAccountStatus.active) {
        showToast('Connect your JannyAI account in Settings → Online → JannyAI', 'warning', 5000);
        return false;
    }
    return true;
}

async function loadJannyBookmarks(force = false) {
    if (jannyBookmarksLoaded && !force) return jannyBookmarkIds;
    if (!await ensureJannyAccountReady()) return jannyBookmarkIds;
    const ids = await fetchJannyBookmarks(jannyAccountOptions());
    jannyBookmarkIds = new Set(ids.map(String));
    jannyBookmarkTotalCount = ids.length;
    jannyBookmarksLoaded = true;
    updateJannyBookmarkButton();
    return jannyBookmarkIds;
}

function updateJannyBookmarkButton() {
    const btn = document.getElementById('jannyBookmarkBtn');
    if (!btn || !jannySelectedChar?.id) return;
    const id = String(jannySelectedChar.id);
    const isBookmarked = jannyBookmarkIds.has(id);
    const atLimit = !isBookmarked && (jannyBookmarkTotalCount || jannyBookmarkIds.size) >= JANNY_BOOKMARK_UI_LIMIT;
    btn.disabled = false;
    btn.classList.toggle('primary', !isBookmarked);
    btn.classList.toggle('secondary', isBookmarked);
    btn.title = atLimit
        ? `Janny bookmark UI is at its max (${JANNY_BOOKMARK_UI_LIMIT}). Remove one on Janny first, or use collections.`
        : (isBookmarked ? 'Remove from Janny bookmarks' : 'Save to Janny bookmarks');
    btn.innerHTML = isBookmarked
        ? '<i class="fa-solid fa-bookmark"></i> Bookmarked'
        : '<i class="fa-regular fa-bookmark"></i> Bookmark';
}

async function toggleSelectedJannyBookmark() {
    if (!jannySelectedChar?.id) return;
    if (!await ensureJannyAccountReady()) return;
    const btn = document.getElementById('jannyBookmarkBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Syncing...'; }

    try {
        if (!jannyBookmarksLoaded) await loadJannyBookmarks(true);
        const id = String(jannySelectedChar.id);
        if (jannyBookmarkIds.has(id)) {
            await removeJannyBookmarks([id], jannyAccountOptions());
            jannyBookmarkIds.delete(id);
            if (typeof jannyBookmarkTotalCount === 'number') jannyBookmarkTotalCount = Math.max(0, jannyBookmarkTotalCount - 1);
            showToast('Removed from Janny bookmarks', 'success');
        } else {
            if ((jannyBookmarkTotalCount || jannyBookmarkIds.size) >= JANNY_BOOKMARK_UI_LIMIT) {
                if (!jannyBookmarkLimitToastShown) {
                    jannyBookmarkLimitToastShown = true;
                    showToast(`Janny bookmarks are at the UI max (${JANNY_BOOKMARK_UI_LIMIT}). Remove one first, or use collections instead.`, 'warning', 7000);
                }
                return;
            }
            await addJannyBookmarks([id], jannyAccountOptions());
            jannyBookmarkIds.add(id);
            jannyBookmarkTotalCount = (jannyBookmarkTotalCount || jannyBookmarkIds.size - 1) + 1;
            showToast('Saved to Janny bookmarks', 'success');
        }
    } catch (err) {
        showToast(`Janny bookmark sync failed: ${describeJannyAccountError(err)}`, 'error', 8000);
    } finally {
        updateJannyBookmarkButton();
    }
}

function resolveJannyAvatarUrl(avatar) {
    const src = String(avatar || '').trim();
    if (!src) return '/img/ai4.png';
    if (/^(https?:)?\/\//i.test(src) || src.startsWith('/')) return src;
    return `${JANNY_IMAGE_BASE}${src}`;
}

function collectionIsPrivate(collection) {
    const raw = collection?.isPrivate ?? collection?.private ?? collection?.is_private;
    if (raw === undefined || raw === null || raw === '') return false;
    if (typeof raw === 'boolean') return raw;
    const value = String(raw).toLowerCase();
    return value === 'true' || value === 'yes' || value === '1' || value === 'private';
}

function collectionPrivacyLabel(collection) {
    return collectionIsPrivate(collection) ? 'Private' : 'Public';
}

function setOwnedCollectionCount(collection, count) {
    if (!collection) return;
    const next = Math.max(0, count);
    collection.characterCount = next;
    if (collection._count && typeof collection._count === 'object') collection._count.collectionCharacters = next;
}

function updateOwnedCollectionCount(collectionId, delta) {
    const collection = jannyOwnedCollections.find(c => String(c.id) === String(collectionId));
    if (collection) setOwnedCollectionCount(collection, collectionCharacterCount(collection) + delta);
    if (jannyManageCollection?.collection && String(jannyManageCollection.collection.id) === String(collectionId)) {
        setOwnedCollectionCount(jannyManageCollection.collection, collectionCharacterCount(jannyManageCollection.collection) + delta);
    }
}

function collectionEntryCharacterId(entry) {
    const raw = entry?.character || entry?.characters || entry;
    const c = raw?.character || raw;
    return c?.id || c?.characterId || c?.character_id || entry?.characterId || entry?.character_id || '';
}

function collectionHasPreviewImages(collection) {
    return getJannyCollectionPreviewImages(collection).length > 0;
}

async function hydrateJannyOwnedCollectionPreviews() {
    const token = ++jannyOwnedPreviewHydrationToken;
    const candidates = jannyOwnedCollections.filter(collection =>
        collection?.id && collectionCharacterCount(collection) > 0 && !collectionHasPreviewImages(collection)
    );
    if (!candidates.length) return;

    for (const collection of candidates) {
        try {
            const entries = await fetchJannyCollectionCharacters(collection.id, jannyAccountOptions());
            if (token !== jannyOwnedPreviewHydrationToken || !jannyOwnedCollectionsLoaded) return;

            let previewCharacters = entries.map(normalizeJannyCollectionCharacter).filter(Boolean);
            const missingIds = entries
                .map(collectionEntryCharacterId)
                .filter(id => id && !previewCharacters.some(c => String(c.id) === String(id)))
                .slice(0, Math.max(0, 4 - previewCharacters.length));
            if (missingIds.length) {
                const fetched = await fetchJannyCharactersByIds(missingIds, jannyAccountOptions());
                if (token !== jannyOwnedPreviewHydrationToken || !jannyOwnedCollectionsLoaded) return;
                previewCharacters = previewCharacters.concat(fetched.map(normalizeJannyCollectionCharacter).filter(Boolean));
            }

            previewCharacters = previewCharacters.filter(c => c.avatar).slice(0, 4);
            if (!previewCharacters.length) continue;
            collection.previewCharacters = previewCharacters;
            renderJannyOwnedCollectionsList();
        } catch (err) {
            debugLog('[JannyAccount] owned collection preview hydration failed:', err.message);
        }
    }
}

function getJannyCollectionPreviewImages(collection) {
    const pools = [
        collection?.images,
        collection?.previewImages,
        collection?.previewCharacters,
        collection?.collectionCharacters,
        collection?.characters,
        collection?.members,
    ];
    const images = [];
    for (const pool of pools) {
        if (!Array.isArray(pool)) continue;
        for (const item of pool) {
            const raw = item?.character || item?.characters || item;
            const c = raw?.character || raw;
            const src = typeof item === 'string'
                ? item
                : (c?.avatar || c?.avatarUrl || c?.image || c?.imageUrl || c?.image_url || c?.botAvatar || c?.profilePicture || c?.profile_picture || raw?.avatar || raw?.image || raw?.imageUrl || item?.avatar || item?.avatarUrl || item?.image || item?.imageUrl || '');
            if (src && !images.includes(src)) images.push(src);
            if (images.length >= 4) return images;
        }
    }
    return images;
}

function renderJannyCollectionPreviewCells(collection) {
    const images = getJannyCollectionPreviewImages(collection);
    const initials = String(collection?.name || 'J').trim().slice(0, 2).toUpperCase() || 'J';
    // One cell per card in the collection (max 4): a 2-card collection gets 2
    // tiles, not 2 tiles plus 2 initials fillers. Initials only stand in for
    // cards whose avatars aren't known (yet).
    const cellCount = Math.max(1, Math.min(4, Math.max(images.length, collectionCharacterCount(collection))));
    const cells = [];
    for (let i = 0; i < cellCount; i++) {
        const src = images[i];
        cells.push(src
            ? `<span class="janny-collection-preview-cell"><img src="${escapeHtml(resolveJannyAvatarUrl(src))}" alt="" loading="lazy" onerror="this.remove()"></span>`
            : `<span class="janny-collection-preview-cell janny-collection-preview-empty">${escapeHtml(initials)}</span>`);
    }
    return cells.join('');
}

function renderJannyCollectionOwnerLink(ownerName) {
    const owner = String(ownerName || '').trim();
    if (!owner) return '';
    return `<a href="#" class="creator-link janny-collection-owner-link" data-author="${escapeHtml(owner)}" title="Search characters by ${escapeHtml(owner)}">${escapeHtml(owner)}</a>`;
}

function formatJannyCollectionDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString();
}

function createJannyCollectionCard(collection, { owned = false } = {}) {
    const id = collection?.id || '';
    const path = collection?.path || '';
    const name = collection?.name || 'Untitled collection';
    const desc = stripHtml(collection?.description || '');
    const count = collectionCharacterCount(collection);
    const owner = collection?.ownerName || collection?.creatorUsername || collection?.user?.username || '';
    const views = typeof collection?.viewCount === 'number' ? collection.viewCount : null;
    const updated = formatJannyCollectionDate(collection?.updatedAt || collection?.updated_at || collection?.createdAt);
    const attrs = owned
        ? `data-collection-id="${escapeHtml(String(id))}"`
        : `data-collection-path="${escapeHtml(path)}"`;
    const openClass = owned ? 'janny-owned-collection-open' : 'janny-public-collection-open';
    const meta = [
        `<span><i class="fa-solid fa-layer-group"></i> ${formatNumber(count)} cards</span>`,
        owner ? `<span><i class="fa-solid fa-user"></i> ${renderJannyCollectionOwnerLink(owner)}</span>` : '',
        views !== null ? `<span><i class="fa-solid fa-eye"></i> ${formatNumber(views)} views</span>` : '',
        updated ? `<span><i class="fa-solid fa-clock"></i> ${escapeHtml(updated)}</span>` : '',
        owned ? `<span><i class="fa-solid ${collectionIsPrivate(collection) ? 'fa-lock' : 'fa-globe'}"></i> ${collectionPrivacyLabel(collection)}</span>` : '',
    ].filter(Boolean).join('');

    return `
        <article class="janny-collection-card" ${attrs}>
            <div class="janny-collection-preview" aria-hidden="true">${renderJannyCollectionPreviewCells(collection)}</div>
            <div class="janny-collection-card-body">
                <h3>${escapeHtml(name)}</h3>
                <p class="janny-collection-description">${desc ? escapeHtml(desc) : 'No description yet.'}</p>
                <div class="janny-collection-meta">${meta}</div>
                <div class="janny-collection-card-actions">
                    <button class="glass-btn ${openClass}" ${attrs}><i class="fa-solid fa-folder-open"></i> Open</button>
                    ${owned ? `<button class="glass-btn janny-owned-collection-edit" data-collection-id="${escapeHtml(String(id))}"><i class="fa-solid fa-pen"></i> Edit</button>` : ''}
                    ${owned ? `<button class="glass-btn janny-owned-collection-delete" data-collection-id="${escapeHtml(String(id))}"><i class="fa-solid fa-trash"></i> Delete</button>` : ''}
                </div>
            </div>
        </article>
    `;
}

function showJannyCollectionSurface(surface) {
    const publicBtn = document.getElementById('jannyCollectionsPublicBtn');
    const mineBtn = document.getElementById('jannyCollectionsMineBtn');
    publicBtn?.classList.toggle('active', jannyCollectionsMode === 'public');
    mineBtn?.classList.toggle('active', jannyCollectionsMode === 'owned');
    publicBtn?.setAttribute('aria-pressed', String(jannyCollectionsMode === 'public'));
    mineBtn?.setAttribute('aria-pressed', String(jannyCollectionsMode === 'owned'));

    document.getElementById('jannyPublicCollectionsToolbar')?.classList.toggle('hidden', surface !== 'public');
    document.getElementById('jannyPublicCollectionsList')?.classList.toggle('hidden', surface !== 'public');
    document.getElementById('jannyOwnedCreatePanel')?.classList.toggle('hidden', surface !== 'owned');
    document.getElementById('jannyOwnedCollectionsList')?.classList.toggle('hidden', surface !== 'owned');
    document.getElementById('jannyCollectionDetailPanel')?.classList.toggle('hidden', surface !== 'detail');
    document.getElementById('jannyCollectionManagePanel')?.classList.toggle('hidden', surface !== 'manage');
}

function setJannyCollectionsMode(mode) {
    const next = mode === 'owned' ? 'owned' : 'public';
    jannyCollectionsMode = next;
    jannyCollectionDetailLoadToken++;
    jannyCollectionManageLoadToken++;
    jannyActiveCollection = null;
    jannyManageCollection = null;
    showJannyCollectionSurface(next);
    if (next === 'public' && !jannyPublicCollectionsLoaded && !jannyPublicCollectionsLoading) {
        loadJannyPublicCollections({ reset: true }).catch(err => debugLog('[JannyAccount] public collections failed:', err.message));
    }
    if (next === 'owned' && !jannyOwnedCollectionsLoaded) {
        loadJannyOwnedCollections(false).catch(err => debugLog('[JannyAccount] owned collections failed:', err.message));
    }
}

async function loadJannyPublicCollections({ reset = false } = {}) {
    if (jannyPublicCollectionsLoading) return jannyPublicCollections;
    if (reset) {
        jannyPublicCollections = [];
        jannyPublicCollectionsPage = 1;
        jannyPublicCollectionsHasMore = true;
        jannyPublicCollectionsError = '';
        jannyPublicCollectionsLoaded = false;
    }
    if (!jannyPublicCollectionsHasMore && !reset) return jannyPublicCollections;

    jannyPublicCollectionsLoading = true;
    renderJannyPublicCollectionsList();
    try {
        const data = await fetchJannyPublicCollections({ sort: jannyPublicCollectionsSort, page: jannyPublicCollectionsPage });
        const seen = new Set(jannyPublicCollections.map(c => String(c.id || c.path)));
        for (const collection of (Array.isArray(data.collections) ? data.collections : [])) {
            const key = String(collection.id || collection.path || '');
            if (!key || seen.has(key)) continue;
            seen.add(key);
            jannyPublicCollections.push(collection);
        }
        jannyPublicCollectionsHasMore = !!data.hasMore;
        jannyPublicCollectionsPage += 1;
        jannyPublicCollectionsLoaded = true;
        jannyPublicCollectionsError = '';
    } catch (err) {
        jannyPublicCollectionsError = describeJannyAccountError(err);
        showToast(`Could not load public Janny collections: ${jannyPublicCollectionsError}`, 'error', 8000);
    } finally {
        jannyPublicCollectionsLoading = false;
        renderJannyPublicCollectionsList();
    }
    return jannyPublicCollections;
}

function renderJannyPublicCollectionsList() {
    const list = document.getElementById('jannyPublicCollectionsList');
    if (!list) return;
    if (jannyPublicCollectionsError && !jannyPublicCollections.length) {
        list.innerHTML = `<div class="browse-empty-state">${escapeHtml(jannyPublicCollectionsError)}</div>`;
        return;
    }
    if (jannyPublicCollectionsLoading && !jannyPublicCollections.length) {
        list.innerHTML = '<div class="browse-empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Loading public collections...</div>';
        return;
    }
    if (jannyPublicCollectionsLoaded && !jannyPublicCollections.length) {
        list.innerHTML = '<div class="browse-empty-state">No public Janny collections found.</div>';
        return;
    }
    const cards = jannyPublicCollections.map(collection => createJannyCollectionCard(collection, { owned: false })).join('');
    const more = jannyPublicCollectionsHasMore
        ? `<div class="browse-load-more"><button id="jannyPublicCollectionsLoadMoreBtn" class="glass-btn" ${jannyPublicCollectionsLoading ? 'disabled' : ''}><i class="fa-solid ${jannyPublicCollectionsLoading ? 'fa-spinner fa-spin' : 'fa-plus'}"></i> ${jannyPublicCollectionsLoading ? 'Loading...' : 'Load More'}</button></div>`
        : '';
    list.innerHTML = `<div class="janny-collection-card-grid">${cards}</div>${more}`;
}

async function loadJannyOwnedCollections(force = false) {
    if (jannyOwnedCollectionsLoaded && !force) return jannyOwnedCollections;
    if (!await ensureJannyAccountReady()) {
        renderJannyOwnedCollectionsList();
        renderJannyCollectionDropdown();
        return [];
    }
    const list = document.getElementById('jannyOwnedCollectionsList');
    try {
        jannyOwnedCollections = await fetchJannyCollections(jannyAccountOptions());
        jannyOwnedCollectionsLoaded = true;
        renderJannyOwnedCollectionsList();
        hydrateJannyOwnedCollectionPreviews().catch(err => debugLog('[JannyAccount] owned preview hydration failed:', err.message));
        renderJannyCollectionDropdown();
        return jannyOwnedCollections;
    } catch (err) {
        if (list) list.innerHTML = `<div class="browse-empty-state">${escapeHtml(describeJannyAccountError(err))}</div>`;
        showToast(`Could not load Janny collections: ${describeJannyAccountError(err)}`, 'error', 8000);
        return [];
    }
}

function renderJannyOwnedCollectionsList() {
    const list = document.getElementById('jannyOwnedCollectionsList');
    if (!list) return;
    if (!jannyOwnedCollectionsLoaded) {
        list.innerHTML = '<div class="browse-empty-state">Connect your JannyAI account to load your collections.</div>';
        return;
    }
    if (!jannyOwnedCollections.length) {
        list.innerHTML = '<div class="browse-empty-state">No Janny collections found. Create one above to start organizing cards.</div>';
        return;
    }
    list.innerHTML = `<div class="janny-collection-card-grid">${jannyOwnedCollections.map(c => createJannyCollectionCard(c, { owned: true })).join('')}</div>`;
}

function getCollectionEntries(collection) {
    if (Array.isArray(collection?.collectionCharacters)) return collection.collectionCharacters;
    if (Array.isArray(collection?.characters)) return collection.characters;
    return null;
}

function entryMatchesCharacter(entry, characterId) {
    const raw = entry?.character || entry?.characters || entry;
    const id = raw?.id || raw?.characterId || raw?.character_id || entry?.characterId || entry?.character_id || '';
    return String(id) === String(characterId);
}

async function refreshSelectedJannyCollectionMemberships() {
    const characterId = String(jannySelectedChar?.id || '');
    const membershipIds = new Set();
    if (!characterId || !jannyOwnedCollectionsLoaded) return jannyModalCollectionIds;

    for (const collection of jannyOwnedCollections) {
        const entries = getCollectionEntries(collection);
        if (entries) {
            if (entries.some(entry => entryMatchesCharacter(entry, characterId))) membershipIds.add(String(collection.id));
            continue;
        }
        if (!collection?.id || collectionCharacterCount(collection) <= 0) continue;
        try {
            const fetched = await fetchJannyCollectionCharacters(collection.id, jannyAccountOptions());
            if (String(jannySelectedChar?.id || '') !== characterId) return jannyModalCollectionIds;
            if (Array.isArray(fetched) && fetched.some(entry => entryMatchesCharacter(entry, characterId))) {
                membershipIds.add(String(collection.id));
            }
        } catch (err) {
            debugLog('[JannyAccount] membership check failed:', err.message);
        }
    }
    if (String(jannySelectedChar?.id || '') !== characterId) return jannyModalCollectionIds;
    jannyModalCollectionIds = membershipIds;
    jannyModalCollectionChecksLoadedFor = characterId;
    return jannyModalCollectionIds;
}

function renderJannyCollectionDropdown() {
    const dropdown = document.getElementById('jannyCollectionDropdown');
    const btn = document.getElementById('jannyCollectionDropdownBtn');
    if (!dropdown) return;
    dropdown.classList.toggle('hidden', !jannyCollectionDropdownOpen);
    if (btn) btn.setAttribute('aria-expanded', String(jannyCollectionDropdownOpen));
    if (!jannyCollectionDropdownOpen) return;

    if (!jannyAccountStatus.active) {
        dropdown.innerHTML = '<div class="janny-collection-dropdown-title">Janny collections</div><div class="janny-collection-dropdown-empty">Connect your JannyAI account in Settings to use owned collections.</div>';
        return;
    }
    if (!jannyOwnedCollectionsLoaded) {
        dropdown.innerHTML = '<div class="janny-collection-dropdown-title">Janny collections</div><div class="janny-collection-dropdown-empty"><i class="fa-solid fa-spinner fa-spin"></i> Loading collections...</div>';
        return;
    }
    if (!jannyOwnedCollections.length) {
        dropdown.innerHTML = `
            <div class="janny-collection-dropdown-title">Janny collections</div>
            <div class="janny-collection-dropdown-empty">No collections yet.</div>
            <button class="janny-collection-toggle-row" data-action="show-owned"><i class="fa-solid fa-plus"></i><span>Create one in My Collections</span></button>
        `;
        return;
    }

    const rows = jannyOwnedCollections.map(collection => {
        const id = String(collection.id || '');
        const isMember = jannyModalCollectionIds.has(id);
        const isLoading = jannyCollectionRowMutations.has(id);
        return `
            <button class="janny-collection-toggle-row ${isMember ? 'is-member' : ''}" data-collection-id="${escapeHtml(id)}" role="menuitemcheckbox" aria-checked="${isMember}">
                <i class="fa-solid ${isLoading ? 'fa-spinner fa-spin' : isMember ? 'fa-check' : 'fa-plus'}"></i>
                <span class="janny-collection-toggle-name">${escapeHtml(collection.name || 'Untitled')}</span>
                <span class="janny-collection-toggle-meta">${formatNumber(collectionCharacterCount(collection))} <i class="fa-solid ${collectionIsPrivate(collection) ? 'fa-lock' : 'fa-globe'}"></i></span>
            </button>
        `;
    }).join('');
    dropdown.innerHTML = `<div class="janny-collection-dropdown-title">Add to collection</div>${rows}`;
}

async function openJannyCollectionDropdown() {
    if (jannyCollectionDropdownOpen) {
        closeJannyCollectionDropdown();
        return;
    }
    jannyCollectionDropdownOpen = true;
    renderJannyCollectionDropdown();
    if (!await ensureJannyAccountReady()) {
        renderJannyCollectionDropdown();
        return;
    }
    await loadJannyOwnedCollections(false);
    if (jannySelectedChar?.id && jannyModalCollectionChecksLoadedFor !== String(jannySelectedChar.id)) {
        await refreshSelectedJannyCollectionMemberships();
    }
    renderJannyCollectionDropdown();
}

function closeJannyCollectionDropdown() {
    jannyCollectionDropdownOpen = false;
    renderJannyCollectionDropdown();
}

async function toggleSelectedJannyCollectionMembership(collectionId) {
    const characterId = String(jannySelectedChar?.id || '');
    const characterName = jannySelectedChar?.name || 'character';
    if (!characterId || !collectionId) return;
    if (!await ensureJannyAccountReady()) return;
    const collection = jannyOwnedCollections.find(c => String(c.id) === String(collectionId));
    const name = collection?.name || 'collection';
    const wasMember = jannyModalCollectionIds.has(String(collectionId));
    jannyCollectionRowMutations.add(String(collectionId));
    renderJannyCollectionDropdown();
    try {
        if (wasMember) {
            await removeJannyCharacterFromCollection(collectionId, characterId, jannyAccountOptions());
            if (String(jannySelectedChar?.id || '') === characterId) jannyModalCollectionIds.delete(String(collectionId));
            updateOwnedCollectionCount(collectionId, -1);
            showToast(`Removed ${characterName} from ${name}.`, 'success');
        } else {
            await addJannyCharacterToCollection(collectionId, characterId, jannyAccountOptions());
            if (String(jannySelectedChar?.id || '') === characterId) jannyModalCollectionIds.add(String(collectionId));
            updateOwnedCollectionCount(collectionId, 1);
            showToast(`Added ${characterName} to ${name}.`, 'success');
        }
        renderJannyOwnedCollectionsList();
        if (jannyActiveCollection?.kind === 'owned' && String(jannyActiveCollection.id) === String(collectionId)) {
            openJannyOwnedCollection(collectionId);
        }
    } catch (err) {
        showToast(`Could not update collection: ${describeJannyAccountError(err)}`, 'error', 8000);
    } finally {
        jannyCollectionRowMutations.delete(String(collectionId));
        if (String(jannySelectedChar?.id || '') === characterId) renderJannyCollectionDropdown();
    }
}

function renderJannyCollectionCharactersGrid() {
    const grid = document.getElementById('jannyCollectionCharactersGrid');
    if (!grid) return;
    if (!jannyActiveCollection) {
        grid.innerHTML = '';
        return;
    }
    if (!jannyCollectionCharacters.length) {
        grid.innerHTML = '<div style="grid-column: 1 / -1; padding: 24px; color: var(--text-muted); text-align: center;">No cards in this collection.</div>';
        return;
    }
    grid.innerHTML = jannyCollectionCharacters.map(c => createJannyCard(c)).join('');
    jannyBrowseView.observeImages(grid);
}

function renderJannyCollectionDetail({ loading = false, error = '' } = {}) {
    const panel = document.getElementById('jannyCollectionDetailPanel');
    if (!panel) return;
    showJannyCollectionSurface('detail');
    if (loading) {
        panel.innerHTML = '<div class="browse-empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Loading collection...</div>';
        return;
    }
    if (error) {
        panel.innerHTML = `<div class="browse-empty-state" style="color: var(--cl-error-bright);">${escapeHtml(error)}</div>`;
        return;
    }
    const collection = jannyActiveCollection || {};
    const desc = stripHtml(collection.description || '');
    const updated = formatJannyCollectionDate(collection.updatedAt || collection.updated_at || '');
    panel.innerHTML = `
        <div class="janny-collection-detail">
            <div class="browse-author-banner">
                <div class="browse-author-banner-content">
                    <i class="fa-solid fa-folder-open"></i>
                    <span><strong>${escapeHtml(collection.name || 'Collection')}</strong> <span class="browse-author-banner-hint">${escapeHtml(collection.kind === 'owned' ? 'My collection' : 'Public collection')}</span></span>
                </div>
                <div class="browse-author-banner-actions">
                    <button id="jannyCollectionDetailBackBtn" class="glass-btn"><i class="fa-solid fa-arrow-left"></i> Back</button>
                </div>
            </div>
            ${updated ? `<p class="janny-collection-detail-updated">Last updated: ${escapeHtml(updated)}</p>` : ''}
            ${desc ? `<p class="janny-collection-detail-description">${escapeHtml(desc)}</p>` : ''}
            <div class="janny-collection-meta janny-collection-detail-meta">
                <span class="janny-collection-meta-box"><i class="fa-solid fa-layer-group"></i> ${formatNumber(collectionCharacterCount(collection) || jannyCollectionCharacters.length)} cards</span>
                ${collection.ownerName ? `<span class="janny-collection-meta-box"><i class="fa-solid fa-user"></i> ${renderJannyCollectionOwnerLink(collection.ownerName)}</span>` : ''}
                ${typeof collection.viewCount === 'number' ? `<span class="janny-collection-meta-box"><i class="fa-solid fa-eye"></i> ${formatNumber(collection.viewCount)} views</span>` : ''}
                ${collection.kind === 'owned' ? `<span class="janny-collection-meta-box"><i class="fa-solid ${collectionIsPrivate(collection) ? 'fa-lock' : 'fa-globe'}"></i> ${collectionPrivacyLabel(collection)}</span>` : ''}
            </div>
            <div id="jannyCollectionCharactersGrid" class="browse-grid"></div>
        </div>
    `;
    renderJannyCollectionCharactersGrid();
}

async function openJannyPublicCollection(path) {
    if (!path) return;
    const requestedPath = String(path);
    const token = ++jannyCollectionDetailLoadToken;
    jannyActiveCollection = { kind: 'public', path: requestedPath, name: 'Public collection' };
    jannyCollectionCharacters = [];
    renderJannyCollectionDetail({ loading: true });
    try {
        const data = await fetchJannyPublicCollection(requestedPath);
        const characterIds = Array.isArray(data.characterIds) ? data.characterIds : [];
        const fetched = await fetchJannyPublicCharactersByIds(characterIds);
        if (token !== jannyCollectionDetailLoadToken || jannyActiveCollection?.kind !== 'public' || String(jannyActiveCollection.path || '') !== requestedPath) return;
        jannyActiveCollection = { kind: 'public', ...(data.collection || {}) };
        jannyCollectionCharacters = fetched.map(normalizeJannyCollectionCharacter).filter(Boolean);
        renderJannyCollectionDetail();
    } catch (err) {
        if (token !== jannyCollectionDetailLoadToken || jannyActiveCollection?.kind !== 'public' || String(jannyActiveCollection.path || '') !== requestedPath) return;
        renderJannyCollectionDetail({ error: describeJannyAccountError(err) });
        showToast(`Could not load public Janny collection: ${describeJannyAccountError(err)}`, 'error', 8000);
    }
}

async function openJannyOwnedCollection(collectionId) {
    if (!collectionId) return;
    if (!await ensureJannyAccountReady()) return;
    const requestedId = String(collectionId);
    const token = ++jannyCollectionDetailLoadToken;
    jannyActiveCollection = { kind: 'owned', id: requestedId, name: 'Collection' };
    jannyCollectionCharacters = [];
    renderJannyCollectionDetail({ loading: true });
    try {
        const collection = jannyOwnedCollections.find(c => String(c.id) === requestedId) || { id: requestedId, name: 'Collection' };
        let entries = await fetchJannyCollectionCharacters(requestedId, jannyAccountOptions());
        let chars = entries.map(normalizeJannyCollectionCharacter).filter(Boolean);
        const missingDetailIds = entries
            .map(collectionEntryCharacterId)
            .filter(id => id && !chars.some(c => String(c.id) === String(id)));
        if (missingDetailIds.length) {
            const fetched = await fetchJannyCharactersByIds(missingDetailIds, jannyAccountOptions());
            chars = chars.concat(fetched.map(normalizeJannyCollectionCharacter).filter(Boolean));
        }
        if (token !== jannyCollectionDetailLoadToken || jannyActiveCollection?.kind !== 'owned' || String(jannyActiveCollection.id || '') !== requestedId) return;
        jannyActiveCollection = { kind: 'owned', ...collection };
        jannyCollectionCharacters = chars;
        renderJannyCollectionDetail();
    } catch (err) {
        if (token !== jannyCollectionDetailLoadToken || jannyActiveCollection?.kind !== 'owned' || String(jannyActiveCollection.id || '') !== requestedId) return;
        renderJannyCollectionDetail({ error: describeJannyAccountError(err) });
        showToast(`Could not load Janny collection: ${describeJannyAccountError(err)}`, 'error', 8000);
    }
}

async function createCollectionFromPanel() {
    const nameEl = document.getElementById('jannyNewCollectionName');
    const descEl = document.getElementById('jannyNewCollectionDescription');
    const privateEl = document.getElementById('jannyNewCollectionPrivate');
    const errorEl = document.getElementById('jannyCreateCollectionError');
    const name = (nameEl?.value || '').trim();

    if (errorEl) { errorEl.classList.add('hidden'); errorEl.innerHTML = ''; }

    if (!name) {
        showToast('Name the collection first', 'warning');
        return;
    }
    if (!await ensureJannyAccountReady()) return;
    try {
        const isPrivate = privateEl ? !!privateEl.checked : true;
        await createJannyCollection({ name, description: descEl?.value || '', isPrivate }, jannyAccountOptions());
        if (nameEl) nameEl.value = '';
        if (descEl) descEl.value = '';
        jannyOwnedCollectionsLoaded = false;
        await loadJannyOwnedCollections(true);
        showToast('Janny collection created', 'success');
    } catch (err) {
        if (errorEl) {
            errorEl.classList.remove('hidden');
            errorEl.innerHTML = `Couldn't create the collection here (${escapeHtml(describeJannyAccountError(err))}). <a href="${JANNY_SITE_BASE}/collections/new" target="_blank" rel="noopener noreferrer">Create it on JannyAI</a> instead.`;
        } else {
            showToast(`Create collection failed: ${describeJannyAccountError(err)}`, 'error', 8000);
        }
    }
}

async function openJannyCollectionManage(collectionId) {
    if (!collectionId) return;
    if (!await ensureJannyAccountReady()) return;
    const requestedId = String(collectionId);
    const collection = jannyOwnedCollections.find(c => String(c.id) === requestedId);
    if (!collection) {
        showToast('Collection not found', 'warning');
        return;
    }
    const token = ++jannyCollectionManageLoadToken;
    jannyManageCollection = { collection: { ...collection }, characters: [], saving: false, error: '' };
    renderJannyCollectionManage({ loading: true });
    try {
        const entries = await fetchJannyCollectionCharacters(requestedId, jannyAccountOptions());
        let chars = entries.map(normalizeJannyCollectionCharacter).filter(Boolean);
        const missingDetailIds = entries
            .map(collectionEntryCharacterId)
            .filter(id => id && !chars.some(c => String(c.id) === String(id)));
        if (missingDetailIds.length) {
            const fetched = await fetchJannyCharactersByIds(missingDetailIds, jannyAccountOptions());
            chars = chars.concat(fetched.map(normalizeJannyCollectionCharacter).filter(Boolean));
        }
        if (token !== jannyCollectionManageLoadToken || String(jannyManageCollection?.collection?.id || '') !== requestedId) return;
        jannyManageCollection.characters = chars;
        renderJannyCollectionManage();
    } catch (err) {
        if (token !== jannyCollectionManageLoadToken || String(jannyManageCollection?.collection?.id || '') !== requestedId) return;
        jannyManageCollection.error = describeJannyAccountError(err);
        renderJannyCollectionManage();
    }
}

function renderJannyCollectionManage({ loading = false } = {}) {
    const panel = document.getElementById('jannyCollectionManagePanel');
    if (!panel) return;
    showJannyCollectionSurface('manage');
    if (loading || !jannyManageCollection) {
        panel.innerHTML = '<div class="browse-empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Loading collection editor...</div>';
        return;
    }
    const collection = jannyManageCollection.collection;
    const isPrivate = collectionIsPrivate(collection);
    const rows = jannyManageCollection.characters.map(c => `
        <div class="janny-manage-character-row" data-character-id="${escapeHtml(String(c.id))}">
            <img src="${escapeHtml(resolveJannyAvatarUrl(c.avatar))}" alt="" loading="lazy" onerror="this.src='/img/ai4.png'">
            <div><strong>${escapeHtml(c.name || 'Unknown')}</strong>${c.creatorUsername ? `<span>${escapeHtml(c.creatorUsername)}</span>` : ''}</div>
            <button class="glass-btn icon-only janny-manage-character-remove" data-character-id="${escapeHtml(String(c.id))}" title="Remove from collection"><i class="fa-solid fa-xmark"></i></button>
        </div>
    `).join('');

    panel.innerHTML = `
        <div class="janny-collection-manage">
            <div class="browse-author-banner">
                <div class="browse-author-banner-content">
                    <i class="fa-solid fa-pen"></i>
                    <span><strong>Edit collection</strong> <span class="browse-author-banner-hint">Metadata and membership</span></span>
                </div>
                <div class="browse-author-banner-actions">
                    <button id="jannyManageBackBtn" class="glass-btn"><i class="fa-solid fa-arrow-left"></i> My Collections</button>
                </div>
            </div>
            ${jannyManageCollection.error ? `<div class="browse-empty-state" style="color: var(--cl-error-bright);">${escapeHtml(jannyManageCollection.error)}</div>` : ''}
            <label>Name <input id="jannyManageCollectionName" class="glass-input" value="${escapeHtml(collection.name || '')}" autocomplete="one-time-code"></label>
            <label>Description <textarea id="jannyManageCollectionDescription" class="glass-input" rows="3">${escapeHtml(collection.description || '')}</textarea></label>
            <div class="janny-collection-segmented" role="group" aria-label="Collection privacy">
                <button id="jannyManagePrivateBtn" class="glass-btn ${isPrivate ? 'active' : ''}" aria-pressed="${isPrivate}"><i class="fa-solid fa-lock"></i> Private</button>
                <button id="jannyManagePublicBtn" class="glass-btn ${!isPrivate ? 'active' : ''}" aria-pressed="${!isPrivate}"><i class="fa-solid fa-globe"></i> Public</button>
            </div>
            <div class="janny-collection-toolbar">
                <button id="jannyManageSaveBtn" class="glass-btn"><i class="fa-solid fa-save"></i> Save</button>
                <button id="jannyManageDeleteBtn" class="glass-btn"><i class="fa-solid fa-trash"></i> Delete</button>
                <span class="browse-author-banner-hint">Changes save back to JannyAI.</span>
            </div>
            <div class="janny-collection-toolbar">
                <input id="jannyManageAddCharacterInput" class="glass-input" placeholder="Paste a Janny character URL or UUID" autocomplete="one-time-code">
                <button id="jannyManageAddCharacterBtn" class="glass-btn"><i class="fa-solid fa-plus"></i> Add</button>
            </div>
            <h3 class="browse-section-title"><i class="fa-solid fa-users"></i> Characters (${jannyManageCollection.characters.length})</h3>
            <div class="janny-manage-character-list">${rows || '<div class="browse-empty-state">No cards in this collection.</div>'}</div>
        </div>
    `;
}

async function saveJannyManagedCollection() {
    if (!jannyManageCollection?.collection?.id) return;
    const collection = jannyManageCollection.collection;
    const name = (document.getElementById('jannyManageCollectionName')?.value || '').trim();
    const description = document.getElementById('jannyManageCollectionDescription')?.value || '';
    if (!name) {
        showToast('Name the collection first', 'warning');
        return;
    }
    try {
        await updateJannyCollection({ id: collection.id, name, description, isPrivate: collectionIsPrivate(collection) }, jannyAccountOptions());
        collection.name = name;
        collection.description = description;
        const existing = jannyOwnedCollections.find(c => String(c.id) === String(collection.id));
        if (existing) Object.assign(existing, collection);
        renderJannyOwnedCollectionsList();
        renderJannyCollectionManage();
        showToast('Collection saved.', 'success');
    } catch (err) {
        showToast(`Could not save collection: ${describeJannyAccountError(err)}`, 'error', 8000);
    }
}

function parseJannyCharacterIdFromInput(value) {
    const text = String(value || '').trim();
    const match = text.match(/\/characters\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:_[^/?#\s]+)?/i)
        || text.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
    return match ? match[1] : '';
}

async function addCharacterToManagedCollection() {
    if (!jannyManageCollection?.collection?.id) return;
    const input = document.getElementById('jannyManageAddCharacterInput');
    const id = parseJannyCharacterIdFromInput(input?.value || '');
    if (!id) {
        showToast('Paste a valid Janny character URL or UUID', 'warning');
        return;
    }
    if (jannyManageCollection.characters.some(c => String(c.id) === String(id))) {
        showToast('That character is already in this collection', 'info');
        return;
    }
    try {
        await addJannyCharacterToCollection(jannyManageCollection.collection.id, id, jannyAccountOptions());
        const fetched = await fetchJannyCharactersByIds([id], jannyAccountOptions());
        const normalized = fetched.map(normalizeJannyCollectionCharacter).filter(Boolean)[0] || { id, name: id, avatar: '' };
        jannyManageCollection.characters.push(normalized);
        updateOwnedCollectionCount(jannyManageCollection.collection.id, 1);
        if (input) input.value = '';
        renderJannyOwnedCollectionsList();
        renderJannyCollectionManage();
        showToast('Character added to collection.', 'success');
    } catch (err) {
        showToast(`Could not add character: ${describeJannyAccountError(err)}`, 'error', 8000);
    }
}

async function removeCharacterFromManagedCollection(characterId) {
    if (!jannyManageCollection?.collection?.id || !characterId) return;
    try {
        await removeJannyCharacterFromCollection(jannyManageCollection.collection.id, characterId, jannyAccountOptions());
        jannyManageCollection.characters = jannyManageCollection.characters.filter(c => String(c.id) !== String(characterId));
        updateOwnedCollectionCount(jannyManageCollection.collection.id, -1);
        renderJannyOwnedCollectionsList();
        renderJannyCollectionManage();
        showToast('Character removed from collection.', 'success');
    } catch (err) {
        showToast(`Could not remove character: ${describeJannyAccountError(err)}`, 'error', 8000);
    }
}

async function confirmAndDeleteJannyCollection(collectionId) {
    if (!collectionId) return;
    const ok = showConfirm
        ? await showConfirm({ title: 'Delete Janny collection?', message: 'This cannot be undone from Character Library.', confirmText: 'Delete', cancelText: 'Cancel', danger: true, icon: 'fa-solid fa-trash' })
        : window.confirm('Delete this Janny collection? This cannot be undone from Character Library.');
    if (!ok) return;
    try {
        await deleteJannyCollection(collectionId, jannyAccountOptions());
        jannyOwnedCollections = jannyOwnedCollections.filter(c => String(c.id) !== String(collectionId));
        jannyManageCollection = null;
        renderJannyOwnedCollectionsList();
        setJannyCollectionsMode('owned');
        showToast('Collection deleted.', 'success');
    } catch (err) {
        showToast(`Could not delete collection: ${describeJannyAccountError(err)}`, 'error', 8000);
    }
}

// Topbar refresh while the collections panel is open: re-fetch whatever
// surface is actually visible, not just the list behind it.
function reloadJannyCollections() {
    const manageVisible = !document.getElementById('jannyCollectionManagePanel')?.classList.contains('hidden');
    if (manageVisible && jannyManageCollection?.collection?.id) {
        openJannyCollectionManage(jannyManageCollection.collection.id);
        return;
    }
    const detailVisible = !document.getElementById('jannyCollectionDetailPanel')?.classList.contains('hidden');
    if (detailVisible && jannyActiveCollection) {
        if (jannyActiveCollection.kind === 'owned' && jannyActiveCollection.id) {
            openJannyOwnedCollection(jannyActiveCollection.id);
            return;
        }
        if (jannyActiveCollection.path) {
            openJannyPublicCollection(jannyActiveCollection.path);
            return;
        }
    }
    if (jannyCollectionsMode === 'owned') {
        jannyOwnedCollectionsLoaded = false;
        loadJannyOwnedCollections(true);
    } else {
        loadJannyPublicCollections({ reset: true });
    }
}

function switchJannyCollectionsPanel(show) {
    const panel = document.getElementById('jannyCollectionsSection');
    const browse = document.getElementById('jannyBrowseSection');
    if (!panel || !browse) return;
    panel.classList.toggle('hidden', !show);
    browse.classList.toggle('hidden', !!show);
    document.getElementById('jannyCollectionsBtn')?.classList.toggle('active', !!show);
    if (show) setJannyCollectionsMode(jannyCollectionsMode || 'public');
}

function refreshJannyAccountControlsForSelection() {
    updateJannyBookmarkButton();
    renderJannyCollectionDropdown();
    if (jannyAccountStatus.active && !jannyBookmarksLoaded) {
        loadJannyBookmarks(false).catch(err => debugLog('[JannyAccount] bookmark load failed:', err.message));
    }
    if (jannyAccountStatus.active && !jannyOwnedCollectionsLoaded) {
        loadJannyOwnedCollections(false).catch(err => debugLog('[JannyAccount] collection load failed:', err.message));
    }
}
// ========================================
// BROWSE VIEW CLASS
// ========================================

class JannyBrowseView extends BrowseView {

    constructor(provider) {
        super(provider);
        view = this;
    }

    _extractProviderIds(char, idSet) {
        const jannyData = char.data?.extensions?.jannyai;
        if (jannyData?.id) idSet.add(String(jannyData.id));
    }

    get previewModalId() { return 'jannyCharModal'; }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'newest', label: 'Newest' },
                { value: 'oldest', label: 'Oldest' },
                { value: 'tokens_desc', label: 'Most Tokens' },
                { value: 'tokens_asc', label: 'Least Tokens' },
            ],
            followingSortOptions: [],
            viewModes: [],
        };
    }

    closePreview() {
        closePreviewModal();
    }

    get mobileFilterIds() {
        return {
            sort: 'jannySortSelect',
            tags: 'jannyTagsBtn',
            filters: 'jannyFiltersBtn',
            nsfw: 'jannyNsfwToggle',
            refresh: 'jannyRefreshBtn',
            collections: 'jannyCollectionsBtn'
        };
    }

    // ── Filter Bar ──────────────────────────────────────────

    renderFilterBar() {
        return `
            <!-- Sort -->
            <div class="browse-sort-container">
                <select id="jannySortSelect" class="glass-select" title="Sort order">
                    <optgroup label="Date">
                        <option value="newest" ${jannySortMode === 'newest' ? 'selected' : ''}>🆕 Newest</option>
                        <option value="oldest" ${jannySortMode === 'oldest' ? 'selected' : ''}>🕐 Oldest</option>
                    </optgroup>
                    <optgroup label="Tokens">
                        <option value="tokens_desc" ${jannySortMode === 'tokens_desc' ? 'selected' : ''}>📊 Most Tokens</option>
                        <option value="tokens_asc" ${jannySortMode === 'tokens_asc' ? 'selected' : ''}>📊 Least Tokens</option>
                    </optgroup>
                    <optgroup label="Search">
                        <option value="relevant" ${jannySortMode === 'relevant' ? 'selected' : ''}>🔍 Relevance</option>
                    </optgroup>
                </select>
            </div>

            <!-- Tags & Advanced Filters -->
            <div class="browse-tags-dropdown-container" style="position: relative;">
                <button id="jannyTagsBtn" class="glass-btn" title="Tag filters and advanced options">
                    <i class="fa-solid fa-tags"></i> <span id="jannyTagsBtnLabel">Tags</span>
                </button>
                <div id="jannyTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="jannyTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="jannyTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="jannyTagsList"></div>
                    <hr style="margin: 10px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title"><i class="fa-solid fa-gear"></i> Advanced Options</div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Min Tokens</label>
                        <input type="number" id="jannyMinTokens" class="glass-input-small" value="${jannyMinTokens}" min="0" max="100000" step="100">
                    </div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Max Tokens</label>
                        <input type="number" id="jannyMaxTokens" class="glass-input-small" value="${jannyMaxTokens}" min="0" max="500000" step="1000">
                    </div>
                </div>
            </div>

            <!-- Feature Filters -->
            <div class="browse-more-filters" style="position: relative;">
                <button id="jannyFiltersBtn" class="glass-btn" title="Additional filters">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="jannyFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden" style="width: 240px;">
                    <div class="dropdown-section-title">Content:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="jannyFilterLowQuality"> <i class="fa-solid fa-filter-circle-xmark"></i> Show Low-Quality</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Library:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="jannyFilterHideOwned"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                    <label class="filter-checkbox"><input type="checkbox" id="jannyFilterHidePossible"> <i class="fa-solid fa-check" style="color: #f0a500;"></i> Hide Possible Matches</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Account:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="jannyFilterOnlyBookmarked"> <i class="fa-solid fa-bookmark"></i> Only Bookmarked</label>
                </div>
            </div>

            <!-- NSFW toggle -->
            <button id="jannyNsfwToggle" class="glass-btn nsfw-toggle" title="Toggle NSFW content">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>
            <button id="jannyCollectionsBtn" class="glass-btn" title="Browse your Janny collections">
                <i class="fa-solid fa-layer-group"></i> <span>Collections</span>
            </button>
            <!-- Refresh -->
            <button id="jannyRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // ── Main View ───────────────────────────────────────────

    renderView() {
        return `
            <div id="jannyCollectionsSection" class="browse-section hidden">
                <div class="browse-author-banner">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-layer-group"></i>
                        <span><strong>Janny Collections</strong> <span class="browse-author-banner-hint">Browse public lists or manage your own collections.</span></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <button id="jannyBackToBrowseBtn" class="glass-btn"><i class="fa-solid fa-arrow-left"></i> Browse</button>
                    </div>
                </div>

                <div class="janny-collection-segmented" role="group" aria-label="Janny collection mode">
                    <button id="jannyCollectionsPublicBtn" class="glass-btn active" aria-pressed="true"><i class="fa-solid fa-globe"></i> Public Collections</button>
                    <button id="jannyCollectionsMineBtn" class="glass-btn" aria-pressed="false"><i class="fa-solid fa-user-lock"></i> My Collections</button>
                </div>

                <div id="jannyPublicCollectionsToolbar" class="janny-collection-toolbar">
                    <label class="browse-author-banner-hint" for="jannyPublicCollectionsSort">Sort</label>
                    <select id="jannyPublicCollectionsSort" class="glass-select" title="Public collections sort">
                        <option value="latest" selected>Latest</option>
                        <option value="popular">Most popular</option>
                    </select>
                </div>

                <div id="jannyPublicCollectionsList"></div>

                <div id="jannyOwnedCreatePanel" class="browse-search-bar hidden" style="align-items: stretch; flex-direction: column; gap: 8px;">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-plus"></i>
                        <input type="search" id="jannyNewCollectionName" placeholder="New collection name..." autocomplete="one-time-code">
                        <button id="jannyCreateCollectionBtn" class="browse-search-submit" title="Create collection">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                    <input type="search" id="jannyNewCollectionDescription" class="glass-input" placeholder="Optional description" autocomplete="one-time-code">
                    <label class="browse-author-banner-hint" style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                        <input type="checkbox" id="jannyNewCollectionPrivate" checked> <i class="fa-solid fa-lock"></i> Private collection
                    </label>
                    <div id="jannyCreateCollectionError" class="browse-author-banner-hint hidden" style="color: var(--cl-error-bright);"></div>
                </div>

                <div id="jannyOwnedCollectionsList" class="hidden"></div>
                <div id="jannyCollectionDetailPanel" class="hidden"></div>
                <div id="jannyCollectionManagePanel" class="hidden"></div>
            </div>
            <div id="jannyBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="jannySearchInput" placeholder="Search JannyAI characters..." autocomplete="one-time-code">
                        <button id="jannyClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="jannySearchBtn" class="browse-search-submit">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                </div>

                <!-- Author Filter Banner -->
                <div id="jannyAuthorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <span>Searching for <strong id="jannyAuthorBannerName">Author</strong> <span class="browse-author-banner-hint">(keyword search, may include unrelated results)</span></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <button id="jannyClearAuthorBtn" class="glass-btn icon-only" title="Clear author filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="jannyGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="jannyLoadMore" style="display: none;">
                    <button id="jannyLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // ── Modals ──────────────────────────────────────────────

    renderModals() {
        return `
    <div id="jannyCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="jannyCharAvatar" src="/img/ai4.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="jannyCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="jannyCharCreator" href="#" class="creator-link browse-meta-identity" title="Click to see all characters by this author">Creator</a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="jannyOpenInBrowserBtn" href="#" target="_blank" class="action-btn secondary" title="Open on JannyAI">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                                        <button id="jannyBookmarkBtn" class="action-btn secondary" title="Save to Janny bookmarks">
                        <i class="fa-regular fa-bookmark"></i> Bookmark
                    </button>
                    <div class="janny-collection-action" id="jannyCollectionAction">
                        <button id="jannyCollectionDropdownBtn" class="action-btn secondary" title="Add to Janny collection" aria-haspopup="menu" aria-expanded="false">
                            <i class="fa-solid fa-layer-group"></i> <span>Add to collection</span> <i class="fa-solid fa-chevron-down janny-collection-caret"></i>
                        </button>
                        <div id="jannyCollectionDropdown" class="dropdown-menu janny-collection-dropdown hidden" role="menu"></div>
                    </div>
                    <button id="jannyImportBtn" class="action-btn primary" title="Download to SillyTavern">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="jannyCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-message"></i>
                            <span id="jannyCharTokens">0</span> tokens
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="jannyCharDate">Unknown</span>
                        </div>
                    </div>
                    <div class="browse-char-tags" id="jannyCharTags"></div>
                </div>

                <!-- Creator's Notes (website description, may contain images) -->
                <div class="browse-char-section" id="jannyCharCreatorNotesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="jannyCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="jannyCharCreatorNotes" class="scrolling-text"></div>
                </div>

                <!-- Description (personality field) -->
                <div class="browse-char-section" id="jannyCharDescriptionSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="jannyCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="jannyCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="jannyCharScenarioSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="jannyCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="jannyCharScenario" class="scrolling-text"></div>
                </div>

                <!-- Example Dialogs -->
                <div class="browse-char-section browse-section-collapsed" id="jannyCharExamplesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="jannyCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="jannyCharExamples" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="jannyCharFirstMsgSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="jannyCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="jannyCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // ── Lifecycle ───────────────────────────────────────────

    _getImageGridIds() { return ['jannyGrid', 'jannyCollectionCharactersGrid']; }

    canLoadMore() { return jannyHasMore && !jannyIsLoading; }

    loadMore() {
        jannyCurrentPage++;
        loadCharacters(true);
    }

    init() {
        super.init();
        this.buildLocalLibraryLookup();
        initJannyView();
        const grid = document.getElementById('jannyGrid');
        if (grid) this.observeImages(grid);
        loadCharacters(false);
        restoreJannySessionFromSettings().then(() => refreshJannyAccountStatus({ validate: false }));
    }

    getSearchInputId(mode) {
        return mode === 'character' ? 'jannySearchInput' : null;
    }

    applyDefaults(defaults) {
        if (defaults.sort) {
            jannySortMode = defaults.sort;
            const el = document.getElementById('jannySortSelect');
            if (el) el.value = defaults.sort;
        }
    }

    activate(container, options = {}) {
        if (options.domRecreated) {
            jannyCurrentSearch = '';
            jannyAuthorFilter = null;
            jannyCharacters = [];
            jannyCurrentPage = 1;
            jannyHasMore = true;
            jannyIsLoading = false;
            jannyGridRenderedCount = 0;
        }
        const wasInitialized = this._initialized;
        super.activate(container, options);

        if (wasInitialized && this._initialized) {
            delegatesInitialized = true;
            this.buildLocalLibraryLookup();
            this.reconnectImageObserver();
        }
    }

    // ── Library Lookup (BrowseView contract) ────────────────

    refreshInLibraryBadges() {
        super.refreshInLibraryBadges(card => {
            const id = card.dataset.jannyId;
            const name = card.querySelector('.browse-card-name')?.textContent || '';
            const creatorUsername = card.querySelector('.browse-card-creator-link')?.textContent || '';
            return isCharInLocalLibrary({ id, name, creatorUsername });
        });
    }

    deactivate() {
        jannyDetailFetchToken++;
        delegatesInitialized = false;
        super.deactivate();
        this.disconnectImageObserver();
    }
}

const jannyBrowseView = new JannyBrowseView(null);

// Expose for library.js to call from viewOnProvider (linked character preview)
window.openJannyCharPreview = function(hit) {
    openPreviewModal(hit);
};

export default jannyBrowseView;
