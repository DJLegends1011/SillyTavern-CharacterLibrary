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
    configureJannyAccount,
    connectJanny,
    jannyAuthStatus,
    disconnectJanny,
    jannyHelperAvailable,
    toggleJannyBookmark,
    getJannyBookmarkIds,
    refreshJannyBookmarkIds,
    fetchJannyBookmarkCharacters,
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
let jannyFilterBookmarks = false;
/** @type {Set<number>} Active include tag IDs */
let jannyIncludeTags = new Set();
let jannyAuthorFilter = null;

let view; // module-scoped BrowseView instance reference (set once in constructor)

// Account (cl-helper cookie session) state
let jannyConnected = false;
let jannyHelperOk = false;
let jannyAccountBusy = false;

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

/**
 * Resolve a hit/record's `avatar` field to a displayable URL. Normally this is a
 * JANNY_IMAGE_BASE-relative path fragment (the shape MeiliSearch hits and the
 * page-scrape "character" object both use), but bookmark records sourced from
 * `/api/get-characters` (see fetchJannyBookmarkCharacters()) haven't been
 * confirmed live yet — guard against that endpoint instead returning an
 * already-fully-qualified URL so we don't double-prefix it.
 */
function jannyAvatarUrl(avatar) {
    if (!avatar) return '/img/ai4.png';
    return /^https?:\/\//i.test(avatar) ? avatar : `${JANNY_IMAGE_BASE}${avatar}`;
}

function createJannyCard(hit) {
    const name = hit.name || 'Unknown';
    const desc = stripHtml(hit.description) || '';
    const avatarUrl = jannyAvatarUrl(hit.avatar);
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

    // loadCharacters() always fetches/renders MeiliSearch results, never bookmarks
    // (see loadJannyBookmarksView() for that path). If "My Bookmarks" was left
    // checked from a prior view, clear it here so the UI never claims "My
    // Bookmarks" while showing generic search results. State-only - does not
    // itself trigger another load.
    resetJannyBookmarksFilter();

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

// ========================================
// MY BOOKMARKS DATA-SOURCE VIEW
// ========================================

/**
 * Normalize a `/api/get-characters` record (see fetchJannyBookmarkCharacters() in
 * janny-api.js) into the same field shape MeiliSearch hits use, so bookmarked
 * characters render through the identical createJannyCard()/openPreviewModal()
 * pipeline as search results.
 *
 * Evidence for the field names below (id, name, avatar, tagIds, totalToken,
 * description, creatorId/creatorUsername, createdAt/createdAtStamp): the same
 * vocabulary is used for JannyAI's MeiliSearch hits (searchJanny()) AND for the
 * "character" object scraped from the Astro island props on the character detail
 * page (fetchCharacterDetails() in janny-provider.js:310-358) - a completely
 * different JannyAI data path that independently uses identical field names for
 * id/name/avatar/tagIds/totalToken/description. That's strong evidence this is
 * the canonical JannyAI Character record shape, which /api/get-characters (a real
 * JannyAI backend endpoint, not MeiliSearch) most likely also returns.
 *
 * The one field NOT reliably present on that canonical record is
 * `creatorUsername`: the page-scrape path has to derive it separately by
 * regexing "Creator: @username" out of the rendered HTML (janny-provider.js:342-349),
 * implying the backend record itself may carry only `creatorId`. Bookmarked
 * cards may therefore show a blank creator line until confirmed live - flagged
 * as a PENDING item in task-6-report.md rather than guessed at further here.
 *
 * Field-name fallbacks below mirror the defensive alt-id handling already in
 * this file (see jannyCharId() ~line 690, which anticipates `characterId`/`uuid`
 * as possible alternates to `id` for bookmark-sourced records).
 */
function normalizeBookmarkChar(raw) {
    if (!raw || typeof raw !== 'object') return raw;

    return {
        ...raw,
        id: raw.id ?? raw.characterId ?? raw.uuid ?? null,
        name: raw.name || raw.title || 'Unknown',
        avatar: raw.avatar ?? raw.avatarUrl ?? raw.image ?? '',
        description: raw.description ?? raw.bio ?? '',
        tagIds: Array.isArray(raw.tagIds) ? raw.tagIds : [],
        totalToken: raw.totalToken ?? raw.tokenCount ?? raw.total_tokens ?? 0,
        creatorUsername: raw.creatorUsername || raw.creatorName || raw.username || '',
        creatorId: raw.creatorId ?? null,
        createdAt: raw.createdAt ?? null,
        createdAtStamp: raw.createdAtStamp ?? null,
    };
}

/**
 * Load the user's JannyAI bookmarks as the grid's data source (replacing the
 * MeiliSearch search results). Per Task 6 resolution #5, the bookmark cap
 * (~220) is small enough that fetchJannyBookmarkCharacters() batching + a
 * single renderGrid(chars, false) call is sufficient - no load-more slicing.
 */
async function loadJannyBookmarksView() {
    const thisToken = ++jannyLoadToken;
    jannyIsLoading = true;

    const grid = document.getElementById('jannyGrid');
    if (grid) renderSkeletonGrid(grid);

    try {
        await refreshJannyBookmarkIds();
        if (thisToken !== jannyLoadToken || !delegatesInitialized) return;

        const ids = [...getJannyBookmarkIds()];
        const rawChars = await fetchJannyBookmarkCharacters(ids);
        if (thisToken !== jannyLoadToken || !delegatesInitialized) return;

        jannyCharacters = rawChars.map(normalizeBookmarkChar);
        jannyHasMore = false;

        renderGrid(jannyCharacters, false);

        if (jannyCharacters.length === 0 && grid) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid fa-bookmark" style="font-size: 2rem; opacity: 0.5;"></i>
                    <p style="margin-top: 12px; font-weight: 600;">No bookmarks yet</p>
                    <p style="margin-top: 8px; font-size: 0.9em;">Bookmark characters on JannyAI to see them here.</p>
                </div>
            `;
        }

        debugLog('[JannyBrowse] Loaded', jannyCharacters.length, 'bookmarked characters');
    } catch (err) {
        if (thisToken !== jannyLoadToken) return;
        console.error('[JannyBrowse] Bookmarks load error:', err);
        showToast(`Failed to load JannyAI bookmarks: ${err.message}`, 'error');
        if (grid) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid fa-exclamation-triangle" style="font-size: 2rem; color: var(--cl-error-bright);"></i>
                    <p style="margin-top: 12px;">Could not load bookmarks: ${escapeHtml(err.message)}</p>
                    <button class="glass-btn" style="margin-top: 12px;" id="jannyBookmarksRetryBtn">
                        <i class="fa-solid fa-redo"></i> Retry
                    </button>
                </div>
            `;
            const retryBtn = document.getElementById('jannyBookmarksRetryBtn');
            if (retryBtn) retryBtn.addEventListener('click', () => loadJannyBookmarksView());
        }
    } finally {
        if (thisToken === jannyLoadToken) jannyIsLoading = false;
    }
}

/** Turn the "My Bookmarks" filter back off (checkbox + state), without reloading. */
function resetJannyBookmarksFilter() {
    if (!jannyFilterBookmarks) return false;
    jannyFilterBookmarks = false;
    const cb = document.getElementById('jannyFilterBookmarks');
    if (cb) cb.checked = false;
    updateJannyFiltersButton();
    return true;
}

// ========================================
// PREVIEW MODAL
// ========================================

let jannyDetailFetchToken = 0;
let jannyDetailFetchPromise = null;

function openPreviewModal(hit) {
    jannySelectedChar = hit;

    const modal = document.getElementById('jannyCharModal');
    if (!modal) return;
    window.resetBrowseSectionCollapseState?.(modal);

    const name = hit.name || 'Unknown';
    const creatorNotes = stripHtml(hit.description) || '';
    const avatarUrl = jannyAvatarUrl(hit.avatar);
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

    updateJannyBookmarkButton(hit);

    modal.classList.remove('hidden');
    const charBody = modal.querySelector('.browse-char-body');
    if (charBody) charBody.scrollTop = 0;

    // Fetch full details in background - store promise so Import can await it
    const fetchToken = ++jannyDetailFetchToken;
    jannyDetailFetchPromise = fetchAndPopulateDetails(hit, fetchToken);
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

// ========================================
// BOOKMARK BUTTON (character modal)
// ========================================

/** JannyAI character id - same UUID namespace the /api/bookmark endpoint returns. */
function jannyCharId(char) {
    return char?.id || char?.characterId || char?.uuid || null;
}

/** Sync the bookmark toggle's icon/label/visibility to the given character's saved state. */
function updateJannyBookmarkButton(char) {
    const btn = document.getElementById('jannyCharBookmarkBtn');
    const label = document.getElementById('jannyCharBookmarkLabel');
    if (!btn) return;
    const id = jannyCharId(char);
    const saved = !!id && getJannyBookmarkIds().has(id);
    btn.classList.toggle('favorited', saved);
    const icon = btn.querySelector('i');
    if (icon) icon.className = saved ? 'fa-solid fa-bookmark' : 'fa-regular fa-bookmark';
    if (label) label.textContent = saved ? 'Remove bookmark' : 'Bookmark';
    btn.title = saved ? 'Remove bookmark on JannyAI' : 'Bookmark on JannyAI';
    btn.style.display = jannyConnected ? '' : 'none';
}

/** Toggle the bookmark state of the currently open JannyAI character modal's character. */
async function toggleJannyCharBookmark() {
    if (!jannyConnected) { showToast('Connect JannyAI first', 'info'); return; }
    const char = jannySelectedChar; // the modal's open-character variable (set in openPreviewModal)
    const id = jannyCharId(char);
    if (!id) return;
    const btn = document.getElementById('jannyCharBookmarkBtn');
    const wasSaved = getJannyBookmarkIds().has(id);
    btn?.classList.add('loading');
    const result = await toggleJannyBookmark(id, !wasSaved);
    btn?.classList.remove('loading');
    if (!result.ok) {
        showToast(result.error || 'JannyAI bookmark failed', 'error');
    } else {
        showToast(wasSaved ? 'Removed bookmark' : 'Bookmarked on JannyAI', 'success');
    }
    updateJannyBookmarkButton(char);
}

function closePreviewModal() {
    jannyDetailFetchToken++;
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

    const active = jannyShowLowQuality || jannyFilterHideOwned || jannyFilterHidePossible || jannyFilterBookmarks;
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
        jannyCurrentPage = 1;
        loadCharacters(false);
    });

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

    on('jannyFilterBookmarks', 'change', (e) => {
        const checked = e.target.checked;
        if (checked && !jannyConnected) {
            showToast('Connect JannyAI to view your bookmarks', 'warning');
            e.target.checked = false;
            jannyFilterBookmarks = false;
            return;
        }
        jannyFilterBookmarks = checked;
        updateJannyFiltersButton();
        if (jannyFilterBookmarks) {
            loadJannyBookmarksView();
        } else {
            doSearch();
        }
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

        on('jannyImportBtn', 'click', () => {
            if (jannySelectedChar) importCharacter(jannySelectedChar);
        });

        on('jannyCharBookmarkBtn', 'click', () => toggleJannyCharBookmark());

        const modalOverlay = document.getElementById('jannyCharModal');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) closePreviewModal();
            });
        }

        // ── Login modal events ──
        on('jannyLoginClose', 'click', () => closeJannyLoginModal());

        on('jannySaveCookieBtn', 'click', () => {
            const cookieInput = document.getElementById('jannyCookieInput');
            const cookieStr = cookieInput?.value?.trim();
            if (!cookieStr) {
                showToast('Please paste your session cookie value', 'warning');
                return;
            }
            saveJannyCookieAndConnect(cookieStr);
        });

        on('jannyLogoutBtn', 'click', () => jannyLogoutAction());

        // Enter key on cookie field
        on('jannyCookieInput', 'keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('jannySaveCookieBtn')?.click();
            }
        });

        const jannyLoginOverlay = document.getElementById('jannyLoginModal');
        if (jannyLoginOverlay) {
            jannyLoginOverlay.addEventListener('click', (e) => {
                if (e.target === jannyLoginOverlay) closeJannyLoginModal();
            });
        }

        window.registerOverlay?.({ id: 'jannyCharModal', tier: 7, close: () => closePreviewModal() });
        window.registerOverlay?.({ id: 'jannyAuthorBanner', tier: 9, close: () => clearAuthorFilter() });
        window.registerOverlay?.({ id: 'jannyLoginModal', tier: 6, close: () => closeJannyLoginModal() });
    }

    on('jannyConnectBtn', 'click', () => openJannyLoginModal());
    renderJannyAccountState();
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
// AUTH - JANNYAI COOKIE SESSION VIA CL-HELPER
// ========================================

/** Refresh the toolbar connect box (helper-missing / signed-out / expired / connected). */
async function renderJannyAccountState() {
    const box = document.getElementById('jannyAccountBox');
    const label = document.getElementById('jannyConnectLabel');
    if (!box || !label) return;

    box.classList.remove('connected', 'expired', 'helper-missing');

    jannyHelperOk = await jannyHelperAvailable();
    if (!jannyHelperOk) {
        box.classList.add('helper-missing');
        label.textContent = 'JannyAI sync unavailable';
        box.title = 'cl-helper plugin not installed — bookmark sync unavailable';
        jannyConnected = false;
        return;
    }

    const status = await jannyAuthStatus();
    jannyConnected = !!status.connected;

    if (jannyConnected) {
        box.classList.add('connected');
        label.textContent = `JannyAI: ${status.bookmarkCount ?? 0} bookmarked`;
        box.title = 'Connected to JannyAI — click to manage';
        // Populate the local bookmark id set (eg. on page load with an already-valid
        // session) so the character modal's bookmark button reflects saved state
        // without requiring a fresh connect action.
        if (getJannyBookmarkIds().size === 0) await refreshJannyBookmarkIds();
    } else if (status.reason === 'session expired or rejected') {
        box.classList.add('expired');
        label.textContent = 'JannyAI session expired';
        box.title = 'Your JannyAI session expired — click to reconnect';
    } else {
        label.textContent = 'Connect JannyAI';
        box.title = 'Connect your JannyAI account to sync bookmarks';
    }

    // Keep an already-open character modal's bookmark button in sync (eg. after connect/disconnect).
    if (jannySelectedChar) updateJannyBookmarkButton(jannySelectedChar);
}

async function openJannyLoginModal() {
    await renderJannyAccountState();
    updateJannyLoginUI();

    // Cookie is never persisted anywhere - the textarea always starts empty.
    const cookieInput = document.getElementById('jannyCookieInput');
    if (cookieInput) cookieInput.value = '';

    const modal = document.getElementById('jannyLoginModal');
    if (modal) modal.classList.remove('hidden');
}

function closeJannyLoginModal() {
    const modal = document.getElementById('jannyLoginModal');
    if (modal) modal.classList.add('hidden');
}

function updateJannyLoginUI() {
    const pluginOk = document.getElementById('jannyPluginStatusOk');
    const pluginMissing = document.getElementById('jannyPluginStatusMissing');
    const cookieForm = document.getElementById('jannyCookieForm');
    const saveBtn = document.getElementById('jannySaveCookieBtn');

    if (pluginOk) pluginOk.style.display = jannyHelperOk ? '' : 'none';
    if (pluginMissing) pluginMissing.style.display = jannyHelperOk ? 'none' : '';
    if (cookieForm) cookieForm.classList.toggle('janny-login-disabled', !jannyHelperOk);
    if (saveBtn) saveBtn.disabled = !jannyHelperOk || jannyAccountBusy;

    if (saveBtn) {
        saveBtn.innerHTML = jannyAccountBusy
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Connecting...'
            : '<i class="fa-solid fa-plug"></i> Save & Connect';
    }

    // Session status
    const statusArea = document.getElementById('jannySessionStatus');
    if (statusArea) {
        if (jannyConnected) {
            statusArea.innerHTML = '<i class="fa-solid fa-check-circle" style="color: var(--cl-success-bright);"></i> <strong>Connected</strong>, bookmarks will sync';
            statusArea.style.display = '';
        } else {
            statusArea.style.display = 'none';
        }
    }

    // Show/hide cookie input vs logout
    const logoutBtn = document.getElementById('jannyLogoutBtn');
    const cookieFields = document.getElementById('jannyCookieFields');
    if (logoutBtn) logoutBtn.style.display = jannyConnected ? '' : 'none';
    if (saveBtn) saveBtn.style.display = jannyConnected ? 'none' : '';
    if (cookieFields) cookieFields.style.display = jannyConnected ? 'none' : '';
}

async function saveJannyCookieAndConnect(cookieStr) {
    if (jannyAccountBusy) return;

    jannyAccountBusy = true;
    updateJannyLoginUI();

    try {
        const result = await connectJanny(cookieStr);
        if (!result.ok) {
            showToast(`JannyAI connect failed: ${result.error || 'unknown error'}`, 'error');
            return;
        }

        showToast(`Connected to JannyAI (${result.bookmarkCount ?? 0} bookmarks)`, 'success');
        closeJannyLoginModal();
    } catch (err) {
        console.error('[JannyAuth] Cookie save error:', err.message);
        showToast(`Connection error: ${err.message}`, 'error');
    } finally {
        jannyAccountBusy = false;
        await renderJannyAccountState();
        updateJannyLoginUI();
    }
}

async function jannyLogoutAction() {
    await disconnectJanny();

    const cookieInput = document.getElementById('jannyCookieInput');
    if (cookieInput) cookieInput.value = '';

    showToast('Disconnected from JannyAI', 'info');

    await renderJannyAccountState();
    updateJannyLoginUI();

    // "My Bookmarks" is a data source that requires a connected session - if it
    // was active, fall back to normal search rather than leaving a stale
    // now-unreachable bookmarks grid on screen.
    if (resetJannyBookmarksFilter()) doSearch();
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
            refresh: 'jannyRefreshBtn'
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
                    <div class="dropdown-section-title">Personal <span style="font-size: 0.8em; opacity: 0.6;">(requires JannyAI connection)</span>:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="jannyFilterBookmarks"> <i class="fa-solid fa-bookmark"></i> My Bookmarks</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Library:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="jannyFilterHideOwned"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                    <label class="filter-checkbox"><input type="checkbox" id="jannyFilterHidePossible"> <i class="fa-solid fa-check" style="color: #f0a500;"></i> Hide Possible Matches</label>
                </div>
            </div>

            <!-- NSFW toggle -->
            <button id="jannyNsfwToggle" class="glass-btn nsfw-toggle" title="Toggle NSFW content">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Account (cl-helper cookie session) -->
            <div id="jannyAccountBox" class="janny-account-box">
                <button id="jannyConnectBtn" class="glass-btn janny-account-btn" title="Connect your JannyAI account to sync bookmarks">
                    <i class="fa-regular fa-bookmark"></i> <span id="jannyConnectLabel">Connect JannyAI</span>
                </button>
            </div>

            <!-- Refresh -->
            <button id="jannyRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // ── Main View ───────────────────────────────────────────

    renderView() {
        return `
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
                    <button id="jannyImportBtn" class="action-btn primary" title="Download to SillyTavern">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <span id="jannyCharBookmarkBtn" class="janny-bookmark-btn-inline browse-fav-toggle"
                          title="Bookmark on JannyAI"><i class="fa-regular fa-bookmark"></i>
                        <span id="jannyCharBookmarkLabel">Bookmark</span></span>
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
    </div>
    <div id="jannyLoginModal" class="modal-overlay hidden">
        <div class="modal-glass browse-login-modal">
            <div class="modal-header">
                <h2><i class="fa-regular fa-bookmark"></i> JannyAI Account</h2>
                <button class="close-btn" id="jannyLoginClose">&times;</button>
            </div>
            <div class="browse-login-body">
                <p class="browse-login-info">
                    <i class="fa-solid fa-check-circle" style="color: var(--cl-success-bright);"></i>
                    <strong>Browsing and importing public characters works without connecting an account!</strong>
                </p>
                <p class="browse-login-info">
                    <i class="fa-regular fa-bookmark" style="color: var(--accent);"></i>
                    <strong>Optional:</strong> Connect your JannyAI session cookie to sync your bookmarked characters.
                </p>

                <!-- Session status -->
                <div id="jannySessionStatus" class="pyg-auth-status" style="display:none;"></div>

                <!-- Cookie form (requires cl-helper plugin) -->
                <div class="pyg-login-section">
                    <div class="pyg-plugin-status">
                        <span id="jannyPluginStatusOk" style="display:none;">
                            <i class="fa-solid fa-plug-circle-check" style="color: var(--cl-success-bright);"></i> cl-helper plugin detected
                        </span>
                        <span id="jannyPluginStatusMissing" style="display:none;">
                            <i class="fa-solid fa-plug-circle-xmark" style="color: var(--cl-warning-bright-darker);"></i>
                            cl-helper plugin not found — see <a href="https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary#cl-helper-plugin-not-detected" target="_blank" style="color: var(--accent);">setup instructions</a>
                        </span>
                    </div>

                    <div id="jannyCookieForm" class="browse-login-form">
                        <div id="jannyCookieFields">
                            <div class="form-group">
                                <label for="jannyCookieInput">Cookie String</label>
                                <textarea id="jannyCookieInput" class="glass-input" rows="2" placeholder="Paste your session cookie value here" style="font-family: monospace; font-size: 12px; resize: vertical;"></textarea>
                            </div>
                            <div class="janny-cookie-instructions">
                                <details>
                                    <summary><i class="fa-solid fa-circle-question"></i> How to get your session cookie</summary>
                                    <ol>
                                        <li>Log in to <a href="https://jannyai.com" target="_blank">jannyai.com</a> in your browser</li>
                                        <li>Open DevTools (<code>F12</code>) → <strong>Application</strong> tab → <strong>Cookies</strong></li>
                                        <li>Copy the full cookie header (or just the session cookie) for <code>jannyai.com</code></li>
                                        <li>Paste it here</li>
                                    </ol>
                                    <p class="janny-cookie-note"><i class="fa-solid fa-clock"></i> Sessions can expire. You'll need to re-paste when it does.</p>
                                </details>
                            </div>
                        </div>

                        <div class="browse-login-actions" style="margin-top: 12px;">
                            <button id="jannySaveCookieBtn" class="action-btn primary">
                                <i class="fa-solid fa-plug"></i> Save &amp; Connect
                            </button>
                            <button id="jannyLogoutBtn" class="action-btn danger" style="display:none;">
                                <i class="fa-solid fa-plug-circle-xmark"></i> Disconnect
                            </button>
                            <a href="https://jannyai.com" target="_blank" class="action-btn secondary">
                                <i class="fa-solid fa-external-link"></i> JannyAI
                            </a>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // ── Lifecycle ───────────────────────────────────────────

    _getImageGridIds() { return ['jannyGrid']; }

    canLoadMore() { return jannyHasMore && !jannyIsLoading; }

    loadMore() {
        jannyCurrentPage++;
        loadCharacters(true);
    }

    init() {
        super.init();
        // Merge-safe: only sets getSetting, leaves apiRequest (bound by the
        // provider's init()) untouched. Safe to call every activation.
        configureJannyAccount({ getSetting });
        this.buildLocalLibraryLookup();
        initJannyView();
        const grid = document.getElementById('jannyGrid');
        if (grid) this.observeImages(grid);
        loadCharacters(false);
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
