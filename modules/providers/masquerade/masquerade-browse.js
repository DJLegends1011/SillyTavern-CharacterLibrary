// MasqueradeBrowseView - public browse/search UI for MasqueradeAI.

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber, BROWSE_PURIFY_CONFIG, skeletonLines } from '../provider-utils.js';
import {
    MASQUERADE_SORT_OPTIONS,
    isMasqueradePagedSort,
    browseMasqueradeCharacters,
    searchMasqueradeCharacters,
    fetchMasqueradeMetadata,
    getAvatarUrl,
    getCharacterPageUrl,
    getGalleryUrls,
} from './masquerade-api.js';

const {
    showToast,
    escapeHtml,
    debugLog,
    getSetting,
    setSetting,
    fetchCharacters,
    fetchAndAddCharacter,
    checkCharacterForDuplicatesAsync,
    showPreImportDuplicateWarning,
    deleteCharacter,
    getCharacterGalleryId,
    showImportSummaryModal,
    formatRichText,
    safePurify,
    debounce,
    getProviderExcludeTags,
    renderLoadingState,
    hideModal,
} = CoreAPI;

const PAGE_SIZE = 60;
let masqueradeCharacters = [];
let masqueradeCurrentPage = 1;
let masqueradeHasMore = true;
let masqueradeIsLoading = false;
let masqueradeLoadToken = 0;
let masqueradeGridRenderedCount = 0;
let masqueradeCurrentSearch = '';
let masqueradeCurrentSort = 'popular';
let masqueradeNsfwEnabled = false;
let masqueradeSelectedChar = null;
let masqueradeModalListenersBound = false;
let masqueradeTagFilters = new Map();
let masqueradeFilterHideOwned = false;
let masqueradeFilterHidePossible = false;
let masqueradeFilterHasGallery = false;
let masqueradeFilterHasAltGreetings = false;
let masqueradeFilterAmplified = false;
let masqueradePopularTags = [];
let masqueradeTagsLoaded = false;
let masqueradeTagFilterDebounceTimeout = null;

let view;

function esc(value) {
    return escapeHtml ? escapeHtml(String(value ?? '')) : String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[ch]));
}

function richText(value, name = '') {
    if (!value) return '';
    const formatted = formatRichText
        ? formatRichText(String(value), name, true)
        : esc(value).replace(/\n/g, '<br>');
    return safePurify ? (safePurify(formatted, BROWSE_PURIFY_CONFIG) || formatted) : formatted;
}

function bind(id, event, handler) {
    const el = document.getElementById(id);
    if (!el) return false;
    el.addEventListener(event, handler);
    return true;
}

function isCharInLocalLibrary(char) {
    const id = char.id || char.character_id || '';
    if (id && view._lookup.byProviderId.has(id)) return true;
    return false;
}

function isCharPossibleMatchObj(char) {
    if (isCharInLocalLibrary(char)) return false;
    return view.isCharPossibleMatch(char.name || '', '');
}

function normalizeTagName(tag) {
    return String(tag || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function getNormalizedTags(char) {
    return (char.tags || []).map(normalizeTagName).filter(Boolean);
}

function hasAltGreetings(char) {
    return Array.isArray(char.alternate_greetings) && char.alternate_greetings.some(g => String(g || '').trim());
}

function hasGallery(char) {
    return getGalleryUrls(char).length > 0;
}

function getMasqueradeFilterTags() {
    const includeTags = [];
    const excludeTags = [];

    for (const [tag, state] of masqueradeTagFilters) {
        const normalized = normalizeTagName(tag);
        if (!normalized) continue;
        if (state === 'include') includeTags.push(normalized);
        if (state === 'exclude') excludeTags.push(normalized);
    }

    for (const tag of getProviderExcludeTags?.('masquerade') || []) {
        const normalized = normalizeTagName(tag);
        if (normalized && !excludeTags.includes(normalized)) excludeTags.push(normalized);
    }

    return { includeTags, excludeTags };
}

function hasActiveMasqueradeClientFilters() {
    return masqueradeTagFilters.size > 0
        || masqueradeFilterHideOwned
        || masqueradeFilterHidePossible
        || masqueradeFilterHasGallery
        || masqueradeFilterHasAltGreetings
        || masqueradeFilterAmplified;
}

function getFilteredMasqueradeCharacters() {
    let display = masqueradeCharacters;
    const { includeTags, excludeTags } = getMasqueradeFilterTags();

    if (includeTags.length > 0) {
        display = display.filter(char => {
            const tags = getNormalizedTags(char);
            return includeTags.some(tag => tags.includes(tag));
        });
    }

    if (excludeTags.length > 0) {
        display = display.filter(char => {
            const tags = getNormalizedTags(char);
            return !excludeTags.some(tag => tags.includes(tag));
        });
    }

    if (masqueradeFilterHideOwned) display = display.filter(char => !isCharInLocalLibrary(char));
    if (masqueradeFilterHidePossible) display = display.filter(char => !isCharPossibleMatchObj(char));
    if (masqueradeFilterHasGallery) display = display.filter(hasGallery);
    if (masqueradeFilterHasAltGreetings) display = display.filter(hasAltGreetings);
    if (masqueradeFilterAmplified) display = display.filter(char => char.is_amplified);

    return display;
}

function extractMasqueradeTagsFromResults(characters) {
    if (masqueradeTagsLoaded && masqueradePopularTags.length >= 100) return;

    const tagCounts = new Map();
    for (const tag of masqueradePopularTags) tagCounts.set(tag, 10);

    for (const char of characters || []) {
        for (const tag of char.tags || []) {
            const normalized = normalizeTagName(tag);
            if (normalized && normalized.length > 1 && normalized.length < 40) {
                tagCounts.set(normalized, (tagCounts.get(normalized) || 0) + 1);
            }
        }
    }

    const sortedTags = [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 200)
        .map(([tag]) => tag);

    if (sortedTags.length > masqueradePopularTags.length) {
        masqueradePopularTags = sortedTags;
        masqueradeTagsLoaded = true;
    }
}

function updateSearchClearButton() {
    const input = document.getElementById('masqueradeSearchInput');
    const clearBtn = document.getElementById('masqueradeClearSearchBtn');
    clearBtn?.classList.toggle('hidden', !(input?.value || '').trim());
}

function updateMasqueradeNsfwToggle() {
    const btn = document.getElementById('masqueradeNsfwToggle');
    if (!btn) return;

    btn.classList.toggle('active', masqueradeNsfwEnabled);
    if (masqueradeNsfwEnabled) {
        btn.style.opacity = '1';
        btn.innerHTML = '<i class="fa-solid fa-fire"></i> <span>Feral On</span>';
    } else {
        btn.style.opacity = '0.5';
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>';
    }
}

function createMasqueradeCard(char) {
    const id = char.id || char.character_id || '';
    const name = char.name || 'Unknown';
    const tagline = char.tagline || char.personality || '';
    const creatorName = char.creator_name || char.creatorUsername || char.username || char.author || '';
    const avatarUrl = getAvatarUrl(char);
    const tags = (char.tags || []).slice(0, 3);
    const inLibrary = isCharInLocalLibrary(char);
    const possibleMatch = !inLibrary && isCharPossibleMatchObj(char);
    const cardClass = inLibrary ? 'browse-card in-library' : possibleMatch ? 'browse-card possible-library' : 'browse-card';

    const badges = [];
    if (inLibrary) {
        badges.push('<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    } else if (possibleMatch) {
        badges.push('<span class="browse-feature-badge possible-library" title="Possible Match in Library"><i class="fa-solid fa-check"></i></span>');
    }
    if (char.is_nsfw) badges.push('<span class="browse-feature-badge nsfw" title="NSFW"><i class="fa-solid fa-eye-slash"></i></span>');
    if (char.is_amplified) badges.push('<span class="browse-feature-badge" title="Amplified"><i class="fa-solid fa-bolt"></i></span>');
    if (getGalleryUrls(char).length) badges.push('<span class="browse-feature-badge" title="Extra images"><i class="fa-solid fa-images"></i></span>');

    const createdDate = char.created_at ? new Date(char.created_at).toLocaleDateString() : '';

    return `
        <div class="${cardClass}" data-masquerade-id="${esc(id)}" ${tagline ? `title="${esc(tagline)}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${esc(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${esc(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/ai4.png'">
                ${char.is_nsfw ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}
                ${badges.length ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${esc(name)}</div>
                ${creatorName ? `<span class="browse-card-creator">by ${esc(creatorName)}</span>` : ''}
                <div class="browse-card-tags">
                    ${tags.map(tag => `<span class="browse-card-tag" title="${esc(tag)}">${esc(tag)}</span>`).join('')}
                </div>
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Messages"><i class="fa-solid fa-message"></i> ${formatNumber(char.total_messages || 0)}</span>
                <span class="browse-card-stat" title="Fans"><i class="fa-solid fa-bookmark"></i> ${formatNumber(char.subscriber_count || 0)}</span>
                ${createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${esc(createdDate)}</span>` : ''}
            </div>
        </div>
    `;
}

function renderGrid(_characters = masqueradeCharacters, append = false) {
    const grid = document.getElementById('masqueradeGrid');
    if (!grid) return;

    const displayCharacters = getFilteredMasqueradeCharacters();
    const canAppend = append && !hasActiveMasqueradeClientFilters();

    if (!canAppend) {
        grid.innerHTML = '';
        masqueradeGridRenderedCount = 0;
    }

    if (displayCharacters.length === 0) {
        const filtered = masqueradeCharacters.length > 0 && hasActiveMasqueradeClientFilters();
        renderEmpty(filtered ? 'All characters in this view were filtered out by your current filters.' : 'No characters found');
        masqueradeBrowseView.updateLoadMoreVisibility('masqueradeLoadMore', masqueradeHasMore, masqueradeCharacters.length > 0);
        return;
    }

    const start = masqueradeGridRenderedCount;
    const html = displayCharacters.slice(start).map(createMasqueradeCard).join('');
    grid.insertAdjacentHTML('beforeend', html);
    masqueradeGridRenderedCount = displayCharacters.length;
    masqueradeBrowseView.observeImages(grid);
    masqueradeBrowseView.updateLoadMoreVisibility('masqueradeLoadMore', masqueradeHasMore, masqueradeCharacters.length > 0);
}

function renderEmpty(message, icon = 'fa-search') {
    const grid = document.getElementById('masqueradeGrid');
    if (!grid) return;
    const isError = icon.includes('triangle') || /^Load failed/i.test(message || '');
    grid.innerHTML = `
        <div class="${isError ? 'browse-error' : 'browse-empty'}" style="grid-column: 1 / -1;">
            <i class="fa-solid ${icon}"></i>
            <h3>${isError ? 'Failed to load MasqueradeAI' : 'No characters found'}</h3>
            <p>${esc(message)}</p>
        </div>
    `;
}

function getVisibleMasqueradeCount() {
    return getFilteredMasqueradeCharacters().length;
}

async function loadMasqueradeCharacters(append = false) {
    if (append && masqueradeIsLoading) return;

    const token = ++masqueradeLoadToken;
    masqueradeIsLoading = true;
    const grid = document.getElementById('masqueradeGrid');
    const loadMoreBtn = document.getElementById('masqueradeLoadMoreBtn');

    if (!append && grid) {
        if (renderLoadingState) renderLoadingState(grid, 'Loading MasqueradeAI...', 'browse-loading');
        else grid.innerHTML = '<div class="browse-loading">Loading MasqueradeAI...</div>';
    }
    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        const { excludeTags } = getMasqueradeFilterTags();
        const fetchPage = page => {
            const opts = {
                query: masqueradeCurrentSearch,
                page,
                limit: PAGE_SIZE,
                sort: masqueradeCurrentSort,
                nsfw: masqueradeNsfwEnabled,
                excludeTags,
            };
            return masqueradeCurrentSearch
                ? searchMasqueradeCharacters(opts)
                : browseMasqueradeCharacters(opts);
        };
        const pageHasMore = results => results.length >= PAGE_SIZE
            && (masqueradeCurrentSearch || isMasqueradePagedSort(masqueradeCurrentSort));
        const mergeResults = results => {
            const seen = new Set(masqueradeCharacters.map(c => c.id));
            for (const char of results) {
                if (char.id && !seen.has(char.id)) {
                    seen.add(char.id);
                    masqueradeCharacters.push(char);
                }
            }
        };

        const results = await fetchPage(masqueradeCurrentPage);

        if (token !== masqueradeLoadToken) return;

        if (append) {
            mergeResults(results);
        } else {
            masqueradeCharacters = results;
        }

        extractMasqueradeTagsFromResults(results);
        masqueradeHasMore = pageHasMore(results);

        if (hasActiveMasqueradeClientFilters() && masqueradeHasMore) {
            let autoFetches = 0;
            while (getVisibleMasqueradeCount() < PAGE_SIZE
                && masqueradeHasMore
                && autoFetches < 3
                && token === masqueradeLoadToken) {
                autoFetches++;
                masqueradeCurrentPage++;
                const moreResults = await fetchPage(masqueradeCurrentPage);
                if (token !== masqueradeLoadToken) return;
                mergeResults(moreResults);
                extractMasqueradeTagsFromResults(moreResults);
                masqueradeHasMore = pageHasMore(moreResults);
            }
        }

        renderGrid(masqueradeCharacters, append);
        if (!append && masqueradeCharacters.length === 0) renderEmpty('No characters found');
        debugLog?.('[MasqueradeBrowse] Loaded', results.length, 'characters');
    } catch (error) {
        if (token !== masqueradeLoadToken) return;
        console.error('[MasqueradeBrowse] Load failed:', error);
        showToast?.(`MasqueradeAI load failed: ${error.message}`, 'error');
        renderEmpty(`Load failed: ${error.message}`, 'fa-triangle-exclamation');
    } finally {
        if (token === masqueradeLoadToken) {
            masqueradeIsLoading = false;
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
            }
        }
    }
}

function resetAndLoad() {
    masqueradeCurrentPage = 1;
    masqueradeHasMore = true;
    masqueradeGridRenderedCount = 0;
    return loadMasqueradeCharacters(false);
}

function setSectionHtml(sectionId, contentId, value, name) {
    const section = document.getElementById(sectionId);
    const el = document.getElementById(contentId);
    const text = String(value || '').trim();
    if (section) section.style.display = text ? 'block' : 'none';
    if (!el) return;
    if (text) {
        el.innerHTML = richText(text, name);
        el.dataset.fullContent = text;
    } else {
        el.innerHTML = '';
        delete el.dataset.fullContent;
    }
}

function renderMasqueradePreviewSkeletons() {
    for (const [sectionId, contentId, count] of [
        ['masqueradeCharDescriptionSection', 'masqueradeCharDescription', 3],
        ['masqueradeCharPersonalitySection', 'masqueradeCharPersonality', 2],
        ['masqueradeCharScenarioSection', 'masqueradeCharScenario', 2],
        ['masqueradeCharFirstMsgSection', 'masqueradeCharFirstMsg', 4],
    ]) {
        const section = document.getElementById(sectionId);
        const content = document.getElementById(contentId);
        if (section) section.style.display = 'block';
        if (content) {
            content.innerHTML = skeletonLines(count);
            delete content.dataset.fullContent;
        }
    }
}

function renderMasqueradeAltGreetings(greetings, name) {
    const section = document.getElementById('masqueradeCharAltGreetingsSection');
    const list = document.getElementById('masqueradeCharAltGreetings');
    const count = document.getElementById('masqueradeCharAltGreetingsCount');
    const stat = document.getElementById('masqueradeCharGreetingsStat');
    const statCount = document.getElementById('masqueradeCharGreetingsCount');
    const validGreetings = (Array.isArray(greetings) ? greetings : [])
        .map(greeting => String(greeting || '').trim())
        .filter(Boolean);

    if (stat) stat.style.display = validGreetings.length ? 'flex' : 'none';
    if (statCount) statCount.textContent = validGreetings.length + 1;
    if (count) count.textContent = validGreetings.length ? `(${validGreetings.length})` : '';
    window.currentBrowseAltGreetings = validGreetings;

    if (!section || !list) return;
    if (!validGreetings.length) {
        section.style.display = 'none';
        list.innerHTML = '';
        return;
    }

    const buildPreview = text => {
        const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return 'No content';
        return cleaned.length > 90 ? `${cleaned.slice(0, 87)}...` : cleaned;
    };

    section.style.display = 'block';
    list.innerHTML = validGreetings.map((greeting, idx) => `
        <details class="browse-alt-greeting" data-greeting-idx="${idx}">
            <summary>
                <span class="browse-alt-greeting-index">#${idx + 1}</span>
                <span class="browse-alt-greeting-preview">${esc(buildPreview(greeting))}</span>
                <span class="browse-alt-greeting-chevron"><i class="fa-solid fa-chevron-down"></i></span>
            </summary>
            <div class="browse-alt-greeting-body"></div>
        </details>
    `).join('');

    list.querySelectorAll?.('details.browse-alt-greeting').forEach(details => {
        details.addEventListener('toggle', function onToggle() {
            if (!details.open) return;
            const body = details.querySelector('.browse-alt-greeting-body');
            if (body && !body.dataset.rendered) {
                const idx = parseInt(details.dataset.greetingIdx, 10);
                body.innerHTML = richText(validGreetings[idx] || '', name);
                body.dataset.rendered = '1';
            }
        }, { once: true });
    });
}

function renderMasqueradeGallery(char) {
    const urls = getGalleryUrls(char);
    const section = document.getElementById('masqueradeCharGallerySection');
    const grid = document.getElementById('masqueradeCharGalleryGrid');
    const stat = document.getElementById('masqueradeCharGalleryStat');
    const statCount = document.getElementById('masqueradeCharGalleryCount');
    const label = document.getElementById('masqueradeCharGalleryLabel');

    if (stat) stat.style.display = urls.length ? 'flex' : 'none';
    if (statCount) statCount.textContent = urls.length;
    if (label) label.textContent = urls.length ? `(${urls.length})` : '';
    if (!section || !grid) return;

    if (!urls.length) {
        section.style.display = 'none';
        grid.innerHTML = '';
        return;
    }

    section.style.display = 'block';
    grid.innerHTML = urls.map((url, idx) => `
        <div class="browse-gallery-cell">
            <img class="browse-gallery-thumb" src="${esc(url)}" alt="${esc(char.name || `Gallery image ${idx + 1}`)}" title="${esc(char.name || 'Gallery image')}" loading="lazy" onload="this.parentElement.classList.add('loaded')" onerror="this.parentElement.classList.add('load-failed')">
        </div>
    `).join('');
}

function cleanupMasqueradeCharModal() {
    const avatarViewer = document.getElementById('browseAvatarViewer');
    if (avatarViewer?.remove) BrowseView.closeAvatarViewer?.();
    window.currentBrowseAltGreetings = null;

    const modal = document.getElementById('masqueradeCharModal');
    modal?.querySelectorAll?.('[data-full-content]').forEach(el => {
        delete el.dataset.fullContent;
    });

    const contentIds = [
        'masqueradeCharTagline',
        'masqueradeCharDescription',
        'masqueradeCharPersonality',
        'masqueradeCharScenario',
        'masqueradeCharFirstMsg',
        'masqueradeCharAltGreetings',
        'masqueradeCharGalleryGrid',
    ];
    for (const id of contentIds) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }

    masqueradeSelectedChar = null;
}

function openPreviewModal(char, { loading = false } = {}) {
    masqueradeSelectedChar = char;
    const modal = document.getElementById('masqueradeCharModal');
    if (!modal) return;
    window.resetBrowseSectionCollapseState?.(modal);

    const name = char.name || 'Unknown';
    const creatorName = char.creator_name || char.creatorUsername || char.username || char.author || 'Unknown';
    const avatar = document.getElementById('masqueradeCharAvatar');
    if (avatar) {
        avatar.src = getAvatarUrl(char);
        avatar.onerror = () => { avatar.src = '/img/ai4.png'; };
        BrowseView.adjustPortraitPosition(avatar);
    }

    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value || '';
    };

    setText('masqueradeCharName', name);
    setText('masqueradeCharCreator', creatorName);
    const tagline = getSetting?.('showMasqueradeTagline') === false ? '' : char.tagline || '';
    setText('masqueradeCharTagline', tagline);
    const taglineSection = document.getElementById('masqueradeCharTaglineSection');
    if (taglineSection) taglineSection.style.display = tagline ? 'flex' : 'none';
    setText('masqueradeCharMessages', formatNumber(char.total_messages || 0));
    setText('masqueradeCharUsers', formatNumber(char.unique_chatters || 0));
    setText('masqueradeCharFans', formatNumber(char.subscriber_count || 0));
    setText('masqueradeCharDate', char.created_at ? new Date(char.created_at).toLocaleDateString() : 'Unknown');
    if (loading) {
        renderMasqueradePreviewSkeletons();
    } else {
        setSectionHtml('masqueradeCharDescriptionSection', 'masqueradeCharDescription', char.description || '', name);
        setSectionHtml('masqueradeCharPersonalitySection', 'masqueradeCharPersonality', char.personality || '', name);
        setSectionHtml(
            'masqueradeCharScenarioSection',
            'masqueradeCharScenario',
            char.scenario && char.scenario !== char.description ? char.scenario : '',
            name,
        );
        setSectionHtml('masqueradeCharFirstMsgSection', 'masqueradeCharFirstMsg', char.greeting || char.first_mes || '', name);
    }
    renderMasqueradeAltGreetings(char.alternate_greetings || [], name);
    renderMasqueradeGallery(char);

    const tagsEl = document.getElementById('masqueradeCharTags');
    if (tagsEl) tagsEl.innerHTML = (char.tags || []).map(tag => `<span class="browse-tag">${esc(tag)}</span>`).join('');

    const openBtn = document.getElementById('masqueradeOpenInBrowserBtn');
    if (openBtn) openBtn.href = getCharacterPageUrl(char.id);

    const importBtn = document.getElementById('masqueradeImportBtn');
    if (importBtn) {
        const inLibrary = isCharInLocalLibrary(char);
        const possibleMatch = !inLibrary && isCharPossibleMatchObj(char);
        importBtn.disabled = false;
        importBtn.classList.toggle('secondary', inLibrary);
        importBtn.classList.toggle('warning', possibleMatch);
        importBtn.classList.toggle('primary', !inLibrary && !possibleMatch);
        importBtn.innerHTML = inLibrary
            ? '<i class="fa-solid fa-check"></i> In Library'
            : possibleMatch
                ? '<i class="fa-solid fa-download"></i> Import (Possible Match)'
                : '<i class="fa-solid fa-download"></i> Import';
    }

    modal.classList.remove('hidden');
    const body = modal.querySelector('.browse-char-body');
    if (body) body.scrollTop = 0;
}

function closePreviewModal() {
    cleanupMasqueradeCharModal();
    hideModal?.('masqueradeCharModal');
}

export function buildMasqueradeImportSummary(result, provider) {
    const mediaUrls = result?.embeddedMediaUrls || [];
    const galleryPageUrls = result?.galleryPageUrls || [];
    const hasProviderGallery = !!result?.hasGallery;
    if (!hasProviderGallery && mediaUrls.length === 0 && galleryPageUrls.length === 0) return null;

    const fullPath = result?.fullPath || result?.providerCharId || '';
    const providerCharId = result?.providerCharId || fullPath || null;

    return {
        galleryCharacters: hasProviderGallery ? [{
            name: result.characterName,
            fullPath,
            provider,
            linkInfo: { id: providerCharId, fullPath },
            url: providerCharId ? getCharacterPageUrl(providerCharId) : '',
            avatar: result.fileName,
            galleryId: result.galleryId,
        }] : [],
        mediaCharacters: (mediaUrls.length > 0 || galleryPageUrls.length > 0) ? [{
            name: result.characterName,
            avatar: result.fileName,
            avatarUrl: result.avatarUrl,
            mediaUrls,
            galleryPageUrls,
            galleryId: result.galleryId,
            cardData: result.cardData,
        }] : [],
    };
}

async function importSelectedCharacter() {
    const charData = masqueradeSelectedChar;
    if (!charData?.id) return;

    const importBtn = document.getElementById('masqueradeImportBtn');
    const originalImportHtml = importBtn?.innerHTML || '<i class="fa-solid fa-download"></i> Import';
    if (importBtn) {
        importBtn.disabled = true;
        importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    }

    let inheritedGalleryId = null;

    try {
        const provider = CoreAPI.getProvider?.('masquerade');
        if (!provider?.importCharacter) throw new Error('MasqueradeAI provider not available');

        const duplicateMatches = await checkCharacterForDuplicatesAsync?.({
            name: charData.name || '',
            creator: '',
            fullPath: charData.id,
            description: charData.description || '',
            first_mes: charData.greeting || '',
            personality: charData.personality || charData.tagline || '',
            scenario: charData.scenario || '',
        });

        if (duplicateMatches?.length > 0) {
            if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Duplicate found...';
            const result = await showPreImportDuplicateWarning?.({
                name: charData.name || '',
                creator: '',
                fullPath: charData.id,
                avatarUrl: getAvatarUrl(charData),
            }, duplicateMatches);

            if (result?.choice === 'skip') {
                showToast?.('Import cancelled', 'info');
                return;
            }

            if (result?.choice === 'replace') {
                const toReplace = duplicateMatches[0].char;
                inheritedGalleryId = getCharacterGalleryId?.(toReplace) || null;
                if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Replacing...';
                const deleted = await deleteCharacter?.(toReplace, false);
                if (!deleted) console.warn('[MasqueradeBrowse] Could not delete existing character, importing anyway');
            }
        }

        if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';

        const result = await provider.importCharacter(charData.id, charData, { inheritedGalleryId });
        if (!result.success) throw new Error(result.error || 'Import failed');

        const importSummary = buildMasqueradeImportSummary(result, provider);
        const shouldShowSummary = importSummary && getSetting?.('notifyAdditionalContent') !== false;
        const isMobile = window.matchMedia?.('(max-width: 768px)').matches === true;
        if (shouldShowSummary && isMobile) {
            showImportSummaryModal?.(importSummary);
            await new Promise(resolve => setTimeout(resolve, 220));
            closePreviewModal();
        } else {
            closePreviewModal();
            if (typeof requestAnimationFrame === 'function') await new Promise(resolve => requestAnimationFrame(resolve));
            if (shouldShowSummary) showImportSummaryModal?.(importSummary);
        }

        showToast?.(`Imported "${result.characterName}"`, 'success');

        const added = await fetchAndAddCharacter?.(result.fileName);
        if (!added) await fetchCharacters?.(true);
        view.buildLocalLibraryLookup();
        markCardAsImported(charData.id);
    } catch (error) {
        console.error('[MasqueradeBrowse] Import failed:', error);
        showToast?.(`Import failed: ${error.message}`, 'error');
    } finally {
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.innerHTML = originalImportHtml;
        }
    }
}

function markCardAsImported(charId) {
    const card = document.querySelector(`[data-masquerade-id="${charId}"]`);
    if (!card) return;
    card.classList.add('in-library');
    card.classList.remove('possible-library');
    let badges = card.querySelector('.browse-feature-badges');
    if (!badges) {
        card.querySelector('.browse-card-image')?.insertAdjacentHTML('beforeend', '<div class="browse-feature-badges"></div>');
        badges = card.querySelector('.browse-feature-badges');
    }
    badges?.querySelector('.possible-library')?.remove();
    if (badges && !badges.querySelector('.in-library')) {
        badges.insertAdjacentHTML('afterbegin', '<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    }
}

function bindPersistentModalListeners() {
    if (masqueradeModalListenersBound) return;

    const modal = document.getElementById('masqueradeCharModal');
    if (!modal) return;

    const isDesktop = !window.matchMedia?.('(max-width: 768px)').matches;
    if (isDesktop && typeof MutationObserver !== 'undefined') {
        BrowseView.wireTitleScroll?.(
            document.getElementById('masqueradeCharName'),
            modal,
            modal.querySelector?.('.browse-char-modal'),
        );
    }

    const avatar = document.getElementById('masqueradeCharAvatar');
    if (avatar && isDesktop) {
        avatar.addEventListener('click', event => {
            event.stopPropagation();
            if (!avatar.src || avatar.src.endsWith('/img/ai4.png')) return;
            BrowseView.openAvatarViewer?.(avatar.src);
        });
    }

    const galleryGrid = document.getElementById('masqueradeCharGalleryGrid');
    galleryGrid?.addEventListener('click', event => {
        if (!event.target.classList?.contains('browse-gallery-thumb')) return;
        const thumbs = [...galleryGrid.querySelectorAll('.browse-gallery-thumb')];
        const urls = thumbs.map(thumb => thumb.src);
        const idx = thumbs.indexOf(event.target);
        BrowseView.openAvatarViewer?.(event.target.src, null, urls, idx);
    });

    bind('masqueradeCharClose', 'click', closePreviewModal);
    bind('masqueradeImportBtn', 'click', importSelectedCharacter);
    modal.addEventListener('click', event => {
        if (event.target.id === 'masqueradeCharModal') closePreviewModal();
    });
    if (typeof window !== 'undefined') {
        window.registerOverlay?.({ id: 'masqueradeCharModal', tier: 7, close: closePreviewModal });
    }

    masqueradeModalListenersBound = true;
}

function updateMasqueradeTagsButtonState() {
    const label = document.getElementById('masqueradeTagsBtnLabel');
    const btn = document.getElementById('masqueradeTagsBtn');
    if (!label || !btn) return;

    const includeCount = Array.from(masqueradeTagFilters.values()).filter(v => v === 'include').length;
    const excludeCount = Array.from(masqueradeTagFilters.values()).filter(v => v === 'exclude').length;
    const parts = [];
    if (includeCount > 0) parts.push(`+${includeCount}`);
    if (excludeCount > 0) parts.push(`-${excludeCount}`);

    label.textContent = parts.length > 0 ? `Tags (${parts.join('/')})` : 'Tags';
    btn.classList.toggle('has-filters', parts.length > 0);
}

function updateMasqueradeFiltersButtonState() {
    const btn = document.getElementById('masqueradeFiltersBtn');
    if (!btn) return;

    const count = (masqueradeFilterHideOwned ? 1 : 0)
        + (masqueradeFilterHidePossible ? 1 : 0)
        + (masqueradeFilterHasGallery ? 1 : 0)
        + (masqueradeFilterHasAltGreetings ? 1 : 0)
        + (masqueradeFilterAmplified ? 1 : 0);

    btn.classList.toggle('has-filters', count > 0);
    btn.innerHTML = count > 0
        ? `<i class="fa-solid fa-sliders"></i> Features (${count})`
        : '<i class="fa-solid fa-sliders"></i> Features';
}

function triggerMasqueradeReloadDebounced() {
    if (masqueradeTagFilterDebounceTimeout) clearTimeout(masqueradeTagFilterDebounceTimeout);
    masqueradeTagFilterDebounceTimeout = setTimeout(() => {
        masqueradeTagFilterDebounceTimeout = null;
        resetAndLoad();
    }, 500);
}

function renderMasqueradeTagsList(filter = '') {
    const container = document.getElementById('masqueradeTagsList');
    if (!container) return;

    if (masqueradePopularTags.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">Type a tag name and press Enter to filter</div>';
        return;
    }

    const filterLower = normalizeTagName(filter);
    const filteredTags = filterLower
        ? masqueradePopularTags.filter(tag => tag.includes(filterLower))
        : masqueradePopularTags;
    const hasExactMatch = filterLower && filteredTags.some(tag => tag === filterLower);
    const showCustomAdd = filterLower && filterLower.length >= 2 && !hasExactMatch;

    if (filteredTags.length === 0 && !showCustomAdd) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags - press Enter to add as filter</div>';
        return;
    }

    const sortedTags = [...filteredTags].sort((a, b) => {
        const aState = masqueradeTagFilters.get(a);
        const bState = masqueradeTagFilters.get(b);
        if (aState && !bState) return -1;
        if (!aState && bState) return 1;
        return a.localeCompare(b);
    });

    const customAddHtml = showCustomAdd ? `
        <div class="browse-tag-filter-item browse-tag-custom-add" data-custom-tag="${esc(filterLower)}">
            <button class="browse-tag-state-btn state-include"><i class="fa-solid fa-plus"></i></button>
            <span class="tag-label">Add <strong>${esc(filterLower)}</strong> as filter</span>
        </div>
    ` : '';

    container.innerHTML = customAddHtml + sortedTags.map(tag => {
        const state = masqueradeTagFilters.get(tag) || 'neutral';
        const stateClass = `state-${state}`;
        const stateIcon = state === 'include' ? '<i class="fa-solid fa-check"></i>'
            : state === 'exclude' ? '<i class="fa-solid fa-minus"></i>'
                : '';
        const stateTitle = state === 'include' ? 'Included - click to exclude'
            : state === 'exclude' ? 'Excluded - click to clear'
                : 'Neutral - click to include';

        return `
            <div class="browse-tag-filter-item" data-tag="${esc(tag)}">
                <button class="browse-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label">${esc(tag)}</span>
            </div>
        `;
    }).join('');

    container.querySelector?.('.browse-tag-custom-add')?.addEventListener('click', () => {
        if (!masqueradeTagFilters.has(filterLower)) {
            masqueradeTagFilters.set(filterLower, 'include');
            const searchInput = document.getElementById('masqueradeTagsSearchInput');
            if (searchInput) searchInput.value = '';
            updateMasqueradeTagsButtonState();
            renderMasqueradeTagsList('');
            triggerMasqueradeReloadDebounced();
        }
    });

    container.querySelectorAll?.('.browse-tag-filter-item[data-tag]').forEach(item => {
        const tag = item.dataset.tag;
        const cycleState = () => {
            const current = masqueradeTagFilters.get(tag) || 'neutral';
            if (current === 'neutral') {
                masqueradeTagFilters.set(tag, 'include');
            } else if (current === 'include') {
                masqueradeTagFilters.set(tag, 'exclude');
            } else {
                masqueradeTagFilters.delete(tag);
            }
            updateMasqueradeTagsButtonState();
            renderMasqueradeTagsList(document.getElementById('masqueradeTagsSearchInput')?.value || '');
            triggerMasqueradeReloadDebounced();
        };

        item.querySelector?.('.browse-tag-state-btn')?.addEventListener('click', event => {
            event.stopPropagation();
            cycleState();
        });
        item.querySelector?.('.tag-label')?.addEventListener('click', cycleState);
    });
}

function initMasqueradeTagsDropdown() {
    const btn = document.getElementById('masqueradeTagsBtn');
    const dropdown = document.getElementById('masqueradeTagsDropdown');
    const searchInput = document.getElementById('masqueradeTagsSearchInput');
    const clearBtn = document.getElementById('masqueradeTagsClearBtn');
    if (!btn || !dropdown) return;

    btn.addEventListener('click', event => {
        event.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns?.();
        document.getElementById('masqueradeFiltersDropdown')?.classList.add('hidden');
        const wasHidden = dropdown.classList.contains('hidden');
        dropdown.classList.toggle('hidden');
        if (wasHidden) {
            renderMasqueradeTagsList(searchInput?.value || '');
            if (!window.matchMedia?.('(max-width: 768px)').matches) searchInput?.focus();
        }
    });

    dropdown.addEventListener('click', event => event.stopPropagation());

    const renderDebounced = debounce ? debounce(() => {
        renderMasqueradeTagsList(searchInput?.value || '');
    }, 150) : () => renderMasqueradeTagsList(searchInput?.value || '');
    searchInput?.addEventListener('input', renderDebounced);

    searchInput?.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const value = normalizeTagName(searchInput.value);
        if (!value) return;
        if (!masqueradeTagFilters.has(value)) masqueradeTagFilters.set(value, 'include');
        searchInput.value = '';
        updateMasqueradeTagsButtonState();
        renderMasqueradeTagsList('');
        triggerMasqueradeReloadDebounced();
    });

    clearBtn?.addEventListener('click', () => {
        masqueradeTagFilters.clear();
        if (searchInput) searchInput.value = '';
        updateMasqueradeTagsButtonState();
        renderMasqueradeTagsList('');
        resetAndLoad();
    });
}

class MasqueradeBrowseView extends BrowseView {
    constructor(provider) {
        super(provider);
        view = this;
    }

    _extractProviderIds(char, idSet) {
        const ext = char.data?.extensions?.masquerade;
        if (ext?.id) idSet.add(ext.id);
    }

    get previewModalId() { return 'masqueradeCharModal'; }
    _getImageGridIds() { return ['masqueradeGrid']; }
    getSearchInputId() { return 'masqueradeSearchInput'; }

    get mobileFilterIds() {
        return {
            sort: 'masqueradeSortSelect',
            tags: 'masqueradeTagsBtn',
            filters: 'masqueradeFiltersBtn',
            nsfw: 'masqueradeNsfwToggle',
            refresh: 'refreshMasqueradeBtn',
            modeBrowseSelector: '.masquerade-view-btn[data-masquerade-view="browse"]',
            modeFollowSelector: '.masquerade-view-btn[data-masquerade-view="following"]',
            modeBtnClass: 'masquerade-view-btn',
        };
    }

    get hasModeToggle() { return false; }

    getSettingsConfig() {
        return {
            browseSortOptions: Object.entries(MASQUERADE_SORT_OPTIONS).map(([value, config]) => ({
                value,
                label: config.label,
            })),
            followingSortOptions: [],
            viewModes: [],
        };
    }

    canLoadMore() {
        return masqueradeHasMore && !masqueradeIsLoading;
    }

    loadMore() {
        masqueradeCurrentPage++;
        loadMasqueradeCharacters(true);
    }

    renderFilterBar() {
        return `
            <div class="chub-view-toggle">
                <button class="masquerade-view-btn active" data-masquerade-view="browse" title="Browse all characters">
                    <i class="fa-solid fa-compass"></i> <span>Browse</span>
                </button>
                <button class="masquerade-view-btn" data-masquerade-view="following" title="MasqueradeAI following sync is not implemented yet">
                    <i class="fa-solid fa-users"></i> <span>Following</span>
                </button>
            </div>

            <div class="browse-sort-container">
                <select id="masqueradeSortSelect" class="glass-select" title="Sort characters">
                    <option value="popular" selected>&#128293; Popular</option>
                    <option value="new">&#127381; New</option>
                    <option value="amplified">&#9889; Amplified</option>
                    <option value="shuffle">&#127922; Shuffle</option>
                </select>
            </div>

            <div class="browse-tags-dropdown-container" style="position: relative;">
                <button id="masqueradeTagsBtn" class="glass-btn" title="Filter by tag">
                    <i class="fa-solid fa-tags"></i> <span id="masqueradeTagsBtnLabel">Tags</span>
                </button>
                <div id="masqueradeTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="masqueradeTagsSearchInput" placeholder="Type a tag name..." autocomplete="one-time-code">
                        <button id="masqueradeTagsClearBtn" class="glass-btn icon-only" title="Clear tag filter">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="masqueradeTagsList"></div>
                </div>
            </div>

            <div class="browse-more-filters" style="position: relative;">
                <button id="masqueradeFiltersBtn" class="glass-btn" title="Filter options">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="masqueradeFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden" style="width: 240px;">
                    <div class="dropdown-section-title">Character must have:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="masqueradeFilterGallery"> <i class="fa-solid fa-images"></i> Extra Images</label>
                    <label class="filter-checkbox"><input type="checkbox" id="masqueradeFilterGreetings"> <i class="fa-solid fa-comments"></i> Alt Greetings</label>
                    <label class="filter-checkbox"><input type="checkbox" id="masqueradeFilterAmplified"> <i class="fa-solid fa-bolt"></i> Amplified</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Library:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="masqueradeFilterHideOwned"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                    <label class="filter-checkbox"><input type="checkbox" id="masqueradeFilterHidePossible"> <i class="fa-solid fa-check" style="color: #f0a500;"></i> Hide Possible Matches</label>
                </div>
            </div>

            <button id="masqueradeNsfwToggle" class="glass-btn nsfw-toggle" style="opacity: 0.5;" title="Toggle Going Feral (NSFW) content">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>
            <button id="refreshMasqueradeBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    renderView() {
        return `
            <div id="masqueradeBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="masqueradeSearchInput" placeholder="Search MasqueradeAI characters..." autocomplete="one-time-code">
                        <button id="masqueradeClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="masqueradeSearchBtn" class="browse-search-submit" title="Search">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                </div>
                <div id="masqueradeGrid" class="browse-grid"></div>
                <div id="masqueradeLoadMore" class="browse-load-more" style="display:none;">
                    <button id="masqueradeLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    renderModals() {
        return `
            <div id="masqueradeCharModal" class="modal-overlay hidden">
                <div class="modal-glass browse-char-modal">
                    <div class="modal-header">
                        <div class="browse-char-header-info">
                            <img id="masqueradeCharAvatar" class="browse-char-avatar" src="/img/ai4.png" alt="">
                            <div>
                                <h2 id="masqueradeCharName">Character Name</h2>
                                <p class="browse-char-meta">
                                    by <span id="masqueradeCharCreator">Unknown</span>
                                </p>
                            </div>
                        </div>
                        <div class="modal-controls">
                            <a id="masqueradeOpenInBrowserBtn" class="action-btn secondary" href="#" target="_blank" rel="noopener" title="Open on MasqueradeAI">
                                <i class="fa-solid fa-external-link"></i> Open
                            </a>
                            <button id="masqueradeImportBtn" class="action-btn primary" title="Import to SillyTavern">
                                <i class="fa-solid fa-download"></i> Import
                            </button>
                            <button class="close-btn" id="masqueradeCharClose">&times;</button>
                        </div>
                    </div>
                    <div class="browse-char-body">
                        <div class="browse-char-tagline" id="masqueradeCharTaglineSection" style="display: none;">
                            <i class="fa-solid fa-quote-left"></i>
                            <div id="masqueradeCharTagline" class="browse-tagline-text"></div>
                        </div>
                        <div class="browse-char-meta-grid">
                            <div class="browse-char-stats">
                                <div class="browse-stat">
                                    <i class="fa-solid fa-message"></i>
                                    <span id="masqueradeCharMessages">0</span> messages
                                </div>
                                <div class="browse-stat">
                                    <i class="fa-solid fa-users"></i>
                                    <span id="masqueradeCharUsers">0</span> users
                                </div>
                                <div class="browse-stat">
                                    <i class="fa-solid fa-heart"></i>
                                    <span id="masqueradeCharFans">0</span> fans
                                </div>
                                <div class="browse-stat">
                                    <i class="fa-solid fa-calendar"></i>
                                    <span id="masqueradeCharDate">Unknown</span>
                                </div>
                                <div class="browse-stat" id="masqueradeCharGreetingsStat" style="display: none;">
                                    <i class="fa-solid fa-comment-dots"></i>
                                    <span id="masqueradeCharGreetingsCount">0</span> greetings
                                </div>
                                <div class="browse-stat" id="masqueradeCharGalleryStat" style="display: none;">
                                    <i class="fa-solid fa-images"></i>
                                    <span id="masqueradeCharGalleryCount">0</span> gallery
                                </div>
                            </div>
                            <div id="masqueradeCharTags" class="browse-char-tags"></div>
                        </div>
                        <div class="browse-char-section" id="masqueradeCharDescriptionSection" style="display: none;">
                            <h3 class="browse-section-title" data-section="masqueradeCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                                <i class="fa-solid fa-scroll"></i> Description
                            </h3>
                            <div id="masqueradeCharDescription" class="scrolling-text"></div>
                        </div>
                        <div class="browse-char-section" id="masqueradeCharPersonalitySection" style="display: none;">
                            <h3 class="browse-section-title" data-section="masqueradeCharPersonality" data-label="Personality" data-icon="fa-solid fa-brain" title="Click to expand">
                                <i class="fa-solid fa-brain"></i> Personality
                            </h3>
                            <div id="masqueradeCharPersonality" class="scrolling-text"></div>
                        </div>
                        <div class="browse-char-section" id="masqueradeCharScenarioSection" style="display: none;">
                            <h3 class="browse-section-title" data-section="masqueradeCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                                <i class="fa-solid fa-theater-masks"></i> Scenario
                            </h3>
                            <div id="masqueradeCharScenario" class="scrolling-text"></div>
                        </div>
                        <div class="browse-char-section" id="masqueradeCharFirstMsgSection" style="display: none;">
                            <h3 class="browse-section-title" data-section="masqueradeCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                                <i class="fa-solid fa-message"></i> First Message
                            </h3>
                            <div id="masqueradeCharFirstMsg" class="scrolling-text first-message-preview"></div>
                        </div>
                        <div class="browse-char-section" id="masqueradeCharAltGreetingsSection" style="display: none;">
                            <h3 class="browse-section-title" data-section="masqueradeCharAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                                <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="masqueradeCharAltGreetingsCount"></span>
                            </h3>
                            <div id="masqueradeCharAltGreetings" class="browse-alt-greetings-list"></div>
                        </div>
                        <div class="browse-char-section" id="masqueradeCharGallerySection" style="display: none;">
                            <h3 class="browse-section-title" data-section="masqueradeCharGalleryGrid" data-label="Gallery" data-icon="fa-solid fa-images" title="Click to expand">
                                <i class="fa-solid fa-images"></i> Gallery <span class="browse-section-count" id="masqueradeCharGalleryLabel"></span>
                            </h3>
                            <div id="masqueradeCharGalleryGrid" class="browse-gallery-grid"></div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    init() {
        super.init();
        if (typeof document === 'undefined') return;

        const sortEl = document.getElementById('masqueradeSortSelect');
        if (sortEl) {
            sortEl.value = masqueradeCurrentSort;
            CoreAPI.initCustomSelect?.(sortEl);
        }

        if (typeof document.addEventListener === 'function') {
            this._registerDropdownDismiss([
                { dropdownId: 'masqueradeTagsDropdown', buttonId: 'masqueradeTagsBtn' },
                { dropdownId: 'masqueradeFiltersDropdown', buttonId: 'masqueradeFiltersBtn' },
            ]);
        }

        document.querySelectorAll?.('.masquerade-view-btn')?.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.masqueradeView;
                if (mode === 'browse') {
                    document.querySelectorAll?.('.masquerade-view-btn')?.forEach(button => {
                        button.classList.toggle('active', button.dataset.masqueradeView === 'browse');
                    });
                    return;
                }
                showToast?.('MasqueradeAI following sync needs account/plugin support before it can be enabled.', 'info');
                document.querySelector?.('.masquerade-view-btn[data-masquerade-view="browse"]')?.classList.add('active');
                btn.classList.remove('active');
            });
        });

        bind('masqueradeSearchBtn', 'click', () => {
            masqueradeCurrentSearch = document.getElementById('masqueradeSearchInput')?.value?.trim() || '';
            resetAndLoad();
        });
        bind('masqueradeClearSearchBtn', 'click', () => {
            const input = document.getElementById('masqueradeSearchInput');
            if (input) input.value = '';
            masqueradeCurrentSearch = '';
            updateSearchClearButton();
            resetAndLoad();
        });
        bind('masqueradeSearchInput', 'keydown', event => {
            if (event.key === 'Enter') {
                masqueradeCurrentSearch = event.currentTarget.value.trim();
                resetAndLoad();
            }
        });
        bind('masqueradeSearchInput', 'input', updateSearchClearButton);
        bind('masqueradeSortSelect', 'change', event => {
            masqueradeCurrentSort = event.currentTarget.value || 'popular';
            resetAndLoad();
        });
        bind('masqueradeFiltersBtn', 'click', event => {
            event.stopPropagation();
            CoreAPI.closeAllTopbarDropdowns?.();
            document.getElementById('masqueradeTagsDropdown')?.classList.add('hidden');
            document.getElementById('masqueradeFiltersDropdown')?.classList.toggle('hidden');
        });
        document.getElementById('masqueradeFiltersDropdown')?.addEventListener('click', event => event.stopPropagation());
        bind('masqueradeFilterGallery', 'change', event => {
            masqueradeFilterHasGallery = event.currentTarget.checked;
            updateMasqueradeFiltersButtonState();
            resetAndLoad();
        });
        bind('masqueradeFilterGreetings', 'change', event => {
            masqueradeFilterHasAltGreetings = event.currentTarget.checked;
            updateMasqueradeFiltersButtonState();
            resetAndLoad();
        });
        bind('masqueradeFilterAmplified', 'change', event => {
            masqueradeFilterAmplified = event.currentTarget.checked;
            updateMasqueradeFiltersButtonState();
            resetAndLoad();
        });
        bind('masqueradeFilterHideOwned', 'change', event => {
            masqueradeFilterHideOwned = event.currentTarget.checked;
            updateMasqueradeFiltersButtonState();
            resetAndLoad();
        });
        bind('masqueradeFilterHidePossible', 'change', event => {
            masqueradeFilterHidePossible = event.currentTarget.checked;
            updateMasqueradeFiltersButtonState();
            resetAndLoad();
        });
        initMasqueradeTagsDropdown();
        bind('masqueradeNsfwToggle', 'click', () => {
            masqueradeNsfwEnabled = !masqueradeNsfwEnabled;
            setSetting?.('masqueradeNsfw', masqueradeNsfwEnabled);
            updateMasqueradeNsfwToggle();
            resetAndLoad();
        });
        bind('refreshMasqueradeBtn', 'click', () => resetAndLoad());
        bind('masqueradeLoadMoreBtn', 'click', () => this.loadMore());

        const grid = document.getElementById('masqueradeGrid');
        grid?.addEventListener('click', async event => {
            const card = event.target.closest('[data-masquerade-id]');
            if (!card) return;
            const id = card.dataset.masqueradeId;
            let char = masqueradeCharacters.find(c => c.id === id);
            if (!char) return;
            openPreviewModal(char, { loading: true });
            try {
                const detail = await fetchMasqueradeMetadata(id);
                if (detail) char = detail;
            } catch { /* preview can use card data */ }
            if (String(masqueradeSelectedChar?.id || '') !== String(id)) return;
            openPreviewModal(char);
        });

        bindPersistentModalListeners();
    }

    applyDefaults(defaults) {
        const sort = defaults?.sort === 'newest' ? 'new' : defaults?.sort;
        if (sort && MASQUERADE_SORT_OPTIONS[sort]) {
            masqueradeCurrentSort = sort;
            const select = document.getElementById('masqueradeSortSelect');
            if (select) select.value = sort;
        }
    }

    async activate(container, options = {}) {
        if (options.domRecreated) {
            masqueradeCurrentSearch = '';
            masqueradeCharacters = [];
            masqueradeCurrentPage = 1;
            masqueradeHasMore = true;
            masqueradeIsLoading = false;
            masqueradeGridRenderedCount = 0;
            masqueradeTagFilters = new Map();
            masqueradeFilterHideOwned = false;
            masqueradeFilterHidePossible = false;
            masqueradeFilterHasGallery = false;
            masqueradeFilterHasAltGreetings = false;
            masqueradeFilterAmplified = false;
            masqueradeCurrentSort = 'popular';
            masqueradeSelectedChar = null;
        }
        masqueradeNsfwEnabled = getSetting?.('masqueradeNsfw') === true;
        super.activate(container, options);
        updateMasqueradeNsfwToggle();
        updateSearchClearButton();
        updateMasqueradeTagsButtonState();
        updateMasqueradeFiltersButtonState();
        this.buildLocalLibraryLookup();
        if (options.domRecreated || masqueradeCharacters.length === 0) {
            await resetAndLoad();
        } else {
            renderGrid(masqueradeCharacters, false);
        }
    }

    deactivate() {
        masqueradeLoadToken++;
        super.deactivate();
    }
}

const masqueradeBrowseView = new MasqueradeBrowseView();

if (typeof window !== 'undefined') {
    window.openMasqueradeCharPreview = function(char) {
        openPreviewModal(char);
    };
}

export default masqueradeBrowseView;
