// ChartavernBrowseView - CharacterTavern browse/search UI for the Online tab

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber, BROWSE_PURIFY_CONFIG, skeletonLines, deferRender, deferCall, isMobileMode, finishBrowseImport, renderBrowseError } from '../provider-utils.js';
import {
    searchCards,
    fetchCharacterDetail,
    fetchTopTags,
    getAvatarUrl,
    getCharacterPageUrl,
    stripHtml,
    parseTags,
    checkCtPluginAvailable,
    checkCtSession,
    ctSetCookie,
    ctValidateSession,
    ctLogout,
    isCtSessionActive,
    getCtCharName,
    normalizeCtSort,
    CT_DEFAULT_SORT,
    CT_PAGE_SIZE,
    ctFeedOf,
    fetchHomeFeed,
    fetchCreatorPage,
    parseCreatorRef,
    CT_CREATOR_SORTS,
    ctToggleLike,
    fetchLikedCards,
    ctSetFollow,
    fetchTimeline,
    fetchFollowedCreatorIds,
} from './chartavern-api.js';

const {
    onElement: on,
    showToast,
    escapeHtml,
    safePurify,
    debugLog,
    getSetting,
    setSetting,
    checkCharacterForDuplicatesAsync,
    showPreImportDuplicateWarning,
    deleteCharacter,
    getCharacterGalleryId,
    formatRichText,
    debounce,
    apiRequest,
    cleanupCreatorNotesContainer,
    renderCreatorNotesSecure,
    renderCardHtmlSecure,
    getProviderExcludeTags,
    renderLoadingState,
    renderSkeletonGrid,
} = CoreAPI;

// ========================================
// STATE
// ========================================

let ctCharacters = [];
let ctCurrentPage = 1;
let ctTotalPages = 1;
let ctHasMore = true;
let ctIsLoading = false;
let ctCurrentSearch = '';
let ctNsfwEnabled = false;
let ctNsfwWarnedThisSession = false;
let ctSortMode = CT_DEFAULT_SORT;
let ctSelectedChar = null;
let ctGridRenderedCount = 0;
let ctLoadToken = 0; // Generation counter for search requests

// Creator view: { username, displayName } while the author banner is up, else null.
// Cards come from the creator's own CT page, not a keyword search.
let ctCreator = null;
let ctCreatorSort = 'newest';
let ctCreatorInfo = null; // last creator-page payload (profile, hiddenCount, isFollowing, featured...)

// Following mode: the account's timeline (homepage TimelineCards, fixed 28)
let ctViewMode = 'browse'; // 'browse' | 'following'
let ctTimeline = [];
let ctTimelineToken = 0;

// Auth state
let ctPluginAvailable = false;
let ctLoginInProgress = false;

// Filter state
let ctMinTokens = 0;
let ctMaxTokens = 0;
let ctFilterHideOwned = false;
let ctFilterHidePossible = false;
let ctFilterHasLorebook = false;
let ctFilterLikes = false; // "My Likes": the account's liked cards (CL Favorites = CT likes)
let ctFilterIsOC = false;

// Tag filter state
/** @type {Set<string>} Active include tags */
let ctIncludeTags = new Set();
/** @type {Set<string>} Active exclude tags */
let ctExcludeTags = new Set();

// Cached top tags from API
let ctTopTags = [];
let ctTopTagsFetched = false;

let view; // module-scoped BrowseView instance reference (set once in constructor)

// ========================================
// LOCAL LIBRARY LOOKUP
// ========================================

function isCharInLocalLibrary(hit) {
    if (hit.path && view._lookup.byProviderId.has(hit.path)) return true;

    // Both name forms: cards imported before the inChatName remap carry the listing title
    const names = [getCtCharName(hit).toLowerCase(), (hit.name || '').toLowerCase().trim()];
    const creator = (hit.author_username || hit.author || '').toLowerCase().trim();
    if (creator && names.some(n => n && view._lookup.byNameAndCreator.has(`${n}|${creator}`))) return true;

    return false;
}

function isCharPossibleMatchObj(h) {
    if (isCharInLocalLibrary(h)) return false;
    return view.isCharPossibleMatch(getCtCharName(h), h.author_username || h.author || h.path?.split('/')[0] || '');
}

// ========================================
// TAG CLAMPING
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

// ========================================
// CARD RENDERING
// ========================================

function createCtCard(hit) {
    const name = hit.name || 'Unknown';
    const desc = stripHtml(hit.tagline || '');
    const avatarUrl = hit.path ? getAvatarUrl(hit.path) : '/img/ai4.png';
    const tags = parseTags(hit.tags).slice(0, 3);
    const tokens = formatNumber(hit.totalTokens || 0);
    const author = hit.author || hit.path?.split('/')[0] || '';
    const inLibrary = isCharInLocalLibrary(hit);
    const possibleTier = inLibrary ? null : view.getPossibleMatchTier(getCtCharName(hit), author);
    const possibleMatch = !!possibleTier?.show;

    const badges = [];
    if (inLibrary) {
        badges.push('<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    } else if (possibleMatch) {
        badges.push(`<span class="browse-feature-badge possible-library pl-${possibleTier.tier}" title="${possibleTier.tooltip}"><i class="fa-solid fa-check"></i></span>`);
    }
    if (hit.hasLorebook) {
        badges.push('<span class="browse-feature-badge" title="Has Lorebook"><i class="fa-solid fa-book"></i></span>');
    }
    if (hit.isOC) {
        badges.push('<span class="browse-feature-badge" title="Original Character"><i class="fa-solid fa-star"></i></span>');
    }

    const createdDate = hit.createdAt
        ? new Date(hit.createdAt * 1000).toLocaleDateString()
        : '';
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';

    const cardClass = inLibrary ? 'browse-card in-library' : possibleMatch ? 'browse-card possible-library' : 'browse-card';

    return `
        <div class="${cardClass}" data-ct-path="${escapeHtml(hit.path || '')}" ${desc ? `title="${escapeHtml(desc)}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/ai4.png'">
                ${hit.isNSFW ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}
                ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                ${author ? `<span class="browse-card-creator-link" data-author="${escapeHtml(author)}" title="Click to see all characters by ${escapeHtml(author)}">${escapeHtml(author)}</span>` : ''}
                <div class="browse-card-tags">
                    ${tags.map(t => `<span class="browse-card-tag" title="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('')}
                </div>
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Tokens"><i class="fa-solid fa-font"></i> ${tokens}</span>
                ${hit.likes != null ? `<span class="browse-card-stat" title="Likes"><i class="fa-solid fa-heart"></i> ${formatNumber(hit.likes)}</span>` : ''}
                ${dateInfo}
            </div>
        </div>
    `;
}

function observeNewCards(startIdx) {
    const grid = document.getElementById('ctGrid');
    if (!grid) return;
    chartavernBrowseView.observeImages(grid);
}

// ========================================
// GRID RENDERING
// ========================================

function renderGrid(characters, append = false) {
    const grid = document.getElementById('ctGrid');
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
        ctGridRenderedCount = 0;
    }

    const startIdx = ctGridRenderedCount;
    const html = characters.slice(startIdx).map(c => createCtCard(c)).join('');
    grid.insertAdjacentHTML('beforeend', html);
    ctGridRenderedCount = characters.length;

    observeNewCards(startIdx);
    updateLoadMore();
}

function updateLoadMore() {
    chartavernBrowseView.updateLoadMoreVisibility('ctLoadMore', ctHasMore, ctCharacters.length > 0);
}

// ========================================
// SEARCH / LOAD
// ========================================

/** True when anything only the catalog can honor is set (feeds are fixed, unfilterable sets). */
function hasCatalogOnlyFilters() {
    return !!ctCurrentSearch || ctIncludeTags.size > 0 || ctExcludeTags.size > 0
        || ctMinTokens > 0 || ctMaxTokens > 0 || ctFilterHasLorebook || ctFilterIsOC;
}

/** Point the sort dropdown (and its custom-select face) at a value. */
function setSortSelect(value) {
    ctSortMode = value;
    const el = document.getElementById('ctSortSelect');
    if (el) {
        el.value = value;
        el._customSelect?.refresh?.();
    }
}

// The sort dropdown is swapped in place for creator view (the mobile sheet mirrors this same
// select, so it follows automatically). The browse options are stashed and restored on exit.
const CT_CREATOR_SORT_ICONS = { newest: '🆕', popular: '🔥', name: '🔤' };
let ctBrowseSortStash = null; // { html, value } while creator sorts are showing

function showCreatorSorts() {
    const el = document.getElementById('ctSortSelect');
    if (!el) return;
    if (!ctBrowseSortStash) ctBrowseSortStash = { html: el.innerHTML, value: el.value };
    const opts = Object.entries(CT_CREATOR_SORTS)
        .map(([value, label]) => `<option value="${value}">${CT_CREATOR_SORT_ICONS[value] || ''} ${escapeHtml(label)}</option>`)
        .join('');
    el.innerHTML = `<option value="featured">📌 Featured</option>${opts}`;
    el.value = ctCreatorSort;
    el.title = "Sort this creator's characters";
    el._customSelect?.refresh?.();
}

function restoreBrowseSorts() {
    const el = document.getElementById('ctSortSelect');
    if (!el || !ctBrowseSortStash) return;
    el.innerHTML = ctBrowseSortStash.html;
    el.value = ctBrowseSortStash.value;
    el.title = 'Sort order';
    ctBrowseSortStash = null;
    el._customSelect?.refresh?.();
}

let ctBrowseStale = false; // a browse filter changed while Following was showing

async function loadCharacters(append = false, { fresh = false } = {}) {
    if (append && ctIsLoading) return;
    if (ctViewMode === 'following') {
        // Every filter handler funnels here; in Following they apply to the timeline instead
        ctBrowseStale = true;
        renderCtTimeline();
        return;
    }

    // A site feed cant be searched or filtered; fall to the catalog's relevance sort instead
    const likesView = !ctCreator && ctFilterLikes;
    if (!ctCreator && !likesView && ctFeedOf(ctSortMode) && hasCatalogOnlyFilters()) setSortSelect('best');
    const feedId = ctCreator || likesView ? null : ctFeedOf(ctSortMode);
    if (append && (feedId || likesView)) return; // feeds and the likes list are one fixed page

    // Concurrency control: prevent stale responses from overwriting newer ones
    const thisToken = ++ctLoadToken;
    ctIsLoading = true;

    const grid = document.getElementById('ctGrid');
    const loadMoreBtn = document.getElementById('ctLoadMoreBtn');

    if (!append && grid) {
        renderSkeletonGrid(grid);
    }

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        const opts = {
            query: ctCurrentSearch,
            sort: ctSortMode,
            page: ctCurrentPage,
            nsfw: ctNsfwEnabled
        };

        if (ctIncludeTags.size > 0) opts.tags = [...ctIncludeTags].join(',');
        const ctMergedExclude = [...ctExcludeTags];
        for (const t of getProviderExcludeTags('chartavern')) {
            if (!ctMergedExclude.includes(t)) ctMergedExclude.push(t);
        }
        if (ctMergedExclude.length > 0) opts.excludeTags = ctMergedExclude.join(',');
        if (ctMinTokens > 0) opts.minimumTokens = ctMinTokens;
        if (ctMaxTokens > 0) opts.maximumTokens = ctMaxTokens;
        if (ctFilterHasLorebook) opts.hasLorebook = true;
        if (ctFilterIsOC) opts.isOC = true;

        // One page from whichever source is active: creator page, homepage feed, or the catalog
        const creator = ctCreator;
        const fetchPage = async (page) => {
            if (creator) {
                // Featured = the creator's pinned cards, carried on every creator page as its own list
                const featured = ctCreatorSort === 'featured';
                const res = await fetchCreatorPage(creator.username, { sort: featured ? 'newest' : ctCreatorSort, page }, apiRequest);
                if (res.profile && (page === 1 || !ctCreatorInfo)) ctCreatorInfo = res;
                rememberCreator(res.profile, res.stats);
                return featured ? { hits: res.featured, totalPages: 1 } : { hits: res.cards, totalPages: res.pages };
            }
            if (likesView) {
                // The whole liked list in one page; a typed search narrows it client-side
                const q = ctCurrentSearch.toLowerCase();
                const liked = await fetchLikedCards(apiRequest);
                const hits = q ? liked.filter(h => `${h.name} ${h.tagline || ''} ${h.author}`.toLowerCase().includes(q)) : liked;
                return { hits, totalPages: 1 };
            }
            if (feedId === 'timeline' && !isCtSessionActive()) return { hits: [], totalPages: 1, needsLogin: true };
            if (feedId) return { hits: await fetchHomeFeed(feedId, apiRequest, { fresh }), totalPages: 1 };
            return searchCards({ ...opts, page }, apiRequest);
        };

        const data = await fetchPage(ctCurrentPage);

        // Stale response check
        if (thisToken !== ctLoadToken) return;

        // Provider was deactivated during the fetch
        if (!delegatesInitialized) return;

        let hits = data?.hits || [];
        ctTotalPages = data?.totalPages || 1;
        if (creator && ctCurrentPage === 1) updateCreatorBanner();

        // Client-side: filter NSFW when toggle is off (exclude_tags alone doesn't catch all isNSFW cards)
        if (!ctNsfwEnabled) {
            hits = hits.filter(h => !h.isNSFW);
        }

        // Client-side: hide owned / possible match characters
        if (ctFilterHideOwned) {
            hits = hits.filter(h => !isCharInLocalLibrary(h));
        }
        if (ctFilterHidePossible) {
            hits = hits.filter(h => !isCharPossibleMatchObj(h));
        }

        // Auto-fetch when client-side filters remove too many results
        const hasClientFilters = ctFilterHideOwned || ctFilterHidePossible || !ctNsfwEnabled;
        if (!feedId && !likesView && hasClientFilters && ctCurrentPage < ctTotalPages) {
            let autoFetches = 0;
            while (hits.length < CT_PAGE_SIZE && ctCurrentPage < ctTotalPages && autoFetches < 3 && delegatesInitialized) {
                autoFetches++;
                ctCurrentPage++;
                const moreData = await fetchPage(ctCurrentPage);
                if (thisToken !== ctLoadToken || !delegatesInitialized) return;
                let moreHits = moreData?.hits || [];
                if (!ctNsfwEnabled) moreHits = moreHits.filter(h => !h.isNSFW);
                if (ctFilterHideOwned) moreHits = moreHits.filter(h => !isCharInLocalLibrary(h));
                if (ctFilterHidePossible) moreHits = moreHits.filter(h => !isCharPossibleMatchObj(h));
                hits = hits.concat(moreHits);
            }
            if (autoFetches > 0) {
                debugLog(`[CTBrowse] Auto-fetched ${autoFetches} extra page(s) to compensate for client-side filters`);
            }
        }

        if (append) {
            const existingPaths = new Set(ctCharacters.map(c => c.path));
            ctCharacters = ctCharacters.concat(hits.filter(h => !h.path || !existingPaths.has(h.path)));
        } else {
            ctCharacters = hits;
        }

        ctHasMore = ctCurrentPage < ctTotalPages;
        syncSurpriseBtn();

        renderGrid(ctCharacters, append);

        if (!append && ctCharacters.length === 0 && data?.needsLogin) {
            grid.innerHTML = `
                <div class="browse-empty">
                    <i class="fa-solid fa-key"></i>
                    <h3>Login Required</h3>
                    <p>The Timeline feed shows new characters from creators you follow, so it needs your CharacterTavern session. Turn on NSFW or open Settings to add your session cookie.</p>
                </div>`;
        } else if (!append && ctCharacters.length === 0) {
            const hidden = creator ? (ctCreatorInfo?.hiddenCount || 0) : 0;
            const noFeatured = creator && ctCreatorSort === 'featured';
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid ${noFeatured ? 'fa-thumbtack' : 'fa-search'}" style="font-size: 2rem; opacity: 0.5;"></i>
                    <p style="margin-top: 12px;">${noFeatured ? "This creator hasn't featured any characters" : 'No characters found'}</p>
                    ${hidden ? `<p style="margin-top: 6px;">${hidden} of this creator's characters are hidden by your content settings${isCtSessionActive() ? '' : ' (log in to CharacterTavern to see them)'}.</p>` : ''}
                </div>
            `;
        }

        debugLog('[CTBrowse] Loaded', hits.length, 'characters, page', ctCurrentPage, '/', ctTotalPages);

    } catch (err) {
        if (thisToken !== ctLoadToken) return;

        console.error('[CTBrowse] Search error:', err);
        if (ctCreator && !ctCreatorInfo) {
            const followBtn = document.getElementById('ctFollowCreatorBtn');
            if (followBtn) followBtn.style.display = 'none'; // no profile, nothing to follow
        }
        showToast(`CharacterTavern search failed: ${err.message}`, 'error');
        if (!append && grid) {
            renderBrowseError(grid, {
                provider: 'chartavern',
                error: err,
                message: `Search failed: ${err.message}`,
                flags: { nsfw: ctNsfwEnabled },
                retry: () => loadCharacters(false),
            });
        }
    } finally {
        if (thisToken === ctLoadToken) {
            ctIsLoading = false;
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
            }
        }
    }
}

// ========================================
// PREVIEW MODAL
// ========================================

/**
 * Fill the modal's stats, tags and alt-greetings from a catalog hit or an adapted detail card.
 * Fields a source lacks fall back to placeholders, so the detail pass can repaint over the hit pass.
 */
function populateModalExtras(src, name) {
    const tokensEl = document.getElementById('ctCharTokens');
    if (tokensEl) tokensEl.textContent = formatNumber(src.totalTokens || 0);
    const chatsEl = document.getElementById('ctCharChats');
    if (chatsEl) chatsEl.textContent = src.chats != null ? formatNumber(src.chats) : '–';
    const likesEl = document.getElementById('ctCharLikes');
    if (likesEl) likesEl.textContent = src.likes != null ? formatNumber(src.likes) : '–';
    paintLikeButton(src);
    const dateEl = document.getElementById('ctCharDate');
    if (dateEl) dateEl.textContent = src.createdAt ? new Date(src.createdAt * 1000).toLocaleDateString() : 'Unknown';

    const altGreetings = Array.isArray(src.alternativeFirstMessage) ? src.alternativeFirstMessage.filter(Boolean) : [];
    const greetingsStat = document.getElementById('ctCharGreetingsStat');
    const greetingsCount = document.getElementById('ctCharGreetingsCount');
    if (greetingsStat) {
        if (altGreetings.length > 0) {
            greetingsStat.style.display = 'flex';
            if (greetingsCount) greetingsCount.textContent = String(altGreetings.length + 1);
        } else {
            greetingsStat.style.display = 'none';
        }
    }

    const lorebookStat = document.getElementById('ctCharLorebookStat');
    if (lorebookStat) lorebookStat.style.display = src.hasLorebook ? 'flex' : 'none';

    const tagsEl = document.getElementById('ctCharTags');
    if (tagsEl) {
        tagsEl.innerHTML = parseTags(src.tags).map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
        requestAnimationFrame(() => applyTagsClamp(tagsEl));
    }

    // Alternate Greetings - collapsible details with lazy rendering (matches Chub pattern)
    const altGreetingsSection = document.getElementById('ctCharAltGreetingsSection');
    const altGreetingsEl = document.getElementById('ctCharAltGreetings');
    const altGreetingsCountEl = document.getElementById('ctCharAltGreetingsCount');
    if (altGreetingsSection) {
        if (altGreetings.length > 0) {
            altGreetingsSection.style.display = 'block';
            if (altGreetingsCountEl) altGreetingsCountEl.textContent = `(${altGreetings.length})`;
            CoreAPI.setBrowseAltGreetings(altGreetings);
            if (altGreetingsEl) {
                const buildPreview = (text) => {
                    const cleaned = (text || '').replace(/\s+/g, ' ').trim();
                    if (!cleaned) return 'No content';
                    return cleaned.length > 90 ? `${cleaned.slice(0, 87)}...` : cleaned;
                };
                altGreetingsEl.innerHTML = altGreetings.map((greeting, idx) => {
                    const label = `#${idx + 1}`;
                    const preview = escapeHtml(buildPreview(greeting));
                    return `
                        <details class="browse-alt-greeting" data-greeting-idx="${idx}">
                            <summary>
                                <span class="browse-alt-greeting-index">${label}</span>
                                <span class="browse-alt-greeting-preview">${preview}</span>
                                <span class="browse-alt-greeting-chevron"><i class="fa-solid fa-chevron-down"></i></span>
                            </summary>
                            <div class="browse-alt-greeting-body"></div>
                        </details>
                    `;
                }).join('');
                altGreetingsEl.querySelectorAll('details.browse-alt-greeting').forEach(details => {
                    details.addEventListener('toggle', function onToggle() {
                        if (!details.open) return;
                        const body = details.querySelector('.browse-alt-greeting-body');
                        if (body && !body.dataset.rendered) {
                            const idx = parseInt(details.dataset.greetingIdx, 10);
                            if (altGreetings[idx] != null) {
                                deferRender(body, () => safePurify(formatRichText(altGreetings[idx], name, true), BROWSE_PURIFY_CONFIG));
                            }
                            body.dataset.rendered = '1';
                        }
                    }, { once: true });
                });
            }
        } else {
            altGreetingsSection.style.display = 'none';
            CoreAPI.setBrowseAltGreetings([]);
        }
    }
}

let ctDetailFetchToken = 0;

function openPreviewModal(hit) {
    ctSelectedChar = hit;

    const modal = document.getElementById('ctCharModal');
    if (!modal) return;
    CoreAPI.resetBrowseSectionCollapseState(modal);

    const name = hit.name || 'Unknown';
    const author = hit.author || hit.path?.split('/')[0] || 'Unknown';
    const avatarUrl = hit.path ? getAvatarUrl(hit.path) : '/img/ai4.png';
    const ctUrl = hit.path ? getCharacterPageUrl(hit.path) : '#';
    const inLibrary = isCharInLocalLibrary(hit);
    const possibleTier = inLibrary ? null : view.getPossibleMatchTier(getCtCharName(hit), author);
    const possibleMatch = !!possibleTier?.show;

    let charDef = '';

    try {
        const tagline = stripHtml(hit.tagline || '');
        const creatorNotes = hit.description || '';

        // Header
        const avatarImg = document.getElementById('ctCharAvatar');
        if (avatarImg) {
            avatarImg.src = avatarUrl;
            avatarImg.onerror = () => { avatarImg.src = '/img/ai4.png'; };
            BrowseView.adjustPortraitPosition(avatarImg);
        }
        const nameEl = document.getElementById('ctCharName');
        if (nameEl) nameEl.textContent = name;
        const creatorEl = document.getElementById('ctCharCreator');
        if (creatorEl) {
            creatorEl.textContent = author;
            creatorEl.href = '#';
            creatorEl.title = `Click to see all characters by ${author}`;
            creatorEl.onclick = (e) => {
                e.preventDefault();
                filterByAuthor(author);
            };
        }
        const openBtn = document.getElementById('ctOpenInBrowserBtn');
        if (openBtn) openBtn.href = ctUrl;

        // Tagline (above meta grid, no section header - matches Chub pattern)
        const taglineSection = document.getElementById('ctCharTaglineSection');
        const taglineEl = document.getElementById('ctCharTagline');
        if (taglineSection) {
            if (tagline) {
                taglineSection.style.display = 'block';
                if (taglineEl) taglineEl.textContent = tagline;
            } else {
                taglineSection.style.display = 'none';
            }
        }

        // Stats, tags, alt greetings: catalog hits carry little of this, so the detail fetch repaints it
        populateModalExtras(hit, name);

        // Skeletons sync, safePurify pipeline RAF-deferred so it doesnt block the modal-open paint.
        const creatorNotesSection = document.getElementById('ctCharCreatorNotesSection');
        const creatorNotesEl = document.getElementById('ctCharCreatorNotes');
        const descSection = document.getElementById('ctCharDescriptionSection');
        const descEl = document.getElementById('ctCharDescription');
        const scenarioSection = document.getElementById('ctCharScenarioSection');
        const scenarioEl = document.getElementById('ctCharScenario');
        const firstMsgSection = document.getElementById('ctCharFirstMsgSection');
        const firstMsgEl = document.getElementById('ctCharFirstMsg');
        // Catalog hits carry no definitions; a linked-card preview object is already a detail card
        charDef = hit.definition_character_description || '';
        const scenario = hit.definition_scenario || '';
        const firstMsg = hit.definition_first_message || '';
        if (creatorNotesSection && creatorNotesEl) {
            if (creatorNotes && creatorNotes.trim()) {
                creatorNotesSection.style.display = 'block';
                if (!creatorNotesEl.querySelector('iframe')) creatorNotesEl.innerHTML = skeletonLines(3);
            } else {
                creatorNotesSection.style.display = 'none';
                cleanupCreatorNotesContainer(creatorNotesEl);
                creatorNotesEl.innerHTML = '';
            }
        }
        if (descSection && descEl) { descSection.style.display = 'block'; descEl.innerHTML = skeletonLines(3); }
        if (scenarioSection && scenarioEl) { scenarioSection.style.display = 'block'; scenarioEl.innerHTML = skeletonLines(2); }
        if (firstMsgSection && firstMsgEl) { firstMsgSection.style.display = 'block'; firstMsgEl.innerHTML = skeletonLines(4); }
        requestAnimationFrame(() => {
            if (creatorNotesEl && creatorNotes && creatorNotes.trim()) {
                deferCall(creatorNotesEl, () => renderCreatorNotesSecure(creatorNotes, name, creatorNotesEl));
            }
            if (descSection && descEl) {
                if (charDef) {
                    deferCall(descEl, () => renderCardHtmlSecure(charDef, name, descEl));
                }
                // No charDef: keep skeleton, fetchAndPopulateDetails fills it.
            }
            if (scenarioSection) {
                if (scenario) {
                    if (scenarioEl) deferRender(scenarioEl, () => safePurify(formatRichText(scenario, name, true), BROWSE_PURIFY_CONFIG));
                } else {
                    scenarioSection.style.display = 'none';
                }
            }
            if (firstMsgSection) {
                if (firstMsg) {
                    if (firstMsgEl) deferRender(firstMsgEl, () => safePurify(formatRichText(firstMsg, name, true), BROWSE_PURIFY_CONFIG));
                } else {
                    firstMsgSection.style.display = 'none';
                }
            }
        });

        // Example Dialogs
        const examplesSection = document.getElementById('ctCharExamplesSection');
        const examplesEl = document.getElementById('ctCharExamples');
        const examples = hit.definition_example_messages || '';
        if (examplesSection && examplesEl) { examplesSection.style.display = 'block'; examplesEl.innerHTML = skeletonLines(3); }
        requestAnimationFrame(() => {
            if (examplesSection) {
                if (examples) {
                    if (examplesEl) deferRender(examplesEl, () => safePurify(formatRichText(examples, name, true), BROWSE_PURIFY_CONFIG));
                } else {
                    examplesSection.style.display = 'none';
                }
            }
        });

        // Import button state
        const importBtn = document.getElementById('ctImportBtn');
        if (importBtn) {
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
        }
    } catch (err) {
        console.error('[CTBrowse] Error populating preview modal:', err);
    }

    modal.classList.remove('hidden');
    const charBody = modal.querySelector('.browse-char-body');
    if (charBody) charBody.scrollTop = 0;

    // If no definition was available in the search hit, fetch full details
    if (!charDef) {
        const fetchToken = ++ctDetailFetchToken;
        fetchAndPopulateDetails(hit, fetchToken);
    }
}

async function fetchAndPopulateDetails(hit, token) {
    if (!hit.path) return;
    const parts = hit.path.split('/');
    if (parts.length < 2) return;
    const name = hit.name || 'Unknown';

    try {
        const data = await fetchCharacterDetail(parts[0], parts[1], apiRequest);
        if (token !== ctDetailFetchToken) return;

        if (!data?.card) {
            const descEl = document.getElementById('ctCharDescription');
            if (descEl) descEl.innerHTML = '<em style="color: var(--text-secondary, #888)">Could not load character definition. The character can still be imported with basic info.</em>';
            return;
        }

        const card = data.card;

        // Store full data on the selected char for import
        if (ctSelectedChar?.path === hit.path) {
            ctSelectedChar._fullDetail = card;
        }

        populateModalExtras(card, name);

        // Detail-API populate (richer than the search hit). RAF defer in case the modal-open transition is still running.
        const creatorNotesSection = document.getElementById('ctCharCreatorNotesSection');
        const creatorNotesEl = document.getElementById('ctCharCreatorNotes');
        const detailNotes = card.description || '';
        const descSection = document.getElementById('ctCharDescriptionSection');
        const descEl = document.getElementById('ctCharDescription');
        const charDef = card.definition_character_description || '';
        const scenarioSection = document.getElementById('ctCharScenarioSection');
        const scenarioEl = document.getElementById('ctCharScenario');
        const scenario = card.definition_scenario || '';
        const firstMsgSection = document.getElementById('ctCharFirstMsgSection');
        const firstMsgEl = document.getElementById('ctCharFirstMsg');
        const firstMsg = card.definition_first_message || '';
        const examplesSection = document.getElementById('ctCharExamplesSection');
        const examplesEl = document.getElementById('ctCharExamples');
        const examples = card.definition_example_messages || '';
        requestAnimationFrame(() => {
            if (detailNotes && detailNotes.trim() && creatorNotesEl) {
                if (creatorNotesSection) creatorNotesSection.style.display = 'block';
                deferCall(creatorNotesEl, () => renderCreatorNotesSecure(detailNotes, name, creatorNotesEl));
            }
            if (descSection) {
                if (charDef) {
                    descSection.style.display = 'block';
                    if (descEl) deferCall(descEl, () => renderCardHtmlSecure(charDef, name, descEl));
                } else {
                    descSection.style.display = 'none';
                }
            }
            if (scenarioSection) {
                if (scenario) {
                    scenarioSection.style.display = 'block';
                    if (scenarioEl) deferRender(scenarioEl, () => safePurify(formatRichText(scenario, name, true), BROWSE_PURIFY_CONFIG));
                } else {
                    scenarioSection.style.display = 'none';
                }
            }
            if (firstMsgSection) {
                if (firstMsg) {
                    firstMsgSection.style.display = 'block';
                    if (firstMsgEl) deferRender(firstMsgEl, () => safePurify(formatRichText(firstMsg, name, true), BROWSE_PURIFY_CONFIG));
                } else {
                    firstMsgSection.style.display = 'none';
                }
            }
            if (examplesSection) {
                if (examples) {
                    examplesSection.style.display = 'block';
                    if (examplesEl) deferRender(examplesEl, () => safePurify(formatRichText(examples, name, true), BROWSE_PURIFY_CONFIG));
                } else {
                    examplesSection.style.display = 'none';
                }
            }
        });
    } catch (err) {
        debugLog('[CTBrowse] Detail fetch error:', err);
        if (token === ctDetailFetchToken) {
            const descEl = document.getElementById('ctCharDescription');
            if (descEl) descEl.innerHTML = '<em style="color: var(--text-secondary, #888)">Could not load character definition. The character can still be imported with basic info.</em>';
        }
    }
}

// ========================================
// FOLLOWING (timeline + followed creators)
// ========================================

// CT exposes the follow list only as user ids, and a creator page is the only id -> name
// source, so resolved names are cached in settings (synced, so mobile reuses the PC's work).
const CREATOR_CACHE_KEY = 'ctCreatorNameCache';
const CREATOR_CACHE_MAX = 300;

function getCreatorCache() {
    const c = getSetting(CREATOR_CACHE_KEY);
    return c && typeof c === 'object' ? c : {};
}

/** Record a creator page's profile under its user id. */
function rememberCreator(profile, stats) {
    if (!profile?.userId || !profile.username) return;
    const cache = getCreatorCache();
    const prev = cache[profile.userId];
    const next = {
        username: profile.username,
        displayName: profile.displayName || profile.username,
        avatar: profile.avatarURL || '',
        cards: stats?.cards ?? prev?.cards ?? null,
    };
    if (prev && prev.username === next.username && prev.displayName === next.displayName
        && prev.avatar === next.avatar && prev.cards === next.cards) return;
    const ids = Object.keys(cache);
    if (!prev && ids.length >= CREATOR_CACHE_MAX) delete cache[ids[0]];
    cache[profile.userId] = next;
    setSetting(CREATOR_CACHE_KEY, cache);
}

/**
 * Fill the name cache for followed ids it lacks, by visiting creator pages of authors the
 * account is likely to follow: timeline authors first (all from followed creators), then
 * authors of liked cards. Stops as soon as every id resolves.
 */
async function resolveCreatorNames(ids) {
    const known = getCreatorCache();
    const missing = new Set(ids.filter(id => !known[id]));
    if (!missing.size) return;

    const knownNames = new Set(Object.values(known).map(c => c.username.toLowerCase()));
    const candidates = [];
    const addAuthors = (cards) => {
        for (const c of cards) {
            const u = (c.author || c.path?.split('/')[0] || '').trim();
            if (u && !knownNames.has(u.toLowerCase()) && !candidates.includes(u)) candidates.push(u);
        }
    };
    addAuthors(await fetchTimeline(apiRequest).catch(() => []));
    addAuthors(await fetchLikedCards(apiRequest).catch(() => []));

    const MAX_LOOKUPS = 40;
    for (let i = 0; i < Math.min(candidates.length, MAX_LOOKUPS) && missing.size; i += 4) {
        const batch = candidates.slice(i, i + 4);
        const pages = await Promise.all(batch.map(u => fetchCreatorPage(u, {}, apiRequest).catch(() => null)));
        for (const page of pages) {
            const uid = page?.profile?.userId;
            if (!uid) continue;
            rememberCreator(page.profile, page.stats);
            missing.delete(uid);
        }
    }
    if (missing.size) debugLog(`[CTFollow] ${missing.size} followed creator id(s) left unresolved`);
}

/** Surprise me only makes sense where there are pages to jump between. */
function syncSurpriseBtn() {
    const btn = document.getElementById('ctSurpriseBtn');
    if (!btn) return;
    btn.classList.toggle('browse-filter-hidden', ctViewMode !== 'browse' || ctTotalPages <= 1);
}

function switchCtViewMode(newMode, opts = {}) {
    ctViewMode = newMode === 'following' ? 'following' : 'browse';
    const following = ctViewMode === 'following';
    document.querySelectorAll('.chub-view-btn[data-ct-view]').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.ctView === ctViewMode));
    document.getElementById('ctBrowseSection')?.classList.toggle('hidden', following);
    document.getElementById('ctFollowingSection')?.classList.toggle('hidden', !following);
    // The timeline is one fixed, unsortable, untagged set: sort and tags only apply to Browse
    for (const id of ['ctSortContainer', 'ctTagsContainer']) {
        document.getElementById(id)?.classList.toggle('browse-filter-hidden', following);
    }
    syncSurpriseBtn();
    if (following && !opts.skipLoad && ctTimeline.length === 0) loadCtTimeline();
    if (!following && !opts.skipLoad && (ctBrowseStale || ctCharacters.length === 0)) {
        ctBrowseStale = false;
        ctCurrentPage = 1;
        loadCharacters(false);
    }
}

async function loadCtTimeline({ fresh = false } = {}) {
    const grid = document.getElementById('ctTimelineGrid');
    if (!grid) return;
    const token = ++ctTimelineToken;

    if (!isCtSessionActive()) {
        ctTimeline = [];
        grid.innerHTML = `
            <div class="browse-empty">
                <i class="fa-solid fa-key"></i>
                <h3>Login Required</h3>
                <p>Following needs your CharacterTavern session. Turn on NSFW or open Settings to add your session cookie.</p>
            </div>`;
        return;
    }

    renderSkeletonGrid(grid);
    try {
        const cards = await fetchTimeline(apiRequest, { fresh });
        if (token !== ctTimelineToken || !delegatesInitialized) return;
        ctTimeline = cards;
        renderCtTimeline();
    } catch (err) {
        if (token !== ctTimelineToken) return;
        console.error('[CTFollow] Timeline error:', err);
        renderBrowseError(grid, {
            provider: 'chartavern',
            error: err,
            view: 'timeline',
            message: `Timeline failed: ${err.message}`,
            retry: () => loadCtTimeline({ fresh: true }),
        });
    }
}

/** Paint the timeline with the same client-side filters Browse applies. */
function renderCtTimeline() {
    const grid = document.getElementById('ctTimelineGrid');
    if (!grid) return;
    let cards = ctTimeline;
    if (!ctNsfwEnabled) cards = cards.filter(h => !h.isNSFW);
    if (ctFilterHideOwned) cards = cards.filter(h => !isCharInLocalLibrary(h));
    if (ctFilterHidePossible) cards = cards.filter(h => !isCharPossibleMatchObj(h));

    if (!cards.length) {
        grid.innerHTML = `
            <div class="browse-empty">
                <i class="fa-solid fa-user-group"></i>
                <h3>${ctTimeline.length ? 'Nothing to show' : 'No Timeline Yet'}</h3>
                <p>${ctTimeline.length
                    ? 'Your filters hide every timeline character.'
                    : 'Follow creators from their creator view, or add them by name in the Manage panel.'}</p>
            </div>`;
        return;
    }
    grid.innerHTML = cards.map(c => createCtCard(c)).join('');
    chartavernBrowseView.observeImages(grid);
}

// ========================================
// ACCOUNT: LIKES (CL Favorites = CT likes)
// ========================================

/**
 * Gate an account action: cl-helper new enough + an active CT session.
 * @param {string} what - "like characters", for the prompts
 * @returns {Promise<boolean>}
 */
async function ensureCtAccount(what) {
    if (!(await CoreAPI.ensureFeatureClHelper('chartavern', 'account'))) return false;
    if (!isCtSessionActive()) {
        showToast(`Log in to CharacterTavern to ${what}`, 'info');
        openCtLoginModal();
        return false;
    }
    return true;
}

/**
 * Heart state from a source's userReaction. Catalog hits dont know it (undefined): the heart
 * stays neutral until the detail page fills it in, and refuses clicks meanwhile.
 */
function paintLikeButton(src) {
    const btn = document.getElementById('ctCharLikeBtn');
    if (!btn) return;
    const known = src.userReaction !== undefined;
    const liked = src.userReaction === 'like';
    btn.classList.toggle('favorited', liked);
    btn.classList.toggle('pending', !known);
    btn.dataset.liked = liked ? '1' : '';
    const icon = btn.querySelector('i');
    if (icon) icon.className = `fa-${liked ? 'solid' : 'regular'} fa-heart`;
    btn.title = !isCtSessionActive()
        ? 'Log in to CharacterTavern to like characters'
        : liked ? 'Unlike on CharacterTavern' : 'Like on CharacterTavern';
}

async function toggleCtLike() {
    const btn = document.getElementById('ctCharLikeBtn');
    const char = ctSelectedChar;
    if (!btn || !char || btn.classList.contains('loading')) return;
    if (!(await ensureCtAccount('like characters'))) return;
    const detail = char._fullDetail || (char.userReaction !== undefined ? char : null);
    const cardId = detail?.id || char.id;
    if (!detail || !cardId) {
        showToast('Still loading this character, try again in a moment', 'info');
        return;
    }

    btn.classList.add('loading');
    try {
        // CT toggles on every call, so one call flips whatever the current state is
        const res = await ctToggleLike(cardId, apiRequest);
        if (ctSelectedChar !== char) return; // modal moved on
        detail.userReaction = res.userReaction ?? null;
        detail.likes = res.likeCount;
        const likesEl = document.getElementById('ctCharLikes');
        if (likesEl) likesEl.textContent = formatNumber(res.likeCount ?? 0);
        paintLikeButton(detail);
        showToast(res.userReaction === 'like' ? 'Liked on CharacterTavern' : 'Removed like on CharacterTavern',
            res.userReaction === 'like' ? 'success' : 'info');
        // Unliking inside My Likes drops the card from that list
        if (ctFilterLikes && res.userReaction !== 'like') {
            ctCharacters = ctCharacters.filter(c => c.path !== char.path);
            renderGrid(ctCharacters, false);
        }
    } catch (err) {
        showToast(`Could not update like: ${err.message}`, 'error');
    } finally {
        btn.classList.remove('loading');
    }
}

function cleanupCtCharModal() {
    BrowseView.closeAvatarViewer();
    CoreAPI.setBrowseAltGreetings(null);
    const sectionIds = [
        'ctCharDescription',
        'ctCharScenario',
        'ctCharFirstMsg',
        'ctCharExamples',
        'ctCharAltGreetings',
        'ctCharTags',
    ];
    for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    const notesEl = document.getElementById('ctCharCreatorNotes');
    if (notesEl) cleanupCreatorNotesContainer(notesEl);
}

function closePreviewModal() {
    ctDetailFetchToken++;
    cleanupCtCharModal();
    const modal = document.getElementById('ctCharModal');
    if (modal) modal.classList.add('hidden');
    ctSelectedChar = null;
}

// ========================================
// IMPORT
// ========================================

async function importCharacter(charData) {
    if (!charData?.path) return;

    const importBtn = document.getElementById('ctImportBtn');
    if (importBtn) {
        importBtn.disabled = true;
        importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    }

    let inheritedGalleryId = null;

    try {
        const provider = CoreAPI.getProvider('chartavern');
        if (!provider?.importCharacter) throw new Error('CharacterTavern provider not available');

        const charName = charData.name || charData.path.split('/').pop() || '';
        const charCreator = charData.author || charData.path?.split('/')[0] || '';

        // === PRE-IMPORT DUPLICATE CHECK ===
        const duplicateMatches = await checkCharacterForDuplicatesAsync({
            name: charName,
            creator: charCreator,
            fullPath: charData.path,
            description: charData.characterDescription || '',
            first_mes: charData.characterFirstMessage || '',
            personality: charData.characterPersonality || '',
            scenario: charData.characterScenario || ''
        });

        if (duplicateMatches && duplicateMatches.length > 0) {
            if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Duplicate found...';

            const avatarUrl = getAvatarUrl(charData.path);
            const result = await showPreImportDuplicateWarning({
                name: charName,
                creator: charCreator,
                fullPath: charData.path,
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
                    console.warn('[CTBrowse] Could not delete existing character, proceeding with import anyway');
                }
            }
        }
        // === END DUPLICATE CHECK ===

        if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';

        const result = await provider.importCharacter(charData.path, charData, { inheritedGalleryId });
        if (!result.success) throw new Error(result.error || 'Import failed');

        const mediaUrls = result.embeddedMediaUrls || [];
        const galleryPageUrls = result.galleryPageUrls || [];
        const showSummary = (mediaUrls.length > 0 || galleryPageUrls.length > 0)
            && getSetting('importMediaAction') !== 'none';

        const summaryArgs = {
            mediaCharacters: [{
                name: result.characterName,
                avatar: result.fileName,
                avatarUrl: result.avatarUrl,
                mediaUrls: mediaUrls,
                galleryPageUrls: galleryPageUrls,
                galleryId: result.galleryId,
                cardData: result.cardData
            }]
        };

        await finishBrowseImport({
            view,
            summaryArgs,
            showSummary,
            closePreview: closePreviewModal,
            importBtn,
            characterName: result.characterName,
            avatarFileName: result.fileName,
            markImported: () => markCardAsImported(charData.path),
        });

    } catch (err) {
        console.error('[CTBrowse] Import failed:', err);
        showToast(`Import failed: ${err.message}`, 'error');
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
        }
    }
}

function markCardAsImported(path) {
    for (const gridId of ['ctGrid', 'ctTimelineGrid']) {
        const card = document.getElementById(gridId)?.querySelector(`[data-ct-path="${CSS.escape(path)}"]`);
        if (card) markCardElementImported(card);
    }
}

function markCardElementImported(card) {
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

async function loadTopTags() {
    if (ctTopTagsFetched) return;
    try {
        ctTopTags = await fetchTopTags(apiRequest);
        ctTopTagsFetched = true;
    } catch (e) {
        console.warn('[CTBrowse] Failed to fetch top tags:', e.message);
        ctTopTags = [];
    }
}

function renderTagsList(filter = '') {
    const container = document.getElementById('ctTagsList');
    if (!container) return;

    if (!ctTopTagsFetched) {
        container.innerHTML = '<div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>';
        return;
    }

    const filtered = filter
        ? ctTopTags.filter(t => t.tag.toLowerCase().includes(filter.toLowerCase()))
        : ctTopTags;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    container.innerHTML = filtered.map(({ tag, count }) => {
        const isIncluded = ctIncludeTags.has(tag);
        const isExcluded = ctExcludeTags.has(tag);
        let stateClass, stateIcon, stateTitle;

        if (isIncluded) {
            stateClass = 'state-include';
            stateIcon = '<i class="fa-solid fa-plus"></i>';
            stateTitle = 'Included — click to exclude';
        } else if (isExcluded) {
            stateClass = 'state-exclude';
            stateIcon = '<i class="fa-solid fa-minus"></i>';
            stateTitle = 'Excluded — click to clear';
        } else {
            stateClass = 'state-neutral';
            stateIcon = '';
            stateTitle = 'Click to include';
        }

        return `
            <div class="browse-tag-filter-item" data-tag-name="${escapeHtml(tag)}">
                <button class="browse-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label">${escapeHtml(tag)}</span>
                <span class="tag-count">${formatNumber(count)}</span>
            </div>
        `;
    }).join('');

    // Bind click handlers on tag items
    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const tagName = item.dataset.tagName;
        const stateBtn = item.querySelector('.browse-tag-state-btn');

        item.addEventListener('click', () => {
            // Cycle: neutral → include → exclude → neutral
            if (ctIncludeTags.has(tagName)) {
                ctIncludeTags.delete(tagName);
                ctExcludeTags.add(tagName);
            } else if (ctExcludeTags.has(tagName)) {
                ctExcludeTags.delete(tagName);
            } else {
                ctIncludeTags.add(tagName);
            }
            cycleTagState(stateBtn, tagName);
            updateCtTagsButton();
            ctCurrentPage = 1;
            loadCharacters(false);
        });
    });
}

function cycleTagState(btn, tagName) {
    btn.className = 'browse-tag-state-btn';
    if (ctIncludeTags.has(tagName)) {
        btn.classList.add('state-include');
        btn.innerHTML = '<i class="fa-solid fa-plus"></i>';
        btn.title = 'Included — click to exclude';
    } else if (ctExcludeTags.has(tagName)) {
        btn.classList.add('state-exclude');
        btn.innerHTML = '<i class="fa-solid fa-minus"></i>';
        btn.title = 'Excluded — click to clear';
    } else {
        btn.classList.add('state-neutral');
        btn.innerHTML = '';
        btn.title = 'Click to include';
    }
}

function updateCtTagsButton() {
    const btn = document.getElementById('ctTagsBtn');
    const label = document.getElementById('ctTagsBtnLabel');
    if (!btn) return;

    const count = ctIncludeTags.size + ctExcludeTags.size;
    if (count > 0) {
        btn.classList.add('has-filters');
        if (label) label.innerHTML = `Tags <span class="tag-count">(${count})</span>`;
    } else {
        btn.classList.remove('has-filters');
        if (label) label.textContent = 'Tags';
    }
}

function updateCtFiltersButton() {
    const btn = document.getElementById('ctFiltersBtn');
    if (!btn) return;

    const count = [ctFilterLikes, ctFilterHideOwned, ctFilterHidePossible, ctFilterHasLorebook, ctFilterIsOC].filter(Boolean).length;
    btn.classList.toggle('has-filters', count > 0);
    const span = btn.querySelector('span');
    if (span) span.textContent = count > 0 ? `Features (${count})` : 'Features';
}

// ========================================
// EVENT WIRING
// ========================================

let delegatesInitialized = false;
let modalEventsAttached = false;
function initCtView() {
    if (delegatesInitialized) return;
    delegatesInitialized = true;

    // Convert native selects to styled custom dropdowns
    const sortEl = document.getElementById('ctSortSelect');
    if (sortEl) CoreAPI.initCustomSelect?.(sortEl);

    // Grid card click → open preview (delegation), for the browse grid and the timeline
    const wireGrid = (gridId, getCards) => {
        const grid = document.getElementById(gridId);
        if (!grid) return;
        grid.addEventListener('click', (e) => {
            const authorLink = e.target.closest('.browse-card-creator-link');
            if (authorLink) {
                e.stopPropagation();
                const author = authorLink.dataset.author;
                if (!author) return;
                if (ctViewMode === 'following') switchCtViewMode('browse', { skipLoad: true });
                filterByAuthor(author);
                return;
            }

            const card = e.target.closest('.browse-card');
            if (!card) return;
            const path = card.dataset.ctPath;
            if (!path) return;
            const hit = getCards().find(c => c.path === path);
            if (hit) openPreviewModal(hit);
        });
    };
    wireGrid('ctGrid', () => ctCharacters);
    wireGrid('ctTimelineGrid', () => ctTimeline);

    // Browse / Following
    document.querySelectorAll('.chub-view-btn[data-ct-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.dataset.ctView !== ctViewMode) switchCtViewMode(btn.dataset.ctView);
        });
    });

    // Search
    on('ctSearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch();
        }
    });
    on('ctSearchInput', 'input', (e) => {
        const clearBtn = document.getElementById('ctClearSearchBtn');
        if (clearBtn) clearBtn.classList.toggle('hidden', !e.target.value.trim());
    });
    on('ctSearchBtn', 'click', () => doSearch());
    on('ctClearSearchBtn', 'click', () => {
        const input = document.getElementById('ctSearchInput');
        const clearBtn = document.getElementById('ctClearSearchBtn');
        if (input) input.value = '';
        if (clearBtn) clearBtn.classList.add('hidden');
        ctCurrentSearch = '';
        ctCurrentPage = 1;
        if (ctCreator) exitCreatorView();
        loadCharacters(false);
    });
    on('ctClearAuthorBtn', 'click', () => clearCtAuthorFilter());
    on('ctFollowCreatorBtn', 'click', () => toggleCtFollow());

    // Creator search: username, @name, or a creator/character URL
    on('ctCreatorSearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doCreatorSearch();
        }
    });
    on('ctCreatorSearchBtn', 'click', () => doCreatorSearch());

    // Load More
    on('ctLoadMoreBtn', 'click', () => {
        ctCurrentPage++;
        loadCharacters(true);
    });

    // NSFW toggle - requires active session for NSFW
    on('ctNsfwToggle', 'click', async () => {
        if (!isCtSessionActive()) {
            // NSFW needs a cookie session, which needs cl-helper. If cl-helper is the blocker the
            // login modal cant work anyway, so name that instead of sending them into a dead form.
            if (!(await CoreAPI.ensureFeatureClHelper('chartavern', 'nsfw'))) return;
            showToast('Login required for NSFW content. Use the login option in Settings or click here to log in.', 'warning');
            openCtLoginModal();
            return;
        }
        ctNsfwEnabled = !ctNsfwEnabled;
        setSetting('ctNsfw', ctNsfwEnabled);
        updateNsfwToggle();
        ctCurrentPage = 1;
        loadCharacters(false);
    });
    updateNsfwToggle();

    // Sort mode
    on('ctSortSelect', 'change', () => {
        const el = document.getElementById('ctSortSelect');
        // In creator view the same select carries the creator-page sorts
        if (el && ctCreator) ctCreatorSort = el.value;
        else if (el) ctSortMode = el.value;
        ctCurrentPage = 1;
        loadCharacters(false);
    });

    // Refresh
    on('ctSurpriseBtn', 'click', () => {
        // Same as the site: a uniformly random page of the current sort + filters
        if (ctViewMode !== 'browse' || ctTotalPages <= 1 || ctIsLoading) return;
        const total = ctTotalPages;
        let page = 1 + Math.floor(Math.random() * total);
        if (total > 1 && page === ctCurrentPage) page = (page % total) + 1;
        ctCurrentPage = page;
        loadCharacters(false);
        showToast(`Page ${page} of ${total}`, 'info', 2000);
    });

    on('ctRefreshBtn', 'click', () => {
        if (ctViewMode === 'following') {
            loadCtTimeline({ fresh: true });
            return;
        }
        ctCurrentPage = 1;
        loadCharacters(false, { fresh: true });
    });

    // ── Tags dropdown ──
    const tagsDropdown = document.getElementById('ctTagsDropdown');

    on('ctTagsBtn', 'click', async (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        if (filtersDropdown) filtersDropdown.classList.add('hidden');
        if (tagsDropdown) tagsDropdown.classList.toggle('hidden');
        // Lazy-load tags on first open
        if (!ctTopTagsFetched) {
            await loadTopTags();
            renderTagsList();
        }
    });

    if (tagsDropdown) tagsDropdown.addEventListener('click', (e) => e.stopPropagation());

    renderTagsList();

    const tagSearchInput = document.getElementById('ctTagsSearchInput');
    if (tagSearchInput) {
        const debouncedFilter = debounce((val) => renderTagsList(val), 200);
        tagSearchInput.addEventListener('input', () => debouncedFilter(tagSearchInput.value));
    }

    on('ctTagsClearBtn', 'click', () => {
        ctIncludeTags.clear();
        ctExcludeTags.clear();
        renderTagsList(document.getElementById('ctTagsSearchInput')?.value || '');
        updateCtTagsButton();
        ctCurrentPage = 1;
        loadCharacters(false);
    });

    // Min/Max tokens
    const tokenDebounce = debounce(() => {
        ctCurrentPage = 1;
        loadCharacters(false);
    }, 500);

    on('ctMinTokens', 'change', () => {
        const el = document.getElementById('ctMinTokens');
        if (el) ctMinTokens = parseInt(el.value, 10) || 0;
        tokenDebounce();
    });
    on('ctMaxTokens', 'change', () => {
        const el = document.getElementById('ctMaxTokens');
        if (el) ctMaxTokens = parseInt(el.value, 10) || 0;
        tokenDebounce();
    });

    // ── Features dropdown ──
    const filtersDropdown = document.getElementById('ctFiltersDropdown');

    on('ctFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        if (tagsDropdown) tagsDropdown.classList.add('hidden');
        if (filtersDropdown) filtersDropdown.classList.toggle('hidden');
    });

    if (filtersDropdown) filtersDropdown.addEventListener('click', (e) => e.stopPropagation());

    on('ctFilterLikes', 'change', async () => {
        const el = document.getElementById('ctFilterLikes');
        if (!el) return;
        if (el.checked && !(await ensureCtAccount('see your liked characters'))) {
            el.checked = false;
            return;
        }
        ctFilterLikes = el.checked;
        updateCtFiltersButton();
        ctCurrentPage = 1;
        loadCharacters(false);
    });

    on('ctFilterHasLorebook', 'change', () => {
        const el = document.getElementById('ctFilterHasLorebook');
        if (el) ctFilterHasLorebook = el.checked;
        updateCtFiltersButton();
        ctCurrentPage = 1;
        loadCharacters(false);
    });

    on('ctFilterIsOC', 'change', () => {
        const el = document.getElementById('ctFilterIsOC');
        if (el) ctFilterIsOC = el.checked;
        updateCtFiltersButton();
        ctCurrentPage = 1;
        loadCharacters(false);
    });

    on('ctFilterHideOwned', 'change', () => {
        const el = document.getElementById('ctFilterHideOwned');
        if (el) ctFilterHideOwned = el.checked;
        updateCtFiltersButton();
        ctCurrentPage = 1;
        loadCharacters(false);
    });

    on('ctFilterHidePossible', 'change', () => {
        const el = document.getElementById('ctFilterHidePossible');
        if (el) ctFilterHidePossible = el.checked;
        updateCtFiltersButton();
        ctCurrentPage = 1;
        loadCharacters(false);
    });

    // Close dropdowns when clicking outside (uses .contains() - works after mobile relocation to body)
    chartavernBrowseView._registerDropdownDismiss([
        { dropdownId: 'ctTagsDropdown', buttonId: 'ctTagsBtn' },
        { dropdownId: 'ctFiltersDropdown', buttonId: 'ctFiltersBtn' },
    ]);

    // ── Preview modal events (attached once - modal DOM persists across provider switches) ──
    if (!modalEventsAttached) {
        modalEventsAttached = true;

        const ctOverlay = document.getElementById('ctCharModal');
        BrowseView.wireTitleScroll(document.getElementById('ctCharName'), ctOverlay, ctOverlay?.querySelector('.browse-char-modal'));

        on('ctCharClose', 'click', () => closePreviewModal());

        // Avatar click → full-size image viewer (desktop only at event time; on mobile
        // bail before stopPropagation so the delegated tap runs)
        const ctAvatar = document.getElementById('ctCharAvatar');
        if (ctAvatar) {
            ctAvatar.addEventListener('click', (e) => {
                if (isMobileMode()) return;
                e.stopPropagation();
                if (!ctAvatar.src || ctAvatar.src.endsWith('/img/ai4.png')) return;
                // Strip CDN resize params to get original full-size PNG
                const fullSrc = ctAvatar.src.replace(/\/cdn-cgi\/image\/[^/]+\//, '/');
                BrowseView.openAvatarViewer(fullSrc, ctAvatar.src);
            });
        }

        on('ctImportBtn', 'click', () => {
            if (ctSelectedChar) importCharacter(ctSelectedChar);
        });

        on('ctCharLikeBtn', 'click', () => toggleCtLike());
        on('ctCharLikeBtn', 'keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleCtLike();
            }
        });

        const modalOverlay = document.getElementById('ctCharModal');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) closePreviewModal();
            });
        }

        // ── Login modal events ──
        on('ctLoginClose', 'click', () => closeCtLoginModal());

        on('ctSaveCookieBtn', 'click', () => {
            const cookieInput = document.getElementById('ctCookieInput');
            let cookieStr = cookieInput?.value?.trim();
            if (!cookieStr) {
                showToast('Please paste your session cookie value', 'warning');
                return;
            }
            // Accept bare value or session=VALUE format
            if (!cookieStr.includes('=')) cookieStr = `session=${cookieStr}`;
            saveCookieAndConnect(cookieStr);
        });

        on('ctLogoutBtn', 'click', () => ctLogoutAction());

        // Enter key on cookie field
        on('ctCookieInput', 'keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('ctSaveCookieBtn')?.click();
            }
        });

        const loginOverlay = document.getElementById('ctLoginModal');
        if (loginOverlay) {
            loginOverlay.addEventListener('click', (e) => {
                if (e.target === loginOverlay) closeCtLoginModal();
            });
        }

        window.registerOverlay?.({ id: 'ctCharModal', tier: 7, close: () => closePreviewModal() });
        window.registerOverlay?.({ id: 'ctLoginModal', tier: 6, close: () => closeCtLoginModal() });
        window.registerOverlay?.({ id: 'ctAuthorBanner', tier: 9, close: () => clearCtAuthorFilter() });
    }
}

function doSearch() {
    const input = document.getElementById('ctSearchInput');
    const clearBtn = document.getElementById('ctClearSearchBtn');
    const val = (input?.value || '').trim();

    // A manual search leaves creator view, and runs in Browse
    if (ctViewMode === 'following') switchCtViewMode('browse', { skipLoad: true });
    if (ctCreator) exitCreatorView();

    ctCurrentSearch = val;
    ctCurrentPage = 1;

    if (clearBtn) {
        clearBtn.classList.toggle('hidden', !val);
    }

    loadCharacters(false);
}

function doCreatorSearch() {
    const input = document.getElementById('ctCreatorSearchInput');
    const username = parseCreatorRef(input?.value);
    if (!username) {
        showToast('Enter a CharacterTavern username or creator URL', 'info');
        return;
    }
    if (input) input.value = '';
    filterByAuthor(username);
}

/** Enter creator view: the creator's own cards from their CT page (exact, paged). */
function filterByAuthor(authorName) {
    // Creator view lives in Browse (the mobile search overlay can trigger it from Following)
    if (ctViewMode === 'following') switchCtViewMode('browse', { skipLoad: true });
    const username = parseCreatorRef(authorName) || authorName;
    ctCreator = { username, displayName: username };
    ctCreatorInfo = null;
    ctCreatorSort = 'newest';
    ctCurrentSearch = '';
    ctCurrentPage = 1;
    showCreatorSorts();

    const input = document.getElementById('ctSearchInput');
    if (input) input.value = '';
    const clearBtn = document.getElementById('ctClearSearchBtn');
    if (clearBtn) clearBtn.classList.add('hidden');

    const banner = document.getElementById('ctAuthorBanner');
    if (banner) {
        if (banner.classList.contains('hidden')) window.pushOverlayGuard?.();
        banner.classList.remove('hidden');
    }
    updateCreatorBanner();
    view._cdRef = { name: username };

    closePreviewModal();

    loadCharacters(false);
}

/** Paint the creator banner from ctCreator + the last creator-page payload. */
function updateCreatorBanner() {
    if (!ctCreator) return;
    const info = ctCreatorInfo;
    const displayName = info?.profile?.displayName || ctCreator.displayName;
    ctCreator.displayName = displayName;

    const nameEl = document.getElementById('ctAuthorBannerName');
    if (nameEl) nameEl.textContent = displayName;

    const hintEl = document.getElementById('ctAuthorBannerHint');
    if (hintEl) {
        const parts = [];
        if (displayName.toLowerCase() !== ctCreator.username.toLowerCase()) parts.push(`@${ctCreator.username}`);
        if (info?.stats?.cards != null) parts.push(`${formatNumber(info.stats.cards)} characters`);
        if (info?.hiddenCount) {
            parts.push(isCtSessionActive()
                ? `${formatNumber(info.hiddenCount)} hidden by your content settings`
                : `${formatNumber(info.hiddenCount)} hidden (log in to see them)`);
        }
        hintEl.textContent = parts.length ? `(${parts.join(' · ')})` : '';
    }
    paintFollowButton();
}

/** Banner follow button: hidden for guests and your own profile, spinner until the page loads. */
function paintFollowButton() {
    const btn = document.getElementById('ctFollowCreatorBtn');
    if (!btn) return;
    const info = ctCreatorInfo;
    if (!ctCreator || !isCtSessionActive() || info?.isOwnProfile) {
        btn.style.display = 'none';
        return;
    }
    btn.style.display = '';
    if (!info?.profile?.userId) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        return;
    }
    btn.disabled = false;
    btn.classList.toggle('following', info.isFollowing);
    btn.innerHTML = info.isFollowing
        ? '<i class="fa-solid fa-heart"></i> <span>Following</span>'
        : '<i class="fa-regular fa-heart"></i> <span>Follow</span>';
    btn.title = info.isFollowing ? 'Unfollow this creator on CharacterTavern' : 'Follow this creator on CharacterTavern';
}

async function toggleCtFollow() {
    const info = ctCreatorInfo;
    const creator = ctCreator;
    const userId = info?.profile?.userId;
    if (!creator || !userId) return;
    if (!(await ensureCtAccount('follow creators'))) return;
    const btn = document.getElementById('ctFollowCreatorBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }
    try {
        const { isFollowing } = await ctSetFollow(userId, !info.isFollowing, apiRequest);
        info.isFollowing = isFollowing;
        if (info.stats?.followers != null) info.stats.followers += isFollowing ? 1 : -1;
        ctTimeline = []; // the timeline is built from the follow list; refetch it next time
        showToast(isFollowing ? `Now following ${creator.displayName}` : `Unfollowed ${creator.displayName}`,
            isFollowing ? 'success' : 'info');
    } catch (err) {
        showToast(`Could not update follow: ${err.message}`, 'error');
    } finally {
        if (ctCreator === creator) paintFollowButton();
    }
}

/** Leave creator view without reloading (callers reload as needed). */
function exitCreatorView() {
    ctCreator = null;
    ctCreatorInfo = null;
    restoreBrowseSorts();
    const banner = document.getElementById('ctAuthorBanner');
    if (banner) banner.classList.add('hidden');
}

function clearCtAuthorFilter() {
    exitCreatorView();

    ctCurrentSearch = '';
    ctCurrentPage = 1;

    const input = document.getElementById('ctSearchInput');
    if (input) input.value = '';
    const clearBtn = document.getElementById('ctClearSearchBtn');
    if (clearBtn) clearBtn.classList.add('hidden');

    loadCharacters(false);
}

function updateNsfwToggle() {
    const btn = document.getElementById('ctNsfwToggle');
    if (!btn) return;
    const sessionActive = isCtSessionActive();

    if (ctNsfwEnabled && sessionActive) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa-solid fa-fire"></i> <span>NSFW On</span>';
        btn.title = 'NSFW content enabled (logged in) - click to show SFW only';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>';
        btn.title = 'Showing SFW only - click to include NSFW (requires login)';
    }

    btn.style.opacity = sessionActive ? '' : '0.5';
}

// ========================================
// AUTH - CT COOKIE SESSION VIA CL-HELPER
// ========================================

async function openCtLoginModal() {
    ctPluginAvailable = await checkCtPluginAvailable(apiRequest);
    const sessionActive = await checkCtSession(apiRequest);
    updateCtLoginUI();

    // Pre-fill cookie field from saved setting
    const cookieInput = document.getElementById('ctCookieInput');
    if (cookieInput && !sessionActive) {
        const saved = getSetting('ctCookie');
        if (saved) cookieInput.value = saved;
    }

    const modal = document.getElementById('ctLoginModal');
    if (modal) modal.classList.remove('hidden');
}

function closeCtLoginModal() {
    const modal = document.getElementById('ctLoginModal');
    if (modal) modal.classList.add('hidden');
}

function updateCtLoginUI() {
    const pluginOk = document.getElementById('ctPluginStatusOk');
    const pluginMissing = document.getElementById('ctPluginStatusMissing');
    const cookieForm = document.getElementById('ctCookieForm');
    const saveBtn = document.getElementById('ctSaveCookieBtn');
    const sessionActive = isCtSessionActive();

    if (pluginOk) pluginOk.style.display = ctPluginAvailable ? '' : 'none';
    if (pluginMissing) pluginMissing.style.display = ctPluginAvailable ? 'none' : '';
    if (cookieForm) cookieForm.classList.toggle('ct-login-disabled', !ctPluginAvailable);
    if (saveBtn) saveBtn.disabled = !ctPluginAvailable || ctLoginInProgress;

    if (saveBtn) {
        saveBtn.innerHTML = ctLoginInProgress
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Connecting...'
            : '<i class="fa-solid fa-plug"></i> Save & Connect';
    }

    // Session status
    const statusArea = document.getElementById('ctSessionStatus');
    if (statusArea) {
        if (sessionActive) {
            statusArea.innerHTML = '<i class="fa-solid fa-check-circle" style="color: var(--cl-success-bright);"></i> <strong>Connected</strong>, NSFW content available';
            statusArea.style.display = '';
        } else {
            statusArea.style.display = 'none';
        }
    }

    // Show/hide cookie input vs logout
    const logoutBtn = document.getElementById('ctLogoutBtn');
    const cookieFields = document.getElementById('ctCookieFields');
    if (logoutBtn) logoutBtn.style.display = sessionActive ? '' : 'none';
    if (saveBtn) saveBtn.style.display = sessionActive ? 'none' : '';
    if (cookieFields) cookieFields.style.display = sessionActive ? 'none' : '';
}

async function saveCookieAndConnect(cookieStr) {
    if (ctLoginInProgress) return;

    ctLoginInProgress = true;
    updateCtLoginUI();

    try {
        const result = await ctSetCookie(apiRequest, cookieStr);
        if (!result.ok) {
            showToast(result.error || 'Failed to store cookies', 'error');
            return;
        }

        // Validate the cookies work
        const validation = await ctValidateSession(apiRequest);
        if (!validation.valid) {
            showToast(`Cookie validation failed: ${validation.reason || 'unknown'}`, 'error');
            await ctLogout(apiRequest);
            return;
        }

        // Save cookie string to settings
        setSetting('ctCookie', cookieStr);

        ctNsfwEnabled = getSetting('ctNsfw') === true;
        updateNsfwToggle();

        if (validation.hasNsfw) {
            showToast('Connected to CharacterTavern — NSFW content available!', 'success');
        } else {
            showToast('Connected, but NSFW content not detected. Check that your content preferences are enabled on character-tavern.com, or your session may be expired.', 'warning', 6000);
        }
        closeCtLoginModal();

        ctCurrentPage = 1;
        loadCharacters(false);
    } catch (err) {
        console.error('[CTAuth] Cookie save error:', err);
        showToast(`Connection error: ${err.message}`, 'error');
    } finally {
        ctLoginInProgress = false;
        updateCtLoginUI();
    }
}

async function ctLogoutAction() {
    await ctLogout(apiRequest);

    ctNsfwEnabled = false;
    setSetting('ctNsfw', false);
    setSetting('ctCookie', null);
    updateNsfwToggle();

    const cookieInput = document.getElementById('ctCookieInput');
    if (cookieInput) cookieInput.value = '';

    showToast('Disconnected from CharacterTavern', 'info');
    closeCtLoginModal();

    ctCurrentPage = 1;
    loadCharacters(false);
}

async function tryCheckSession() {
    const sessionActive = await checkCtSession(apiRequest);
    if (sessionActive) {
        // Validate the cookies still work
        const validation = await ctValidateSession(apiRequest);
        if (!validation.valid) {
            // Transient = the cookie was never judged (CT unreachable from the server, eg a VPN
            // kill-switch blocking non-browser traffic, cl-helper mid-restart, CT 5xx). Keep the
            // session AND the saved cookie; browsing surfaces its own errors if CT stays down.
            if (validation.transient) {
                debugLog('[CTAuth] Session validation transient failure, keeping cookie:', validation.reason);
                return;
            }
            debugLog('[CTAuth] Session cookies expired:', validation.reason);
            await ctLogout(apiRequest);
            ctNsfwEnabled = false;
            // Only a DEFINITIVE rejection (CT answered and refused) may destroy the persisted
            // cookie; an unmarked invalid (older cl-helper) keeps it, fail-open.
            if (validation.definitive) setSetting('ctCookie', null);
            updateNsfwToggle();
            showToast('CharacterTavern session expired - please re-authenticate.', 'warning', 5000);
            openCtLoginModal();
            return;
        }
        if (!validation.hasNsfw) {
            // Valid session without NSFW capability: the auth still works, so keep it; just
            // reflect the state and say so once per app session instead of nuking the cookie.
            ctNsfwEnabled = false;
            updateNsfwToggle();
            if (!ctNsfwWarnedThisSession) {
                ctNsfwWarnedThisSession = true;
                showToast('CharacterTavern session is active but NSFW content is not available. Check your content preferences on character-tavern.com.', 'warning', 6000);
            }
            return;
        }

        // Restore NSFW setting if session is still active
        ctNsfwEnabled = getSetting('ctNsfw') === true;
        updateNsfwToggle();
    } else {
        // No active session in cl-helper - try to restore from saved cookie
        const savedCookie = getSetting('ctCookie');
        if (savedCookie) {
            const result = await ctSetCookie(apiRequest, savedCookie);
            if (result.ok) {
                const validation = await ctValidateSession(apiRequest);
                if (validation.valid) {
                    ctNsfwEnabled = getSetting('ctNsfw') === true;
                    updateNsfwToggle();
                    return;
                }
                if (validation.transient) {
                    debugLog('[CTAuth] Saved-cookie validation transient failure, keeping cookie:', validation.reason);
                    return;
                }
                await ctLogout(apiRequest);
                if (validation.definitive) {
                    // This clear used to be silent, which read as the cookie vanishing for no
                    // reason; say what happened.
                    setSetting('ctCookie', null);
                    showToast('Saved CharacterTavern session has expired. Log in again to restore it.', 'warning', 5000);
                    debugLog('[CTAuth] Saved cookies expired, cleared');
                } else {
                    debugLog('[CTAuth] Saved-cookie validation failed without a definitive marker (older cl-helper?), keeping cookie:', validation.reason);
                }
            }
        }
    }
}

// ========================================
// BROWSE VIEW CLASS
// ========================================

class ChartavernBrowseView extends BrowseView {

    constructor(provider) {
        super(provider);
        view = this;
    }

    _extractProviderIds(char, idSet) {
        const ctData = char.data?.extensions?.chartavern;
        if (ctData?.path) idSet.add(ctData.path);
    }

    get previewModalId() { return 'ctCharModal'; }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'feed:timeline', label: 'Site feed: Timeline' },
                { value: 'feed:trending', label: 'Site feed: Trending' },
                { value: 'feed:newest', label: 'Site feed: Newest' },
                { value: 'popular', label: 'Popular' },
                { value: 'best', label: 'Best' },
                { value: 'new_noteworthy', label: 'New & Noteworthy' },
                { value: 'most_liked', label: 'Top Rated' },
                { value: 'hidden_gems', label: 'Hidden Gems' },
                { value: 'newest', label: 'Newest' },
                { value: 'recently_updated', label: 'Recently Updated' },
            ],
            followingSortOptions: [],
            viewModes: [
                { value: 'browse', label: 'Browse' },
                { value: 'following', label: 'Following' },
            ],
        };
    }

    closePreview() {
        closePreviewModal();
    }

    get mobileFilterIds() {
        return {
            sort: 'ctSortSelect',
            tags: 'ctTagsBtn',
            filters: 'ctFiltersBtn',
            nsfw: 'ctNsfwToggle',
            refresh: 'ctRefreshBtn',
            surprise: 'ctSurpriseBtn',
            modeBrowseSelector: '.chub-view-btn[data-ct-view="browse"]',
            modeFollowSelector: '.chub-view-btn[data-ct-view="following"]',
            modeBtnClass: 'chub-view-btn',
        };
    }

    get hasModeToggle() { return true; }

    // ── Following Manager (server-backed account follows) ──

    get supportsFollowingManager() { return true; }

    async getFollowedCreators() {
        if (!isCtSessionActive()) return [];
        const ids = await fetchFollowedCreatorIds(apiRequest);
        await resolveCreatorNames(ids);
        const cache = getCreatorCache();
        return ids.map((id) => {
            const c = cache[id];
            return c
                ? { id, name: c.displayName || c.username, username: c.username, avatar: c.avatar || '', characterCount: c.cards ?? undefined }
                // No timeline/liked card or visit has revealed this id's name yet; still unfollowable
                : { id, name: `Unnamed creator (${id.slice(0, 6)}...)`, username: '' };
        });
    }

    async followCreator(query) {
        if (!(await ensureCtAccount('follow creators'))) return null;
        const username = parseCreatorRef(query);
        if (!username) {
            showToast('Enter a CharacterTavern username or creator URL', 'info');
            return null;
        }
        let page;
        try {
            page = await fetchCreatorPage(username, {}, apiRequest);
        } catch (err) {
            showToast(err.notFound ? `No CharacterTavern creator named "${username}"` : `Could not look up ${username}: ${err.message}`, 'error');
            return null;
        }
        const userId = page.profile?.userId;
        if (!userId) return null;
        rememberCreator(page.profile, page.stats);
        const name = page.profile.displayName || username;
        if (page.isFollowing) {
            showToast(`Already following ${name}`, 'info');
            return { id: userId, name };
        }
        const { isFollowing } = await ctSetFollow(userId, true, apiRequest);
        if (!isFollowing) {
            showToast('Failed to follow creator', 'error');
            return null;
        }
        showToast(`Now following ${name}!`, 'success');
        if (ctViewMode === 'following') loadCtTimeline({ fresh: true });
        return { id: userId, name };
    }

    async unfollowCreator(id) {
        if (!(await ensureCtAccount('unfollow creators'))) return false;
        try {
            const { isFollowing } = await ctSetFollow(id, false, apiRequest);
            if (isFollowing) throw new Error('still following');
            showToast('Unfollowed', 'info');
            if (ctViewMode === 'following') loadCtTimeline({ fresh: true });
            return true;
        } catch (err) {
            showToast(`Failed to unfollow: ${err.message}`, 'error');
            return false;
        }
    }

    browseCreatorFromManager(creator) {
        if (!creator.username) {
            showToast('This creator\'s name has not been resolved yet', 'info');
            return;
        }
        switchCtViewMode('browse', { skipLoad: true });
        filterByAuthor(creator.username);
    }

    // ── Filter Bar ──────────────────────────────────────────

    renderFilterBar() {
        return `
            <!-- Mode Toggle (reuses the canonical chub-view-toggle styling) -->
            <div class="chub-view-toggle">
                <button class="chub-view-btn active" data-ct-view="browse" title="Browse all characters">
                    <i class="fa-solid fa-compass"></i> <span>Browse</span>
                </button>
                <button class="chub-view-btn" data-ct-view="following" title="New from creators you follow (requires login)">
                    <i class="fa-solid fa-users"></i> <span>Following</span>
                </button>
            </div>

            <!-- Sort -->
            <div class="browse-sort-container" id="ctSortContainer">
                <select id="ctSortSelect" class="glass-select" title="Sort order">
                    <optgroup label="Site feeds (28)">
                        <option value="feed:timeline">🕒 Timeline</option>
                        <option value="feed:trending">🔥 Trending</option>
                        <option value="feed:newest">✨ Newest</option>
                    </optgroup>
                    <optgroup label="Catalog">
                        <option value="popular" selected>🔥 Popular</option>
                        <option value="best">🏆 Best</option>
                        <option value="new_noteworthy">📈 New &amp; Noteworthy</option>
                        <option value="most_liked">❤️ Top Rated</option>
                        <option value="hidden_gems">💎 Hidden Gems</option>
                        <option value="newest">🆕 Newest</option>
                        <option value="recently_updated">🕐 Recently Updated</option>
                    </optgroup>
                </select>
            </div>

            <!-- Tags & Advanced Filters -->
            <div class="browse-tags-dropdown-container" id="ctTagsContainer" style="position: relative;">
                <button id="ctTagsBtn" class="glass-btn" title="Tag filters and advanced options">
                    <i class="fa-solid fa-tags"></i> <span id="ctTagsBtnLabel">Tags</span>
                </button>
                <div id="ctTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="ctTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="ctTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="ctTagsList">
                        <div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>
                    </div>
                    <hr style="margin: 10px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title"><i class="fa-solid fa-gear"></i> Advanced Options</div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Min Tokens</label>
                        <input type="number" id="ctMinTokens" class="glass-input-small" value="0" min="0" max="100000" step="100">
                    </div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Max Tokens</label>
                        <input type="number" id="ctMaxTokens" class="glass-input-small" value="0" min="0" max="500000" step="1000" placeholder="No limit">
                    </div>
                </div>
            </div>

            <!-- Feature Filters -->
            <div class="browse-more-filters" style="position: relative;">
                <button id="ctFiltersBtn" class="glass-btn" title="Additional filters">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="ctFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden" style="width: 240px;">
                    <div class="dropdown-section-title">Account:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="ctFilterLikes"> <i class="fa-solid fa-heart" style="color: #ff6b6b;"></i> My Likes</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Character must have:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="ctFilterHasLorebook"> <i class="fa-solid fa-book"></i> Lorebook</label>
                    <label class="filter-checkbox"><input type="checkbox" id="ctFilterIsOC"> <i class="fa-solid fa-star"></i> Original Character</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Library:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="ctFilterHideOwned"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                    <label class="filter-checkbox"><input type="checkbox" id="ctFilterHidePossible"> <i class="fa-solid fa-check" style="color: #f0a500;"></i> Hide Possible Matches</label>
                </div>
            </div>

            <!-- NSFW toggle -->
            <button id="ctNsfwToggle" class="glass-btn nsfw-toggle" title="Showing SFW only - click to include NSFW (requires login)" style="opacity: 0.5;">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Surprise me: jump to a random page of the current results (as the site does) -->
            <button id="ctSurpriseBtn" class="glass-btn browse-filter-hidden" title="Jump to a random page">
                <i class="fa-solid fa-shuffle"></i> <span>Surprise me</span>
            </button>

            <!-- Refresh -->
            <button id="ctRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // ── Main View ───────────────────────────────────────────

    renderView() {
        return `
            <div id="ctBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="ctSearchInput" placeholder="Search CharacterTavern characters..." autocomplete="one-time-code">
                        <button id="ctClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="ctSearchBtn" class="browse-search-submit">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                    <div class="browse-creator-search">
                        <div class="browse-creator-search-wrapper">
                            <i class="fa-solid fa-user"></i>
                            <input type="search" id="ctCreatorSearchInput" placeholder="Search by creator..." autocomplete="one-time-code">
                            <button id="ctCreatorSearchBtn" class="browse-search-submit" title="Search by creator">
                                <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <div id="ctAuthorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-user"></i>
                        <span>Showing characters by <strong id="ctAuthorBannerName">Author</strong> <span id="ctAuthorBannerHint" class="browse-author-banner-hint"></span></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <button id="ctFollowCreatorBtn" class="glass-btn browse-author-follow-btn" title="Follow this creator on CharacterTavern" style="display: none;">
                            <i class="fa-solid fa-heart"></i> <span>Follow</span>
                        </button>
                        <button id="ctClearAuthorBtn" class="glass-btn icon-only" title="Clear author filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="ctGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="ctLoadMore" style="display: none;">
                    <button id="ctLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>

            <!-- Following Section -->
            <div id="ctFollowingSection" class="browse-section hidden">
                <div class="chub-timeline-header">
                    <div class="chub-timeline-header-left">
                        <h3><i class="fa-solid fa-clock"></i> Timeline</h3>
                        <p>New characters from creators you follow</p>
                    </div>
                    <div class="chub-timeline-header-right">
                        <button class="follow-mgr-toggle-btn glass-btn" id="chartavernFollowMgrToggle"
                                title="Manage followed creators">
                            <i class="fa-solid fa-users-gear"></i> Manage
                        </button>
                    </div>
                </div>
                ${this.renderFollowingManagerPanel()}
                <div id="ctTimelineGrid" class="browse-grid"></div>
            </div>
        `;
    }

    // ── Modals ──────────────────────────────────────────────

    renderModals() {
        return this._renderLoginModal() + this._renderPreviewModal();
    }

    _renderLoginModal() {
        return `
    <div id="ctLoginModal" class="modal-overlay hidden">
        <div class="modal-glass browse-login-modal">
            <div class="modal-header">
                <h2><i class="fa-solid fa-cookie-bite"></i> CharacterTavern Session</h2>
                <button class="close-btn" id="ctLoginClose">&times;</button>
            </div>
            <div class="browse-login-body">
                <p class="browse-login-info">
                    <i class="fa-solid fa-check-circle" style="color: var(--cl-success-bright);"></i>
                    <strong>Browsing and downloading public characters works without logging in!</strong>
                </p>
                <p class="browse-login-info">
                    <i class="fa-solid fa-cookie-bite" style="color: var(--accent);"></i>
                    <strong>Optional:</strong> Paste your session cookies to see NSFW-tagged content.
                </p>

                <!-- Session status -->
                <div id="ctSessionStatus" class="pyg-auth-status" style="display:none;"></div>

                <!-- Cookie form (requires cl-helper plugin) -->
                <div class="pyg-login-section">
                    <div class="pyg-plugin-status">
                        <span id="ctPluginStatusOk" style="display:none;">
                            <i class="fa-solid fa-plug-circle-check" style="color: var(--cl-success-bright);"></i> cl-helper plugin detected
                        </span>
                        <span id="ctPluginStatusMissing" style="display:none;">
                            <i class="fa-solid fa-plug-circle-xmark" style="color: var(--cl-warning-bright-darker);"></i>
                            cl-helper plugin not found — see <a href="https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary#cl-helper-plugin-not-detected" target="_blank" style="color: var(--accent);">setup instructions</a>
                        </span>
                    </div>

                    <div id="ctCookieForm" class="browse-login-form">
                        <div id="ctCookieFields">
                            <div class="form-group">
                                <label for="ctCookieInput">Cookie String</label>
                                <textarea id="ctCookieInput" class="glass-input" rows="2" placeholder="Paste your session cookie value here" style="font-family: monospace; font-size: 12px; resize: vertical;"></textarea>
                            </div>
                            <div class="ct-cookie-instructions">
                                <details>
                                    <summary><i class="fa-solid fa-circle-question"></i> How to get your session cookie</summary>
                                    <ol>
                                        <li>Log in to <a href="https://character-tavern.com" target="_blank">character-tavern.com</a> in your browser</li>
                                        <li>Open DevTools (<code>F12</code>) → <strong>Application</strong> tab → <strong>Cookies</strong></li>
                                        <li>Find the <code>session</code> cookie for <code>character-tavern.com</code></li>
                                        <li>Copy and paste the value here</li>
                                    </ol>
                                    <p class="ct-cookie-note"><i class="fa-solid fa-clock"></i> The session cookie expires after ~10 days. You'll need to re-paste when it expires.</p>
                                </details>
                            </div>
                        </div>

                        <div class="browse-login-actions" style="margin-top: 12px;">
                            <button id="ctSaveCookieBtn" class="action-btn primary">
                                <i class="fa-solid fa-plug"></i> Save &amp; Connect
                            </button>
                            <button id="ctLogoutBtn" class="action-btn danger" style="display:none;">
                                <i class="fa-solid fa-plug-circle-xmark"></i> Disconnect
                            </button>
                            <a href="https://character-tavern.com" target="_blank" class="action-btn secondary">
                                <i class="fa-solid fa-external-link"></i> CharacterTavern
                            </a>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;
    }

    _renderPreviewModal() {
        return `
    <div id="ctCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="ctCharAvatar" src="/img/ai4.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="ctCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="ctCharCreator" class="browse-meta-identity" href="#" title="Click to see all characters by this author">Creator</a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="ctOpenInBrowserBtn" href="#" target="_blank" class="action-btn secondary" title="Open on CharacterTavern">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="ctImportBtn" class="action-btn primary" title="Download to SillyTavern">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="ctCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-tagline" id="ctCharTaglineSection" style="display: none;">
                    <i class="fa-solid fa-quote-left"></i>
                    <div id="ctCharTagline" class="browse-tagline-text"></div>
                </div>

                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-message"></i>
                            <span id="ctCharTokens">0</span> tokens
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-comments"></i>
                            <span id="ctCharChats">0</span> chats
                        </div>
                        <div class="browse-stat ct-like-btn browse-fav-toggle" id="ctCharLikeBtn" role="button" tabindex="0" title="Like on CharacterTavern">
                            <i class="fa-regular fa-heart"></i>
                            <span id="ctCharLikes">0</span> likes
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="ctCharDate">Unknown</span>
                        </div>
                        <div class="browse-stat" id="ctCharGreetingsStat" style="display: none;">
                            <i class="fa-solid fa-comment-dots"></i>
                            <span id="ctCharGreetingsCount">0</span> greetings
                        </div>
                        <div class="browse-stat" id="ctCharLorebookStat" style="display: none;">
                            <i class="fa-solid fa-book"></i>
                            Lorebook
                        </div>
                    </div>
                    <div class="browse-char-tags" id="ctCharTags"></div>
                </div>

                <!-- Creator's Notes -->
                <div class="browse-char-section" id="ctCharCreatorNotesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="ctCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="ctCharCreatorNotes" class="scrolling-text"></div>
                </div>

                <!-- Description -->
                <div class="browse-char-section" id="ctCharDescriptionSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="ctCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="ctCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="ctCharScenarioSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="ctCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="ctCharScenario" class="scrolling-text"></div>
                </div>

                <!-- Example Dialogs -->
                <div class="browse-char-section browse-section-collapsed" id="ctCharExamplesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="ctCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="ctCharExamples" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="ctCharFirstMsgSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="ctCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="ctCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <!-- Alternate Greetings -->
                <div class="browse-char-section" id="ctCharAltGreetingsSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="ctCharAltGreetingsCount"></span>
                    </h3>
                    <div id="ctCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // ── Lifecycle ───────────────────────────────────────────

    _getImageGridIds() {
        return ctViewMode === 'following' ? ['ctTimelineGrid'] : ['ctGrid'];
    }

    canLoadMore() { return ctViewMode === 'browse' && ctHasMore && !ctIsLoading; }

    loadMore() {
        ctCurrentPage++;
        loadCharacters(true);
    }

    init() {
        super.init();
        this.buildLocalLibraryLookup();
        initCtView();
        const grid = document.getElementById('ctGrid');
        if (grid) this.observeImages(grid);
        // No initial load here: init() runs before applyDefaults(), so activate() issues it.
    }

    getSearchModes() { return ['character', 'creator']; }

    getSearchInputId(mode) {
        return mode === 'creator' ? 'ctCreatorSearchInput' : 'ctSearchInput';
    }

    applyDefaults(defaults) {
        if (defaults.view === 'following') switchCtViewMode('following', { skipLoad: true });
        if (defaults.sort) {
            // Saved defaults may hold a pre-rework value (most_popular, trending, ...)
            ctSortMode = normalizeCtSort(defaults.sort);
            const el = document.getElementById('ctSortSelect');
            if (el) el.value = ctSortMode;
        }
        if (defaults.hideOwned) {
            ctFilterHideOwned = true;
            const el = document.getElementById('ctFilterHideOwned');
            if (el) el.checked = true;
        }
        if (defaults.hidePossible) {
            ctFilterHidePossible = true;
            const el = document.getElementById('ctFilterHidePossible');
            if (el) el.checked = true;
        }
        if (defaults.hideOwned || defaults.hidePossible) updateCtFiltersButton();
    }

    activate(container, options = {}) {
        if (options.domRecreated) {
            ctCurrentSearch = '';
            ctCharacters = [];
            ctCurrentPage = 1;
            ctHasMore = true;
            ctIsLoading = false;
            ctGridRenderedCount = 0;
            ctFilterHideOwned = false;
            ctFilterHidePossible = false;
            ctFilterHasLorebook = false;
            ctFilterLikes = false;
            ctFilterIsOC = false;
            ctIncludeTags = new Set();
            ctExcludeTags = new Set();
            ctMinTokens = 0;
            ctMaxTokens = 0;
            ctSortMode = CT_DEFAULT_SORT;
            ctNsfwEnabled = false;
            ctSelectedChar = null;
            ctCreator = null;
            ctCreatorInfo = null;
            ctCreatorSort = 'newest';
            ctBrowseSortStash = null; // the DOM (and its select) was rebuilt
            ctViewMode = 'browse';
            ctTimeline = [];
        }
        super.activate(container, options);

        delegatesInitialized = true;
        this.buildLocalLibraryLookup();
        // Test for real cards, not child nodes: an aborted load leaves skeletons.
        const grid = document.getElementById('ctGrid');
        const painted = !!grid?.querySelector('.browse-card');
        if (ctViewMode === 'following') {
            if (ctTimeline.length === 0) tryCheckSession().then(() => loadCtTimeline());
            else if (!document.getElementById('ctTimelineGrid')?.querySelector('.browse-card')) renderCtTimeline();
            else this.reconnectImageObserver();
        } else if (ctCharacters.length === 0) {
            // Session check first so a logged-in account fetches NSFW-inclusive results once, not twice.
            tryCheckSession().then(() => loadCharacters(false));
        } else if (!painted) {
            ctGridRenderedCount = 0;
            renderGrid(ctCharacters, false);
        } else {
            this.reconnectImageObserver();
        }
    }

    // ── Library Lookup (BrowseView contract) ────────────────

    refreshInLibraryBadges() {
        super.refreshInLibraryBadges(card => {
            const path = card.dataset.ctPath;
            const name = card.querySelector('.browse-card-name')?.textContent || '';
            const author = card.querySelector('.browse-card-creator-link')?.textContent || '';
            return isCharInLocalLibrary({ path, name, author });
        }, ['ctGrid', 'ctTimelineGrid']);
    }

    deactivate() {
        ctDetailFetchToken++;
        delegatesInitialized = false;
        super.deactivate();
        this.disconnectImageObserver();
    }
}

const chartavernBrowseView = new ChartavernBrowseView(null);

// Expose for library.js to call from viewOnProvider (linked character preview)
window.openCtCharPreview = function(hit) {
    openPreviewModal(hit);
};

window.openCtLoginModal = function() {
    openCtLoginModal();
};

export default chartavernBrowseView;
