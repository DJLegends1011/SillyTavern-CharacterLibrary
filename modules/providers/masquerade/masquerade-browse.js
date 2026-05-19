// MasqueradeBrowseView - public browse/search UI for MasqueradeAI.

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber } from '../provider-utils.js';
import {
    MASQUERADE_SORT_OPTIONS,
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
    if (formatRichText) return formatRichText(String(value), name, false);
    return esc(value).replace(/\n/g, '<br>');
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

function createMasqueradeCard(char) {
    const id = char.id || char.character_id || '';
    const name = char.name || 'Unknown';
    const tagline = char.tagline || char.personality || '';
    const avatarUrl = getAvatarUrl(char);
    const tags = (char.tags || []).slice(0, 4);
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
                ${tagline ? `<div class="browse-card-description">${esc(tagline)}</div>` : ''}
                <div class="browse-card-tags">
                    ${tags.map(tag => `<span class="browse-card-tag" title="${esc(tag)}">${esc(tag)}</span>`).join('')}
                </div>
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Messages"><i class="fa-solid fa-comments"></i> ${formatNumber(char.total_messages || 0)}</span>
                <span class="browse-card-stat" title="Saved"><i class="fa-solid fa-bookmark"></i> ${formatNumber(char.subscriber_count || 0)}</span>
                <span class="browse-card-stat" title="Quality"><i class="fa-solid fa-star"></i> ${formatNumber(char.quality_score || 0)}</span>
                ${createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${esc(createdDate)}</span>` : ''}
            </div>
        </div>
    `;
}

function renderGrid(characters, append = false) {
    const grid = document.getElementById('masqueradeGrid');
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
        masqueradeGridRenderedCount = 0;
    }

    const start = masqueradeGridRenderedCount;
    const html = characters.slice(start).map(createMasqueradeCard).join('');
    grid.insertAdjacentHTML('beforeend', html);
    masqueradeGridRenderedCount = characters.length;
    masqueradeBrowseView.observeImages(grid);
    masqueradeBrowseView.updateLoadMoreVisibility('masqueradeLoadMore', masqueradeHasMore, masqueradeCharacters.length > 0);
}

function renderEmpty(message, icon = 'fa-search') {
    const grid = document.getElementById('masqueradeGrid');
    if (!grid) return;
    grid.innerHTML = `
        <div class="masquerade-empty" style="grid-column: 1 / -1;">
            <i class="fa-solid ${icon}"></i>
            <p>${esc(message)}</p>
        </div>
    `;
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
        const opts = {
            query: masqueradeCurrentSearch,
            page: masqueradeCurrentPage,
            limit: PAGE_SIZE,
            sort: masqueradeCurrentSort,
            nsfw: masqueradeNsfwEnabled,
            excludeTags: getProviderExcludeTags?.('masquerade') || [],
        };
        const results = masqueradeCurrentSearch
            ? await searchMasqueradeCharacters(opts)
            : await browseMasqueradeCharacters(opts);

        if (token !== masqueradeLoadToken) return;

        if (append) {
            const seen = new Set(masqueradeCharacters.map(c => c.id));
            masqueradeCharacters = masqueradeCharacters.concat(results.filter(c => !seen.has(c.id)));
        } else {
            masqueradeCharacters = results;
        }

        masqueradeHasMore = !masqueradeCurrentSearch && results.length >= PAGE_SIZE;
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

function openPreviewModal(char) {
    masqueradeSelectedChar = char;
    const modal = document.getElementById('masqueradeCharModal');
    if (!modal) return;

    const name = char.name || 'Unknown';
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
    const setHtml = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = value || '';
    };

    setText('masqueradeCharName', name);
    setText('masqueradeCharTagline', getSetting?.('showMasqueradeTagline') === false ? '' : char.tagline || '');
    setText('masqueradeCharMessages', formatNumber(char.total_messages || 0));
    setText('masqueradeCharSaved', formatNumber(char.subscriber_count || 0));
    setText('masqueradeCharQuality', formatNumber(char.quality_score || 0));
    setHtml('masqueradeCharDescription', richText(char.description || char.scenario || '', name));
    setHtml('masqueradeCharGreeting', richText(char.greeting || '', name));
    setHtml('masqueradeCharScenario', char.scenario && char.scenario !== char.description ? richText(char.scenario, name) : '');

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
    masqueradeSelectedChar = null;
    hideModal?.('masqueradeCharModal');
}

async function importSelectedCharacter() {
    const charData = masqueradeSelectedChar;
    if (!charData?.id) return;

    const importBtn = document.getElementById('masqueradeImportBtn');
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
                if (importBtn) {
                    importBtn.disabled = false;
                    importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
                }
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

        closePreviewModal();
        if (typeof requestAnimationFrame === 'function') await new Promise(resolve => requestAnimationFrame(resolve));

        showToast?.(`Imported "${result.characterName}"`, 'success');

        const mediaUrls = result.embeddedMediaUrls || [];
        const galleryPageUrls = result.galleryPageUrls || [];
        if ((mediaUrls.length > 0 || galleryPageUrls.length > 0) && getSetting?.('notifyAdditionalContent') !== false) {
            showImportSummaryModal?.({
                mediaCharacters: [{
                    name: result.characterName,
                    avatar: result.fileName,
                    avatarUrl: result.avatarUrl,
                    mediaUrls,
                    galleryPageUrls,
                    galleryId: result.galleryId,
                    cardData: result.cardData,
                }],
            });
        }

        const added = await fetchAndAddCharacter?.(result.fileName);
        if (!added) await fetchCharacters?.(true);
        view.buildLocalLibraryLookup();
        markCardAsImported(charData.id);
    } catch (error) {
        console.error('[MasqueradeBrowse] Import failed:', error);
        showToast?.(`Import failed: ${error.message}`, 'error');
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
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

    getSettingsConfig() {
        return {
            browseSortOptions: Object.entries(MASQUERADE_SORT_OPTIONS).map(([value, config]) => ({
                value,
                label: config.label,
            })),
        };
    }

    canLoadMore() {
        return masqueradeHasMore && !masqueradeIsLoading && !masqueradeCurrentSearch;
    }

    loadMore() {
        masqueradeCurrentPage++;
        loadMasqueradeCharacters(true);
    }

    renderFilterBar() {
        return `
            <div class="browse-sort-container">
                <select id="masqueradeSortSelect" class="glass-select" title="Sort characters">
                    <option value="popular" selected>Popular</option>
                    <option value="newest">Newest</option>
                    <option value="quality">Quality</option>
                    <option value="subscribers">Most Saved</option>
                    <option value="chatters">Most Chatters</option>
                </select>
            </div>
            <label class="filter-checkbox masquerade-nsfw-toggle" title="Show NSFW content">
                <input type="checkbox" id="masqueradeNsfwToggle">
                <i class="fa-solid fa-eye-slash"></i> NSFW
            </label>
            <button id="refreshMasqueradeBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-rotate"></i>
            </button>
        `;
    }

    renderView() {
        return `
            <div class="masquerade-provider-root">
                <div class="masquerade-search-row">
                    <div class="masquerade-search-input-wrap">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="masqueradeSearchInput" placeholder="Search MasqueradeAI..." autocomplete="one-time-code">
                    </div>
                    <button id="masqueradeSearchBtn" class="glass-btn">
                        <i class="fa-solid fa-search"></i><span>Search</span>
                    </button>
                    <button id="masqueradeClearSearchBtn" class="glass-btn icon-only" title="Clear search">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
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
            <div id="masqueradeCharModal" class="modal hidden browse-char-modal">
                <div class="modal-content browse-char-content">
                    <button id="masqueradeCharClose" class="modal-close" title="Close">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                    <div class="browse-char-header">
                        <img id="masqueradeCharAvatar" class="browse-char-avatar" src="/img/ai4.png" alt="">
                        <div class="browse-char-title">
                            <h2 id="masqueradeCharName"></h2>
                            <p id="masqueradeCharTagline" class="browse-char-tagline"></p>
                            <div id="masqueradeCharTags" class="browse-tags"></div>
                        </div>
                    </div>
                    <div class="browse-char-body">
                        <div class="browse-meta-grid">
                            <div><i class="fa-solid fa-comments"></i><span id="masqueradeCharMessages">0</span><small>Messages</small></div>
                            <div><i class="fa-solid fa-bookmark"></i><span id="masqueradeCharSaved">0</span><small>Saved</small></div>
                            <div><i class="fa-solid fa-star"></i><span id="masqueradeCharQuality">0</span><small>Quality</small></div>
                        </div>
                        <section class="browse-section">
                            <h3>Description</h3>
                            <div id="masqueradeCharDescription" class="browse-rich-text"></div>
                        </section>
                        <section class="browse-section">
                            <h3>First Message</h3>
                            <div id="masqueradeCharGreeting" class="browse-rich-text"></div>
                        </section>
                        <section class="browse-section">
                            <h3>Scenario</h3>
                            <div id="masqueradeCharScenario" class="browse-rich-text"></div>
                        </section>
                    </div>
                    <div class="browse-char-actions">
                        <a id="masqueradeOpenInBrowserBtn" class="glass-btn" href="#" target="_blank" rel="noopener">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> Open
                        </a>
                        <button id="masqueradeImportBtn" class="glass-btn primary">
                            <i class="fa-solid fa-download"></i> Import
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    init() {
        super.init();
        if (typeof document === 'undefined') return;

        bind('masqueradeSearchBtn', 'click', () => {
            masqueradeCurrentSearch = document.getElementById('masqueradeSearchInput')?.value?.trim() || '';
            resetAndLoad();
        });
        bind('masqueradeClearSearchBtn', 'click', () => {
            const input = document.getElementById('masqueradeSearchInput');
            if (input) input.value = '';
            masqueradeCurrentSearch = '';
            resetAndLoad();
        });
        bind('masqueradeSearchInput', 'keydown', event => {
            if (event.key === 'Enter') {
                masqueradeCurrentSearch = event.currentTarget.value.trim();
                resetAndLoad();
            }
        });
        if (debounce) {
            const debouncedSearch = debounce(() => {
                const value = document.getElementById('masqueradeSearchInput')?.value?.trim() || '';
                if (value === masqueradeCurrentSearch) return;
                masqueradeCurrentSearch = value;
                resetAndLoad();
            }, 450);
            bind('masqueradeSearchInput', 'input', debouncedSearch);
        }
        bind('masqueradeSortSelect', 'change', event => {
            masqueradeCurrentSort = event.currentTarget.value || 'popular';
            resetAndLoad();
        });
        bind('masqueradeNsfwToggle', 'change', event => {
            masqueradeNsfwEnabled = !!event.currentTarget.checked;
            setSetting?.('masqueradeNsfw', masqueradeNsfwEnabled);
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
            try {
                const detail = await fetchMasqueradeMetadata(id);
                if (detail) char = detail;
            } catch { /* preview can use card data */ }
            openPreviewModal(char);
        });

        bindPersistentModalListeners();
    }

    applyDefaults(defaults) {
        if (defaults?.sort && MASQUERADE_SORT_OPTIONS[defaults.sort]) {
            masqueradeCurrentSort = defaults.sort;
            const select = document.getElementById('masqueradeSortSelect');
            if (select) select.value = defaults.sort;
        }
    }

    async activate(container, options = {}) {
        masqueradeNsfwEnabled = getSetting?.('masqueradeNsfw') === true;
        super.activate(container, options);
        const nsfwToggle = document.getElementById('masqueradeNsfwToggle');
        if (nsfwToggle) nsfwToggle.checked = masqueradeNsfwEnabled;
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
