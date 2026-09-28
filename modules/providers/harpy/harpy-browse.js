// HarpyBrowseView - harpy.chat browse/search UI for the Online tab

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import {
    IMG_PLACEHOLDER,
    BROWSE_PURIFY_CONFIG,
    skeletonLines,
    deferRender,
    deferCall,
    isMobileMode,
    finishBrowseImport,
    renderBrowseError,
    buildProviderNotice,
} from '../provider-utils.js';
import {
    HARPY_PAGE_SIZE,
    HARPY_SORT_OPTIONS,
    HARPY_TIMEFRAMES,
    searchHarpy,
    fetchHarpyListingRow,
    fetchHarpyTopTags,
    fetchHarpyCharacterPage,
    fetchHarpyGallery,
    resolveHarpyCreator,
    harpyCharName,
    harpyListingTitle,
    harpyCreatorName,
    harpyAvatarUrl,
    harpyThumbUrl,
    harpyTags,
    harpyCharacterUrl,
    parseHarpyUrl,
    formatNumber,
} from './harpy-api.js';
import { docToMarkdown, docToHtml, normalizeMacros } from './harpy-page.js';

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

let harpyCharacters = [];
let harpyOffset = 0;
let harpyHasMore = true;
let harpyIsLoading = false;
let harpyLoadToken = 0;
let harpyGridRenderedCount = 0;
let harpySearch = '';
let harpySortMode = 'trending';
let harpyTimeframe = 'all';
let harpyNsfwEnabled = false;
let harpyShowLocked = false;
let harpyExclusiveOnly = false;
let harpyFilterHideOwned = false;
let harpyFilterHidePossible = false;
let harpyMinTokens = 0;
let harpyMaxTokens = 0;
let harpySelectedChar = null;
let harpyDetailFetchToken = 0;
let harpyImportInFlight = false;

// Creator mode: an exact owner filter, not a keyword search
let harpyCreator = null; // { id, name }

/** @type {Set<string>} */
let harpyIncludeTags = new Set();
/** @type {Set<string>} */
let harpyExcludeTags = new Set();
let harpyTopTags = [];
let harpyTopTagsFetched = false;

let view; // module-scoped BrowseView instance (set once in constructor)

// ========================================
// LOCAL LIBRARY LOOKUP
// ========================================

function isCharInLocalLibrary(row) {
    if (row?.id && view._lookup.byProviderId.has(row.id)) return true;
    const creator = harpyCreatorName(row).toLowerCase().trim();
    if (!creator) return false;
    return [harpyCharName(row), harpyListingTitle(row)]
        .some(n => n && view._lookup.byNameAndCreator.has(`${n.toLowerCase().trim()}|${creator}`));
}

function isCharPossibleMatchObj(row) {
    if (isCharInLocalLibrary(row)) return false;
    return view.isCharPossibleMatch(harpyCharName(row), harpyCreatorName(row));
}

// ========================================
// TAG CLAMPING (preview)
// ========================================

function applyTagsClamp(tagsEl) {
    if (!tagsEl) return;
    tagsEl.querySelector('.browse-tags-more')?.remove();
    tagsEl.querySelectorAll('.browse-tag-hidden').forEach(t => t.classList.remove('browse-tag-hidden'));
    tagsEl.classList.remove('browse-tags-collapsed', 'browse-tags-expanded');

    const tags = Array.from(tagsEl.querySelectorAll('.browse-tag'));
    if (!tags.length) return;
    tagsEl.classList.add('browse-tags-collapsed');

    const maxHeight = parseFloat(getComputedStyle(tagsEl).getPropertyValue('--browse-tags-max-height').trim()) || tagsEl.clientHeight || 64;
    const overflowIndex = tags.findIndex(t => t.offsetTop + t.offsetHeight > maxHeight + 2);
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
        if (tagsEl.classList.contains('browse-tags-collapsed')) {
            tagsEl.classList.remove('browse-tags-collapsed');
            tagsEl.classList.add('browse-tags-expanded');
            tagsEl.querySelectorAll('.browse-tag-hidden').forEach(t => t.classList.remove('browse-tag-hidden'));
            tagsEl.appendChild(toggle);
        } else {
            applyTagsClamp(tagsEl);
        }
    });

    const insertIndex = Math.max(overflowIndex - 1, 0);
    tagsEl.insertBefore(toggle, tags[insertIndex]);
    for (let i = insertIndex; i < tags.length; i++) tags[i].classList.add('browse-tag-hidden');
}

// ========================================
// CARD RENDERING
// ========================================

function lockedTooltip() {
    return 'Definition locked by the creator: imports as an incomplete card (greetings, tags and showcase, no description or scenario)';
}

function createHarpyCard(row) {
    const name = harpyCharName(row);
    const title = harpyListingTitle(row);
    const creator = harpyCreatorName(row);
    const avatarUrl = harpyThumbUrl(row) || '/img/ai4.png';
    const tags = harpyTags(row).slice(0, 3);
    const inLibrary = isCharInLocalLibrary(row);
    const possibleTier = inLibrary ? null : view.getPossibleMatchTier(name, creator);
    const possibleMatch = !!possibleTier?.show;

    const badges = [];
    if (inLibrary) {
        badges.push('<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    } else if (possibleMatch) {
        badges.push(`<span class="browse-feature-badge possible-library pl-${possibleTier.tier}" title="${possibleTier.tooltip}"><i class="fa-solid fa-check"></i></span>`);
    }
    if (row.exclusive_status === 'approved') {
        badges.push('<span class="browse-feature-badge harpy-exclusive-badge" title="Harpy Exclusive"><i class="fa-solid fa-gem"></i></span>');
    }
    if (row.is_locked) {
        badges.push(`<span class="browse-feature-badge harpy-locked-badge" title="${escapeHtml(lockedTooltip())}"><i class="fa-solid fa-lock"></i></span>`);
    }

    const date = row.published_at || row.created_at;
    const dateInfo = date ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${new Date(date).toLocaleDateString()}</span>` : '';
    const cardClass = inLibrary ? 'browse-card in-library' : possibleMatch ? 'browse-card possible-library' : 'browse-card';
    const hover = title && title !== name ? title : '';

    return `
        <div class="${cardClass}" data-harpy-id="${escapeHtml(row.id || '')}" ${hover ? `title="${escapeHtml(hover)}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/ai4.png'">
                ${row.is_nsfw ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}
                ${badges.length ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                ${creator ? `<span class="browse-card-creator-link" data-owner-id="${escapeHtml(row.owner_id || '')}" data-author="${escapeHtml(creator)}" title="Click to see all characters by ${escapeHtml(creator)}">${escapeHtml(creator)}</span>` : ''}
                <div class="browse-card-tags">
                    ${tags.map(t => `<span class="browse-card-tag" title="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('')}
                </div>
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Tokens"><i class="fa-solid fa-font"></i> ${formatNumber(row.token_count || 0)}</span>
                <span class="browse-card-stat" title="Chats"><i class="fa-solid fa-comments"></i> ${formatNumber(row.chat_count || 0)}</span>
                <span class="browse-card-stat" title="Likes"><i class="fa-solid fa-heart"></i> ${formatNumber(row.like_count || 0)}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}

// ========================================
// GRID RENDERING
// ========================================

function renderGrid(characters, append = false) {
    const grid = document.getElementById('harpyGrid');
    if (!grid) return;
    if (!append) {
        grid.innerHTML = '';
        harpyGridRenderedCount = 0;
    }
    grid.insertAdjacentHTML('beforeend', characters.slice(harpyGridRenderedCount).map(createHarpyCard).join(''));
    harpyGridRenderedCount = characters.length;
    harpyBrowseView.observeImages(grid);
    updateLoadMore();
}

function updateLoadMore() {
    harpyBrowseView.updateLoadMoreVisibility('harpyLoadMore', harpyHasMore, harpyCharacters.length > 0);
}

// ========================================
// SEARCH / LOAD
// ========================================

function buildSearchOpts(offset) {
    const exclude = [...harpyExcludeTags];
    for (const t of getProviderExcludeTags('harpy')) if (!exclude.includes(t)) exclude.push(t);
    return {
        search: harpyCreator ? '' : harpySearch,
        sort: harpySortMode,
        timeframe: harpyTimeframe,
        exclusiveOnly: harpyExclusiveOnly,
        offset,
        limit: HARPY_PAGE_SIZE,
        includeTags: [...harpyIncludeTags],
        excludeTags: exclude,
        nsfw: harpyNsfwEnabled,
        showLocked: harpyShowLocked,
        ownerId: harpyCreator?.id || null,
        minTokens: harpyMinTokens,
        maxTokens: harpyMaxTokens,
    };
}

function applyClientFilters(rows) {
    let out = rows;
    if (harpyFilterHideOwned) out = out.filter(r => !isCharInLocalLibrary(r));
    if (harpyFilterHidePossible) out = out.filter(r => !isCharPossibleMatchObj(r));
    return out;
}

async function loadCharacters(append = false) {
    if (append && harpyIsLoading) return;
    const thisToken = ++harpyLoadToken;
    harpyIsLoading = true;

    const grid = document.getElementById('harpyGrid');
    const loadMoreBtn = document.getElementById('harpyLoadMoreBtn');
    if (!append) {
        harpyOffset = 0;
        if (grid) renderSkeletonGrid(grid);
    }
    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        let data = await searchHarpy(buildSearchOpts(harpyOffset));
        if (thisToken !== harpyLoadToken || !delegatesInitialized) return;
        harpyOffset += data.characters.length;
        harpyHasMore = data.hasMore;
        let rows = applyClientFilters(data.characters);

        // Hide Owned/Possible can empty a page; top up a few pages so the grid is not a sliver
        let autoFetches = 0;
        while ((harpyFilterHideOwned || harpyFilterHidePossible) && rows.length < HARPY_PAGE_SIZE / 2
            && harpyHasMore && autoFetches < 3 && delegatesInitialized) {
            autoFetches++;
            data = await searchHarpy(buildSearchOpts(harpyOffset));
            if (thisToken !== harpyLoadToken || !delegatesInitialized) return;
            harpyOffset += data.characters.length;
            harpyHasMore = data.hasMore;
            rows = rows.concat(applyClientFilters(data.characters));
        }

        if (append) {
            const seen = new Set(harpyCharacters.map(c => c.id));
            harpyCharacters = harpyCharacters.concat(rows.filter(r => r.id && !seen.has(r.id)));
        } else {
            harpyCharacters = rows;
        }
        renderGrid(harpyCharacters, append);

        if (!append && harpyCharacters.length === 0 && grid) {
            const hint = !harpyShowLocked ? ' (locked definitions are hidden; see Features)' : '';
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid fa-search" style="font-size: 2rem; opacity: 0.5;"></i>
                    <p style="margin-top: 12px;">No characters found${escapeHtml(hint)}</p>
                </div>
            `;
        }
        debugLog('[HarpyBrowse] Loaded', rows.length, 'characters, offset', harpyOffset, 'total', data.total);
    } catch (err) {
        if (thisToken !== harpyLoadToken) return;
        console.error('[HarpyBrowse] Search error:', err);
        showToast(`Harpy search failed: ${err.message}`, 'error');
        if (!append && grid) {
            renderBrowseError(grid, {
                provider: 'harpy',
                error: err,
                message: `Search failed: ${err.message}`,
                flags: { nsfw: harpyNsfwEnabled, showLocked: harpyShowLocked },
                retry: () => loadCharacters(false),
            });
        }
    } finally {
        if (thisToken === harpyLoadToken) {
            harpyIsLoading = false;
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

const SECTION_IDS = ['CreatorNotes', 'Description', 'Scenario', 'Examples', 'FirstMsg', 'AltGreetings', 'Gallery'];

function sectionEls(key) {
    return {
        section: document.getElementById(`harpyChar${key}Section`),
        el: document.getElementById(key === 'Gallery' ? 'harpyCharGalleryGrid' : `harpyChar${key}`),
    };
}

function setImportButtonState(state) {
    const btn = document.getElementById('harpyImportBtn');
    if (!btn) return;
    btn.classList.remove('primary', 'secondary', 'warning');
    btn.disabled = false;
    btn.title = 'Download to SillyTavern';
    switch (state) {
        case 'in-library':
            btn.classList.add('secondary');
            btn.innerHTML = '<i class="fa-solid fa-check"></i> In Library';
            break;
        case 'possible':
            btn.classList.add('warning');
            btn.innerHTML = '<i class="fa-solid fa-download"></i> Import (Possible Match)';
            break;
        case 'locked':
            btn.classList.add('secondary');
            btn.disabled = true;
            btn.title = lockedTooltip();
            btn.innerHTML = '<i class="fa-solid fa-lock"></i> Locked';
            break;
        case 'busy':
            btn.classList.add('secondary');
            btn.disabled = true;
            break;
        default:
            btn.classList.add('primary');
            btn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
    }
}

function importStateFor(row) {
    if (isCharInLocalLibrary(row)) return 'in-library';
    if (view.getPossibleMatchTier(harpyCharName(row), harpyCreatorName(row))?.show) return 'possible';
    return 'import';
}

function renderText(el, text, name) {
    deferRender(el, () => safePurify(formatRichText(text, name, true), BROWSE_PURIFY_CONFIG));
}

function openPreviewModal(row) {
    harpySelectedChar = row;
    view.injectModals();
    ensureModalEventsAttached();
    const modal = document.getElementById('harpyCharModal');
    if (!modal) return;
    CoreAPI.resetBrowseSectionCollapseState(modal);

    const name = harpyCharName(row);
    const title = harpyListingTitle(row);
    const creator = harpyCreatorName(row) || 'Unknown';

    try {
        const avatarImg = document.getElementById('harpyCharAvatar');
        if (avatarImg) {
            const src = harpyAvatarUrl(row) || row._localAvatar || '/img/ai4.png';
            avatarImg.src = src;
            avatarImg.dataset.full = src;
            avatarImg.onerror = () => { avatarImg.src = '/img/ai4.png'; };
            BrowseView.adjustPortraitPosition(avatarImg);
        }
        const nameEl = document.getElementById('harpyCharName');
        if (nameEl) nameEl.textContent = name;
        const creatorEl = document.getElementById('harpyCharCreator');
        if (creatorEl) {
            creatorEl.textContent = creator;
            creatorEl.title = `Click to see all characters by ${creator}`;
        }
        const openBtn = document.getElementById('harpyOpenInBrowserBtn');
        if (openBtn) openBtn.href = row.id ? harpyCharacterUrl(row.id) : '#';

        const taglineSection = document.getElementById('harpyCharTaglineSection');
        const taglineEl = document.getElementById('harpyCharTagline');
        const showTagline = title && title !== name;
        if (taglineSection) taglineSection.style.display = showTagline ? 'block' : 'none';
        if (taglineEl) taglineEl.textContent = showTagline ? title : '';

        const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        setText('harpyCharTokens', formatNumber(row.token_count || 0));
        setText('harpyCharChats', formatNumber(row.chat_count || 0));
        setText('harpyCharLikes', formatNumber(row.like_count || 0));
        const date = row.published_at || row.created_at;
        setText('harpyCharDate', date ? new Date(date).toLocaleDateString() : 'Unknown');
        const greetingsStat = document.getElementById('harpyCharGreetingsStat');
        if (greetingsStat) greetingsStat.style.display = 'none';
        const lockedStat = document.getElementById('harpyCharLockedStat');
        if (lockedStat) {
            lockedStat.style.display = row.is_locked ? 'flex' : 'none';
            lockedStat.title = lockedTooltip();
        }

        const tagsEl = document.getElementById('harpyCharTags');
        if (tagsEl) {
            tagsEl.innerHTML = harpyTags(row).map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
            requestAnimationFrame(() => applyTagsClamp(tagsEl));
        }

        // Skeletons now; the page fetch fills (or hides) every definition section
        for (const key of SECTION_IDS) {
            const { section, el } = sectionEls(key);
            if (!section || !el) continue;
            if (key === 'CreatorNotes') cleanupCreatorNotesContainer(el);
            const skeleton = key === 'Description' || key === 'CreatorNotes' || key === 'FirstMsg';
            section.style.display = skeleton ? 'block' : 'none';
            el.innerHTML = skeleton ? skeletonLines(3) : '';
        }
        CoreAPI.setBrowseAltGreetings([]);

        if (row.is_locked && importStateFor(row) === 'import') setImportButtonState('locked');
        else setImportButtonState(importStateFor(row));
    } catch (err) {
        console.error('[HarpyBrowse] Error populating preview modal:', err);
    }

    modal.classList.remove('hidden');
    const body = modal.querySelector('.browse-char-body');
    if (body) body.scrollTop = 0;

    fetchAndPopulateDetails(row, ++harpyDetailFetchToken);
}

function renderLockedNotice(el) {
    el.innerHTML = buildProviderNotice({
        kind: 'locked',
        layout: 'cta',
        message: "This character's definition is locked by its creator.",
        hint: 'The description and scenario are not public. You can still import an incomplete card: portrait, every greeting, tags, and the showcase notes.',
        actions: [{ key: 'partial', label: 'Import anyway', icon: 'fa-solid fa-download', variant: 'secondary' }],
    });
    el.querySelector('[data-notice-action="partial"]')?.addEventListener('click', async () => {
        if (!harpySelectedChar) return;
        const btn = el.querySelector('[data-notice-action="partial"]');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...'; }
        try {
            await importHarpyCharacter(harpySelectedChar, { allowPartial: true });
        } finally {
            const again = el.querySelector('[data-notice-action="partial"]');
            if (again) { again.disabled = false; again.innerHTML = '<i class="fa-solid fa-download"></i> Import anyway'; }
        }
    });
}

function renderAltGreetings(altGreetings, name) {
    const { section, el } = sectionEls('AltGreetings');
    const countEl = document.getElementById('harpyCharAltGreetingsCount');
    if (!section || !el) return;
    if (!altGreetings.length) {
        section.style.display = 'none';
        CoreAPI.setBrowseAltGreetings([]);
        return;
    }
    section.style.display = 'block';
    if (countEl) countEl.textContent = `(${altGreetings.length})`;
    CoreAPI.setBrowseAltGreetings(altGreetings);
    const preview = (text) => {
        const cleaned = (text || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return 'No content';
        return cleaned.length > 90 ? `${cleaned.slice(0, 87)}...` : cleaned;
    };
    el.innerHTML = altGreetings.map((g, idx) => `
        <details class="browse-alt-greeting" data-greeting-idx="${idx}">
            <summary>
                <span class="browse-alt-greeting-index">#${idx + 1}</span>
                <span class="browse-alt-greeting-preview">${escapeHtml(preview(g))}</span>
                <span class="browse-alt-greeting-chevron"><i class="fa-solid fa-chevron-down"></i></span>
            </summary>
            <div class="browse-alt-greeting-body"></div>
        </details>
    `).join('');
    el.querySelectorAll('details.browse-alt-greeting').forEach(details => {
        details.addEventListener('toggle', () => {
            if (!details.open) return;
            const body = details.querySelector('.browse-alt-greeting-body');
            if (body && !body.dataset.rendered) {
                const g = altGreetings[parseInt(details.dataset.greetingIdx, 10)];
                if (g != null) renderText(body, g, name);
                body.dataset.rendered = '1';
            }
        }, { once: true });
    });
}

function renderGallery(images) {
    const { section, el } = sectionEls('Gallery');
    const label = document.getElementById('harpyCharGalleryLabel');
    if (!section || !el) return;
    // Per-image NSFW flag: keep NSFW gallery images out while the view is SFW
    const shown = images.filter(g => harpyNsfwEnabled || !g.nsfw);
    if (!shown.length) {
        section.style.display = 'none';
        el.innerHTML = '';
        return;
    }
    section.style.display = 'block';
    if (label) label.textContent = `(${shown.length})`;
    el.innerHTML = shown.map(g => `<div class="browse-gallery-cell"><img class="browse-gallery-thumb" src="${escapeHtml(g.thumb)}" data-full="${escapeHtml(g.url)}" alt="Gallery image" loading="lazy" onload="this.parentElement.classList.add('loaded')" onerror="this.parentElement.classList.add('load-failed')"></div>`).join('');
}

async function fetchAndPopulateDetails(row, token) {
    const name = harpyCharName(row);
    const galleryPromise = fetchHarpyGallery(row.id).catch(() => []);
    let page = null;
    try {
        page = await fetchHarpyCharacterPage(row.id, CoreAPI.apiRequest);
    } catch (err) {
        debugLog('[HarpyBrowse] Page fetch error:', err);
        if (token !== harpyDetailFetchToken) return;
        const { section, el } = sectionEls('Description');
        if (section) section.style.display = 'block';
        if (el) {
            el.innerHTML = buildProviderNotice({
                kind: 'warning',
                layout: 'cta',
                message: 'Could not load this character\'s definition.',
                hint: `${err.message}. Definitions come from the public Harpy page through the cl-helper plugin, or SillyTavern's CORS proxy when cl-helper is not installed.`,
            });
        }
        for (const key of ['CreatorNotes', 'FirstMsg']) {
            const { section: s } = sectionEls(key);
            if (s) s.style.display = 'none';
        }
        return;
    }
    if (token !== harpyDetailFetchToken) return;
    if (harpySelectedChar?.id === row.id) harpySelectedChar._page = page;

    const locked = page.isLocked || row.is_locked === true;
    if (locked !== !!row.is_locked) {
        // Listing and page disagree (the creator just toggled it); the page is authoritative
        row.is_locked = locked;
        const lockedStat = document.getElementById('harpyCharLockedStat');
        if (lockedStat) lockedStat.style.display = locked ? 'flex' : 'none';
    }
    if (locked && importStateFor(row) === 'import') setImportButtonState('locked');

    const greetings = page.firstMessages.map(d => normalizeMacros(docToMarkdown(d))).filter(g => g.trim());
    const greetingsStat = document.getElementById('harpyCharGreetingsStat');
    if (greetingsStat) {
        greetingsStat.style.display = greetings.length > 1 ? 'flex' : 'none';
        const c = document.getElementById('harpyCharGreetingsCount');
        if (c) c.textContent = String(greetings.length);
    }

    const summaryHtml = docToHtml(page.raw?.summary ?? null);
    const description = normalizeMacros(page.description || '');
    const scenario = normalizeMacros(page.scenario || '');
    const examples = normalizeMacros(docToMarkdown(page.exampleDialogue));

    requestAnimationFrame(() => {
        if (token !== harpyDetailFetchToken) return;
        const notes = sectionEls('CreatorNotes');
        if (notes.section && notes.el) {
            if (summaryHtml.trim()) {
                notes.section.style.display = 'block';
                deferCall(notes.el, () => renderCreatorNotesSecure(summaryHtml, name, notes.el));
            } else {
                notes.section.style.display = 'none';
                notes.el.innerHTML = '';
            }
        }
        const desc = sectionEls('Description');
        if (desc.section && desc.el) {
            desc.section.style.display = 'block';
            if (locked) renderLockedNotice(desc.el);
            else if (description) deferCall(desc.el, () => renderCardHtmlSecure(description, name, desc.el));
            else desc.section.style.display = 'none';
        }
        for (const [key, text] of [['Scenario', scenario], ['Examples', examples], ['FirstMsg', greetings[0] || '']]) {
            const { section, el } = sectionEls(key);
            if (!section || !el) continue;
            if (text) {
                section.style.display = 'block';
                renderText(el, text, name);
            } else {
                section.style.display = 'none';
            }
        }
        renderAltGreetings(greetings.slice(1), name);
    });

    const gallery = await galleryPromise;
    if (token === harpyDetailFetchToken) renderGallery(gallery);
}

function cleanupHarpyCharModal() {
    BrowseView.closeAvatarViewer();
    CoreAPI.setBrowseAltGreetings(null);
    for (const key of SECTION_IDS) {
        const { el } = sectionEls(key);
        if (!el) continue;
        if (key === 'CreatorNotes') cleanupCreatorNotesContainer(el);
        el.innerHTML = '';
    }
    const tags = document.getElementById('harpyCharTags');
    if (tags) tags.innerHTML = '';
}

function closePreviewModal() {
    harpyDetailFetchToken++;
    cleanupHarpyCharModal();
    document.getElementById('harpyCharModal')?.classList.add('hidden');
    harpySelectedChar = null;
}

async function openPreviewById(id) {
    const grid = document.getElementById('harpyGrid');
    try {
        const row = await fetchHarpyListingRow(id);
        if (!row) {
            showToast('Character not found on Harpy (removed or private?)', 'warning');
            return;
        }
        openPreviewModal(row);
    } catch (err) {
        showToast(`Lookup failed: ${err.message}`, 'error');
    } finally {
        if (grid && !grid.querySelector('.browse-card')) renderGrid(harpyCharacters, false);
    }
}

// ========================================
// IMPORT
// ========================================

async function importHarpyCharacter(row, opts = {}) {
    if (!row?.id || harpyImportInFlight) return;
    harpyImportInFlight = true;
    const importBtn = document.getElementById('harpyImportBtn');
    const restore = () => setImportButtonState(row.is_locked && !opts.allowPartial ? 'locked' : importStateFor(row));
    if (importBtn) {
        setImportButtonState('busy');
        importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    }

    let inheritedGalleryId = null;
    try {
        const provider = CoreAPI.getProvider('harpy');
        if (!provider?.importCharacter) throw new Error('Harpy provider not available');

        const charName = harpyCharName(row);
        const charCreator = harpyCreatorName(row);
        const page = row._page;

        const duplicateMatches = await checkCharacterForDuplicatesAsync({
            name: charName,
            creator: charCreator,
            fullPath: row.id,
            description: page?.description || '',
            first_mes: page?.firstMessages?.[0] ? docToMarkdown(page.firstMessages[0]) : '',
            personality: '',
            scenario: page?.scenario || '',
        });

        if (duplicateMatches?.length) {
            if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Duplicate found...';
            const result = await showPreImportDuplicateWarning({
                name: charName,
                creator: charCreator,
                fullPath: row.id,
                avatarUrl: harpyAvatarUrl(row),
            }, duplicateMatches);

            if (result.choice === 'skip') {
                showToast('Import cancelled', 'info');
                restore();
                return;
            }
            if (result.choice === 'replace') {
                const toReplace = duplicateMatches[0].char;
                inheritedGalleryId = getCharacterGalleryId(toReplace);
                if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Replacing...';
                if (!await deleteCharacter(toReplace, false)) {
                    console.warn('[HarpyBrowse] Could not delete existing character, proceeding with import anyway');
                }
            }
        }

        if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';
        const result = await provider.importCharacter(row.id, row, { inheritedGalleryId, allowPartial: !!opts.allowPartial });
        if (!result.success) {
            if (result.locked) {
                row.is_locked = true;
                showToast('This character\'s definition is locked. Use "Import anyway" for an incomplete card.', 'warning', 6000);
                restore();
                return;
            }
            throw new Error(result.error || 'Import failed');
        }

        const mediaUrls = result.embeddedMediaUrls || [];
        const galleryPageUrls = result.galleryPageUrls || [];
        const hasGallery = !!result.hasGallery;
        const showSummary = (hasGallery || mediaUrls.length > 0 || galleryPageUrls.length > 0)
            && getSetting('importMediaAction') !== 'none';

        const summaryArgs = {
            galleryCharacters: hasGallery ? [{
                name: result.characterName,
                provider,
                linkInfo: { providerId: 'harpy', id: result.providerCharId },
                url: harpyCharacterUrl(result.providerCharId),
                avatar: result.fileName,
                galleryId: result.galleryId,
                cardData: result.cardData,
            }] : [],
            mediaCharacters: (mediaUrls.length > 0 || galleryPageUrls.length > 0) ? [{
                characterName: result.characterName,
                name: result.characterName,
                fileName: result.fileName,
                avatar: result.fileName,
                avatarUrl: result.avatarUrl,
                galleryId: result.galleryId,
                mediaUrls,
                galleryPageUrls,
                cardData: result.cardData,
            }] : [],
        };

        await finishBrowseImport({
            view,
            summaryArgs,
            showSummary,
            closePreview: closePreviewModal,
            importBtn,
            characterName: result.characterName,
            avatarFileName: result.fileName,
            markImported: () => markCardAsImported(row.id),
        });
    } catch (err) {
        console.error('[HarpyBrowse] Import failed:', err);
        showToast(`Import failed: ${err.message}`, 'error');
        restore();
    } finally {
        harpyImportInFlight = false;
    }
}

function markCardAsImported(id) {
    const card = document.getElementById('harpyGrid')?.querySelector(`[data-harpy-id="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.add('in-library');
    card.classList.remove('possible-library');
    let badgesEl = card.querySelector('.browse-feature-badges');
    if (!badgesEl) {
        card.querySelector('.browse-card-image')?.insertAdjacentHTML('beforeend', '<div class="browse-feature-badges"></div>');
        badgesEl = card.querySelector('.browse-feature-badges');
    }
    if (badgesEl) {
        badgesEl.querySelector('.possible-library')?.remove();
        if (!badgesEl.querySelector('.in-library')) {
            badgesEl.insertAdjacentHTML('afterbegin', '<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
        }
    }
}

// ========================================
// TAGS DROPDOWN
// ========================================

async function loadTopTags() {
    if (harpyTopTagsFetched) return;
    try {
        harpyTopTags = await fetchHarpyTopTags();
        harpyTopTagsFetched = true;
    } catch (e) {
        console.warn('[HarpyBrowse] Failed to fetch top tags:', e.message);
        harpyTopTags = [];
    }
}

function tagStateMarkup(tag) {
    if (harpyIncludeTags.has(tag)) return { cls: 'state-include', icon: '<i class="fa-solid fa-plus"></i>', title: 'Included — click to exclude' };
    if (harpyExcludeTags.has(tag)) return { cls: 'state-exclude', icon: '<i class="fa-solid fa-minus"></i>', title: 'Excluded — click to clear' };
    return { cls: 'state-neutral', icon: '', title: 'Click to include' };
}

function renderTagsList(filter = '') {
    const container = document.getElementById('harpyTagsList');
    if (!container) return;
    if (!harpyTopTagsFetched) {
        container.innerHTML = '<div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>';
        return;
    }
    const f = filter.toLowerCase();
    const filtered = f ? harpyTopTags.filter(t => t.tag.toLowerCase().includes(f) || t.norm.includes(f)) : harpyTopTags;
    if (!filtered.length) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }
    container.innerHTML = filtered.map(({ tag, norm, count }) => {
        const s = tagStateMarkup(norm);
        return `
            <div class="browse-tag-filter-item" data-tag-norm="${escapeHtml(norm)}">
                <button class="browse-tag-state-btn ${s.cls}" title="${s.title}">${s.icon}</button>
                <span class="tag-label">${escapeHtml(tag)}</span>
                <span class="tag-count">${formatNumber(count)}</span>
            </div>
        `;
    }).join('');
}

function updateTagsButton() {
    const btn = document.getElementById('harpyTagsBtn');
    const label = document.getElementById('harpyTagsBtnLabel');
    if (!btn) return;
    const count = harpyIncludeTags.size + harpyExcludeTags.size;
    btn.classList.toggle('has-filters', count > 0);
    if (label) {
        if (count > 0) label.innerHTML = `Tags <span class="tag-count">(${count})</span>`;
        else label.textContent = 'Tags';
    }
}

function updateFiltersButton() {
    const btn = document.getElementById('harpyFiltersBtn');
    if (!btn) return;
    const count = [harpyShowLocked, harpyExclusiveOnly, harpyFilterHideOwned, harpyFilterHidePossible].filter(Boolean).length;
    btn.classList.toggle('has-filters', count > 0);
    const span = btn.querySelector('span');
    if (span) span.textContent = count > 0 ? `Features (${count})` : 'Features';
}

// ========================================
// PUBLISHED WINDOW
// ========================================

// Latest is already ordered by publish date, so the window would only trim the end of the
// list; hide it there like harpy.chat does. The mobile sheet hides its subSort chip to match.
function syncTimeframeVisibility() {
    const el = document.getElementById('harpyTimeframeSelect');
    if (!el) return;
    const target = el._customSelect?.container || el;
    target.classList.toggle('browse-filter-hidden', harpySortMode === 'latest');
}

// ========================================
// NSFW TOGGLE
// ========================================

function updateNsfwToggle() {
    const btn = document.getElementById('harpyNsfwToggle');
    if (!btn) return;
    if (harpyNsfwEnabled) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa-solid fa-fire"></i> <span>NSFW On</span>';
        btn.title = 'NSFW characters included - click to show SFW only';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>';
        btn.title = 'Showing SFW only - click to include NSFW';
    }
}

// ========================================
// SEARCH + CREATOR
// ========================================

function doSearch() {
    const input = document.getElementById('harpySearchInput');
    const val = (input?.value || '').trim();

    // A pasted harpy.chat URL opens that character or creator instead of searching for it
    const parsed = parseHarpyUrl(val);
    if (parsed?.type === 'character') {
        if (input) input.value = '';
        openPreviewById(parsed.id);
        return;
    }
    if (parsed?.type === 'creator') {
        if (input) input.value = '';
        browseCreatorByName(parsed.name);
        return;
    }

    if (harpyCreator) clearCreatorFilter({ reload: false });
    harpySearch = val;
    document.getElementById('harpyClearSearchBtn')?.classList.toggle('hidden', !val);
    loadCharacters(false);
}

function browseCreator(creator) {
    if (!creator?.id) return;
    harpyCreator = { id: creator.id, name: creator.name || 'Creator' };
    harpyCharacters = [];
    harpyGridRenderedCount = 0;

    const banner = document.getElementById('harpyCreatorBanner');
    const bannerName = document.getElementById('harpyCreatorBannerName');
    if (banner && bannerName) {
        bannerName.textContent = harpyCreator.name;
        banner.classList.remove('hidden');
        window.pushOverlayGuard?.();
    }
    // Creator Downloads reads this off the view to know whose catalogue to bulk-fetch
    view._cdRef = { ownerId: harpyCreator.id, name: harpyCreator.name };

    closePreviewModal();
    loadCharacters(false);
}

async function browseCreatorByName(nameOrId) {
    try {
        const creator = await resolveHarpyCreator(nameOrId);
        if (!creator) {
            showToast(`No Harpy creator named "${nameOrId}"`, 'warning');
            return;
        }
        browseCreator(creator);
    } catch (err) {
        showToast(`Creator lookup failed: ${err.message}`, 'error');
    }
}

function performCreatorSearch() {
    const input = document.getElementById('harpyCreatorSearchInput');
    const query = (input?.value || '').trim();
    if (!query) {
        showToast('Enter a Harpy creator name or profile URL', 'warning');
        return;
    }
    if (input) input.value = '';
    const parsed = parseHarpyUrl(query);
    browseCreatorByName(parsed?.type === 'creator' ? parsed.name : query);
}

function clearCreatorFilter({ reload = true } = {}) {
    harpyCreator = null;
    view._cdRef = null;
    document.getElementById('harpyCreatorBanner')?.classList.add('hidden');
    if (reload) loadCharacters(false);
}

// ========================================
// EVENT WIRING
// ========================================

let delegatesInitialized = false;
let modalEventsAttached = false;

function resetAndLoad() {
    harpyOffset = 0;
    loadCharacters(false);
}

function initHarpyView() {
    if (delegatesInitialized) return;
    delegatesInitialized = true;

    const sortEl = document.getElementById('harpySortSelect');
    if (sortEl) {
        sortEl.value = harpySortMode;
        CoreAPI.initCustomSelect?.(sortEl);
    }
    const timeframeEl = document.getElementById('harpyTimeframeSelect');
    if (timeframeEl) {
        timeframeEl.value = harpyTimeframe;
        CoreAPI.initCustomSelect?.(timeframeEl);
    }
    syncTimeframeVisibility();

    const grid = document.getElementById('harpyGrid');
    if (grid) {
        grid.addEventListener('click', (e) => {
            const authorLink = e.target.closest('.browse-card-creator-link');
            if (authorLink) {
                e.stopPropagation();
                const ownerId = authorLink.dataset.ownerId;
                if (ownerId) browseCreator({ id: ownerId, name: authorLink.dataset.author });
                else if (authorLink.dataset.author) browseCreatorByName(authorLink.dataset.author);
                return;
            }
            const card = e.target.closest('.browse-card');
            const id = card?.dataset.harpyId;
            if (!id) return;
            const row = harpyCharacters.find(c => c.id === id);
            if (row) openPreviewModal(row);
        });
    }

    on('harpySearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch();
        }
    });
    on('harpySearchInput', 'input', (e) => {
        document.getElementById('harpyClearSearchBtn')?.classList.toggle('hidden', !e.target.value.trim());
    });
    on('harpySearchBtn', 'click', () => doSearch());
    on('harpyClearSearchBtn', 'click', () => {
        const input = document.getElementById('harpySearchInput');
        if (input) input.value = '';
        document.getElementById('harpyClearSearchBtn')?.classList.add('hidden');
        harpySearch = '';
        resetAndLoad();
    });
    on('harpyCreatorSearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            performCreatorSearch();
        }
    });
    on('harpyCreatorSearchBtn', 'click', () => performCreatorSearch());
    on('harpyClearCreatorBtn', 'click', () => clearCreatorFilter());

    on('harpyLoadMoreBtn', 'click', () => loadCharacters(true));

    on('harpyNsfwToggle', 'click', () => {
        harpyNsfwEnabled = !harpyNsfwEnabled;
        setSetting('harpyNsfw', harpyNsfwEnabled);
        updateNsfwToggle();
        resetAndLoad();
    });
    updateNsfwToggle();

    on('harpySortSelect', 'change', () => {
        const el = document.getElementById('harpySortSelect');
        if (el) harpySortMode = el.value;
        syncTimeframeVisibility();
        resetAndLoad();
    });
    on('harpyTimeframeSelect', 'change', (e) => {
        harpyTimeframe = e.target.value;
        resetAndLoad();
    });
    on('harpyRefreshBtn', 'click', () => resetAndLoad());

    // ── Tags dropdown ──
    const tagsDropdown = document.getElementById('harpyTagsDropdown');
    const filtersDropdown = document.getElementById('harpyFiltersDropdown');

    on('harpyTagsBtn', 'click', async (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        filtersDropdown?.classList.add('hidden');
        tagsDropdown?.classList.toggle('hidden');
        if (!harpyTopTagsFetched) {
            await loadTopTags();
            renderTagsList(document.getElementById('harpyTagsSearchInput')?.value || '');
        }
    });
    tagsDropdown?.addEventListener('click', (e) => e.stopPropagation());
    renderTagsList();

    // Delegated: renderTagsList rebuilds the rows on every filter keystroke
    document.getElementById('harpyTagsList')?.addEventListener('click', (e) => {
        const item = e.target.closest('.browse-tag-filter-item');
        const norm = item?.dataset.tagNorm;
        if (!norm) return;
        if (harpyIncludeTags.has(norm)) {
            harpyIncludeTags.delete(norm);
            harpyExcludeTags.add(norm);
        } else if (harpyExcludeTags.has(norm)) {
            harpyExcludeTags.delete(norm);
        } else {
            harpyIncludeTags.add(norm);
        }
        const s = tagStateMarkup(norm);
        const btn = item.querySelector('.browse-tag-state-btn');
        if (btn) {
            btn.className = `browse-tag-state-btn ${s.cls}`;
            btn.innerHTML = s.icon;
            btn.title = s.title;
        }
        updateTagsButton();
        resetAndLoad();
    });

    const tagSearchInput = document.getElementById('harpyTagsSearchInput');
    if (tagSearchInput) {
        const debouncedFilter = debounce((val) => renderTagsList(val), 200);
        tagSearchInput.addEventListener('input', () => debouncedFilter(tagSearchInput.value));
    }
    on('harpyTagsClearBtn', 'click', () => {
        harpyIncludeTags.clear();
        harpyExcludeTags.clear();
        renderTagsList(document.getElementById('harpyTagsSearchInput')?.value || '');
        updateTagsButton();
        resetAndLoad();
    });

    const tokenDebounce = debounce(() => resetAndLoad(), 500);
    on('harpyMinTokens', 'change', (e) => { harpyMinTokens = parseInt(e.target.value, 10) || 0; tokenDebounce(); });
    on('harpyMaxTokens', 'change', (e) => { harpyMaxTokens = parseInt(e.target.value, 10) || 0; tokenDebounce(); });

    // ── Features dropdown ──
    on('harpyFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        tagsDropdown?.classList.add('hidden');
        filtersDropdown?.classList.toggle('hidden');
    });
    filtersDropdown?.addEventListener('click', (e) => e.stopPropagation());

    const bindFilter = (id, set) => on(id, 'change', (e) => {
        set(!!e.target.checked);
        updateFiltersButton();
        resetAndLoad();
    });
    // Locked-definition opt-in; default browsing is open definitions only, as on Saucepan
    bindFilter('harpyShowLocked', v => { harpyShowLocked = v; });
    bindFilter('harpyExclusiveOnly', v => { harpyExclusiveOnly = v; });
    bindFilter('harpyFilterHideOwned', v => { harpyFilterHideOwned = v; });
    bindFilter('harpyFilterHidePossible', v => { harpyFilterHidePossible = v; });

    harpyBrowseView._registerDropdownDismiss([
        { dropdownId: 'harpyTagsDropdown', buttonId: 'harpyTagsBtn' },
        { dropdownId: 'harpyFiltersDropdown', buttonId: 'harpyFiltersBtn' },
    ]);
    window.registerOverlay?.({ id: 'harpyCreatorBanner', tier: 9, close: () => clearCreatorFilter() });

    ensureModalEventsAttached();
}

// Attached once: the modal DOM persists in document.body across provider switches, and the
// preview can open from the library ("View on Harpy") before the browse view ever has.
function ensureModalEventsAttached() {
    if (modalEventsAttached) return;
    const overlay = document.getElementById('harpyCharModal');
    if (!overlay) return;
    modalEventsAttached = true;

    BrowseView.wireTitleScroll(document.getElementById('harpyCharName'), overlay, overlay.querySelector('.browse-char-modal'));
    on('harpyCharClose', 'click', () => closePreviewModal());
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closePreviewModal();
    });

    const avatar = document.getElementById('harpyCharAvatar');
    avatar?.addEventListener('click', (e) => {
        if (isMobileMode()) return;
        e.stopPropagation();
        if (!avatar.src || avatar.src.endsWith('/img/ai4.png')) return;
        BrowseView.openAvatarViewer(avatar.dataset.full || avatar.src, avatar.src);
    });

    const galleryGrid = document.getElementById('harpyCharGalleryGrid');
    galleryGrid?.addEventListener('click', (e) => {
        if (!e.target.classList.contains('browse-gallery-thumb')) return;
        const thumbs = [...galleryGrid.querySelectorAll('.browse-gallery-thumb')];
        const urls = thumbs.map(t => t.dataset.full || t.src);
        const idx = thumbs.indexOf(e.target);
        BrowseView.openAvatarViewer(urls[idx], e.target.src, urls, idx);
    });

    document.getElementById('harpyCharCreator')?.addEventListener('click', (e) => {
        e.preventDefault();
        const row = harpySelectedChar;
        if (!row) return;
        if (row.owner_id) browseCreator({ id: row.owner_id, name: harpyCreatorName(row) });
        else if (harpyCreatorName(row)) browseCreatorByName(harpyCreatorName(row));
    });

    on('harpyImportBtn', 'click', () => {
        if (harpySelectedChar) importHarpyCharacter(harpySelectedChar);
    });

    window.registerOverlay?.({ id: 'harpyCharModal', tier: 7, close: () => closePreviewModal() });
}

// ========================================
// BROWSE VIEW CLASS
// ========================================

class HarpyBrowseView extends BrowseView {
    constructor(provider) {
        super(provider);
        view = this;
    }

    _extractProviderIds(char, idSet) {
        const id = char.data?.extensions?.harpy?.id;
        if (id) idSet.add(id);
    }

    get previewModalId() { return 'harpyCharModal'; }

    getSettingsConfig() {
        return {
            browseSortOptions: HARPY_SORT_OPTIONS.map(o => ({ value: o.value, label: o.label })),
            followingSortOptions: [],
            viewModes: [],
        };
    }

    closePreview() {
        closePreviewModal();
    }

    openPreview(row) {
        if (row) openPreviewModal(row);
    }

    get mobileFilterIds() {
        return {
            sort: 'harpySortSelect',
            subSort: 'harpyTimeframeSelect',
            tags: 'harpyTagsBtn',
            filters: 'harpyFiltersBtn',
            nsfw: 'harpyNsfwToggle',
            refresh: 'harpyRefreshBtn',
        };
    }

    getSearchModes() { return ['character', 'creator']; }

    getSearchInputId(mode) {
        return mode === 'creator' ? 'harpyCreatorSearchInput' : 'harpySearchInput';
    }

    getSearchPlaceholder(mode) {
        return mode === 'creator' ? 'Harpy creator name...' : 'Search Harpy or paste a URL...';
    }

    // ── Filter Bar ──────────────────────────────────────────

    renderFilterBar() {
        return `
            <div class="browse-sort-container">
                <select id="harpySortSelect" class="glass-select" title="Sort order">
                    ${HARPY_SORT_OPTIONS.map((o, i) => `<option value="${o.value}"${i === 0 ? ' selected' : ''}>${o.emoji} ${o.label}</option>`).join('')}
                </select>
                <select id="harpyTimeframeSelect" class="glass-select" title="Published within">
                    ${HARPY_TIMEFRAMES.map((t, i) => `<option value="${t.value}"${i === 0 ? ' selected' : ''}>📅 ${t.label}</option>`).join('')}
                </select>
            </div>

            <div class="browse-tags-dropdown-container" style="position: relative;">
                <button id="harpyTagsBtn" class="glass-btn" title="Tag filters and advanced options">
                    <i class="fa-solid fa-tags"></i> <span id="harpyTagsBtnLabel">Tags</span>
                </button>
                <div id="harpyTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="harpyTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="harpyTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="harpyTagsList">
                        <div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>
                    </div>
                    <hr style="margin: 10px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title"><i class="fa-solid fa-gear"></i> Advanced Options</div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Min Tokens</label>
                        <input type="number" id="harpyMinTokens" class="glass-input-small" value="0" min="0" max="100000" step="100">
                    </div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Max Tokens</label>
                        <input type="number" id="harpyMaxTokens" class="glass-input-small" value="0" min="0" max="500000" step="1000" placeholder="No limit">
                    </div>
                </div>
            </div>

            <div class="browse-more-filters" style="position: relative;">
                <button id="harpyFiltersBtn" class="glass-btn" title="Additional filters">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="harpyFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden" style="width: 250px;">
                    <div class="dropdown-section-title">Definitions:</div>
                    <label class="filter-checkbox" title="${escapeHtml(lockedTooltip())}"><input type="checkbox" id="harpyShowLocked"> <i class="fa-solid fa-lock"></i> Show Locked Definitions</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Content:</div>
                    <label class="filter-checkbox" title="Only characters Harpy approved as Exclusive"><input type="checkbox" id="harpyExclusiveOnly"> <i class="fa-solid fa-gem"></i> Exclusive Only</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Library:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="harpyFilterHideOwned"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                    <label class="filter-checkbox"><input type="checkbox" id="harpyFilterHidePossible"> <i class="fa-solid fa-check" style="color: #f0a500;"></i> Hide Possible Matches</label>
                </div>
            </div>

            <button id="harpyNsfwToggle" class="glass-btn nsfw-toggle" title="Showing SFW only - click to include NSFW">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <button id="harpyRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // ── Main View ───────────────────────────────────────────

    renderView() {
        return `
            <div id="harpyBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="harpySearchInput" placeholder="Search Harpy or paste a harpy.chat URL..." autocomplete="one-time-code">
                        <button id="harpyClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="harpySearchBtn" class="browse-search-submit">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                    <div class="browse-creator-search">
                        <div class="browse-creator-search-wrapper">
                            <i class="fa-solid fa-user"></i>
                            <input type="search" id="harpyCreatorSearchInput" placeholder="Creator name or profile URL..." autocomplete="one-time-code">
                            <button id="harpyCreatorSearchBtn" class="browse-search-submit" title="Browse a creator">
                                <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <div id="harpyCreatorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-feather-pointed"></i>
                        <span>Browsing characters by <strong id="harpyCreatorBannerName">Creator</strong></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <button id="harpyClearCreatorBtn" class="glass-btn icon-only" title="Clear creator filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <div id="harpyGrid" class="browse-grid"></div>

                <div class="browse-load-more" id="harpyLoadMore" style="display: none;">
                    <button id="harpyLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // ── Modals ──────────────────────────────────────────────

    renderModals() {
        const section = (key, label, icon, extra = '', bodyClass = 'scrolling-text') => `
                <div class="browse-char-section" id="harpyChar${key}Section" style="display: none;">
                    <h3 class="browse-section-title" data-section="harpyChar${key}" data-label="${label}" data-icon="${icon}" title="Click to expand">
                        <i class="${icon}"></i> ${label}${extra}
                    </h3>
                    <div id="harpyChar${key}" class="${bodyClass}"></div>
                </div>`;
        return `
    <div id="harpyCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="harpyCharAvatar" src="/img/ai4.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="harpyCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="harpyCharCreator" class="browse-meta-identity" href="#" title="Click to see all characters by this creator">Creator</a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="harpyOpenInBrowserBtn" href="#" target="_blank" class="action-btn secondary" title="Open on Harpy">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="harpyImportBtn" class="action-btn primary" title="Download to SillyTavern">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="harpyCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-tagline" id="harpyCharTaglineSection" style="display: none;">
                    <i class="fa-solid fa-quote-left"></i>
                    <div id="harpyCharTagline" class="browse-tagline-text"></div>
                </div>

                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat"><i class="fa-solid fa-message"></i> <span id="harpyCharTokens">0</span> tokens</div>
                        <div class="browse-stat"><i class="fa-solid fa-comments"></i> <span id="harpyCharChats">0</span> chats</div>
                        <div class="browse-stat"><i class="fa-solid fa-heart"></i> <span id="harpyCharLikes">0</span> likes</div>
                        <div class="browse-stat"><i class="fa-solid fa-calendar"></i> <span id="harpyCharDate">Unknown</span></div>
                        <div class="browse-stat" id="harpyCharGreetingsStat" style="display: none;"><i class="fa-solid fa-comment-dots"></i> <span id="harpyCharGreetingsCount">0</span> greetings</div>
                        <div class="browse-stat" id="harpyCharLockedStat" style="display: none;"><i class="fa-solid fa-lock"></i> Locked definition</div>
                    </div>
                    <div class="browse-char-tags" id="harpyCharTags"></div>
                </div>
                ${section('CreatorNotes', 'Creator\'s Notes', 'fa-solid fa-feather-pointed')}
                ${section('Description', 'Description', 'fa-solid fa-scroll')}
                ${section('Scenario', 'Scenario', 'fa-solid fa-theater-masks')}
                ${section('Examples', 'Example Dialogs', 'fa-solid fa-comments', '<span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>')}
                ${section('FirstMsg', 'First Message', 'fa-solid fa-message', '', 'scrolling-text first-message-preview')}
                <div class="browse-char-section" id="harpyCharAltGreetingsSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="harpyCharAltGreetingsCount"></span>
                    </h3>
                    <div id="harpyCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>
                <div class="browse-char-section" id="harpyCharGallerySection" style="display: none;">
                    <h3 class="browse-section-title" data-section="harpyCharGalleryGrid" data-label="Gallery" data-icon="fa-solid fa-images" title="Click to expand">
                        <i class="fa-solid fa-images"></i> Gallery <span class="browse-section-count" id="harpyCharGalleryLabel"></span>
                    </h3>
                    <div id="harpyCharGalleryGrid" class="browse-gallery-grid"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // ── Lifecycle ───────────────────────────────────────────

    _getImageGridIds() {
        return ['harpyGrid'];
    }

    canLoadMore() { return harpyHasMore && !harpyIsLoading; }

    loadMore() {
        loadCharacters(true);
    }

    init() {
        super.init();
        this.buildLocalLibraryLookup();
        // Restore before the first load so the persisted choice drives it
        harpyNsfwEnabled = getSetting('harpyNsfw') === true;
        initHarpyView();
        const grid = document.getElementById('harpyGrid');
        if (grid) this.observeImages(grid);
        // No initial load here: init() runs before applyDefaults(), so activate() issues it.
    }

    applyDefaults(defaults) {
        if (defaults.sort && HARPY_SORT_OPTIONS.some(o => o.value === defaults.sort)) {
            harpySortMode = defaults.sort;
            const el = document.getElementById('harpySortSelect');
            if (el) {
                el.value = defaults.sort;
                el._customSelect?.refresh?.();
            }
            syncTimeframeVisibility();
        }
        if (defaults.hideOwned) {
            harpyFilterHideOwned = true;
            const el = document.getElementById('harpyFilterHideOwned');
            if (el) el.checked = true;
        }
        if (defaults.hidePossible) {
            harpyFilterHidePossible = true;
            const el = document.getElementById('harpyFilterHidePossible');
            if (el) el.checked = true;
        }
        if (defaults.hideOwned || defaults.hidePossible) updateFiltersButton();
    }

    activate(container, options = {}) {
        if (options.domRecreated) {
            harpySearch = '';
            harpyCharacters = [];
            harpyOffset = 0;
            harpyHasMore = true;
            harpyIsLoading = false;
            harpyGridRenderedCount = 0;
            harpyShowLocked = false;
            harpyExclusiveOnly = false;
            harpyTimeframe = 'all';
            harpyFilterHideOwned = false;
            harpyFilterHidePossible = false;
            harpyIncludeTags = new Set();
            harpyExcludeTags = new Set();
            harpyMinTokens = 0;
            harpyMaxTokens = 0;
            harpySortMode = 'trending';
            harpyCreator = null;
            harpySelectedChar = null;
            view._cdRef = null;
        }
        super.activate(container, options);

        delegatesInitialized = true;
        harpyNsfwEnabled = getSetting('harpyNsfw') === true;
        updateNsfwToggle();
        this.buildLocalLibraryLookup();
        const grid = document.getElementById('harpyGrid');
        const painted = !!grid?.querySelector('.browse-card');
        if (harpyCharacters.length === 0) {
            loadCharacters(false);
        } else if (!painted) {
            harpyGridRenderedCount = 0;
            renderGrid(harpyCharacters, false);
        } else {
            this.reconnectImageObserver();
        }
    }

    refreshInLibraryBadges() {
        super.refreshInLibraryBadges(card => {
            const row = harpyCharacters.find(c => c.id === card.dataset.harpyId);
            return row ? isCharInLocalLibrary(row) : false;
        });
    }

    deactivate() {
        harpyDetailFetchToken++;
        delegatesInitialized = false;
        super.deactivate();
        this.disconnectImageObserver();
    }
}

const harpyBrowseView = new HarpyBrowseView(null);
export default harpyBrowseView;
