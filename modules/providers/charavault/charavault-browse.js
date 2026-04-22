// CharaVaultBrowseView — CharaVault browse/search UI for the Online tab

import { BrowseView } from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber } from '../provider-utils.js';
import {
    searchCards,
    fetchCardDetail,
    fetchTopTags,
    getAvatarUrl,
    getCardPngUrl,
    getCharacterPageUrl,
    stripHtml,
    parseTags,
    checkCvPluginAvailable,
    checkCvSession,
    cvLogin,
    cvValidateSession,
    cvLogout,
    isCvSessionActive,
    getCvSessionEmail,
} from './charavault-api.js';

const {
    onElement: on,
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
    apiRequest,
    cleanupCreatorNotesContainer,
    getProviderExcludeTags,
} = CoreAPI;

// ========================================
// CONSTANTS
// ========================================



const BROWSE_PURIFY_CONFIG = {
    ALLOWED_TAGS: [
        'p', 'br', 'hr', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre',
        'ul', 'ol', 'li', 'a', 'img', 'center', 'font', 'style',
        'table', 'thead', 'tbody', 'tr', 'th', 'td', 'details', 'summary'
    ],
    ALLOWED_ATTR: [
        'href', 'src', 'alt', 'title', 'class', 'style', 'target', 'rel',
        'width', 'height', 'loading', 'color', 'size', 'align'
    ],
    ALLOW_DATA_ATTR: false
};

// ========================================
// STATE
// ========================================

let cvCharacters = [];
let cvCurrentOffset = 0;
let cvPageSize = 60;
let cvTotal = 0;
let cvHasMore = true;
let cvIsLoading = false;
let cvCurrentSearch = '';
let cvCurrentCreator = '';
let cvNsfwEnabled = false;
let cvSortMode = 'most_downloaded';
let cvSelectedChar = null;
let cvGridRenderedCount = 0;
let cvLoadToken = 0; // Generation counter for search requests

// Auth state
let cvPluginAvailable = false;
let cvLoginInProgress = false;

// Filter state
let cvFilterHideOwned = false;
let cvFilterHidePossible = false;
let cvFilterHasBook = false;

// Tag filter state
/** @type {Set<string>} Active include tags */
let cvIncludeTags = new Set();
/** @type {Set<string>} Active exclude tags */
let cvExcludeTags = new Set();

// Cached top tags from API
let cvTopTags = [];
let cvTopTagsFetched = false;

let view; // module-scoped BrowseView instance reference (set once in constructor)

// ========================================
// LOCAL LIBRARY LOOKUP
// ========================================

function isCharInLocalLibrary(hit) {
    const fullPath = hit.fullPath || (hit.folder && hit.file ? `${hit.folder}/${hit.file}` : '');
    if (fullPath && view._lookup.byProviderId.has(fullPath)) return true;

    const name = (hit.name || '').toLowerCase().trim();
    const creator = (hit.creator || hit.folder || '').toLowerCase().trim();
    if (name && creator && view._lookup.byNameAndCreator.has(`${name}|${creator}`)) return true;

    return false;
}

function isCharPossibleMatchObj(h) {
    if (isCharInLocalLibrary(h)) return false;
    return view.isCharPossibleMatch(h.name || '', h.creator || h.folder || '');
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

function createCvCard(hit) {
    const name = hit.name || hit.file || 'Unknown';
    const desc = stripHtml(hit.tagline || '');
    const fullPath = hit.fullPath || (hit.folder && hit.file ? `${hit.folder}/${hit.file}` : '');
    const avatarUrl = hit.folder && hit.file ? getAvatarUrl(hit.folder, hit.file) : '/img/ai4.png';
    const tags = parseTags(hit.tags).slice(0, 3);
    const tokens = formatNumber(hit.token_count || 0);
    const author = hit.creator || hit.folder || '';
    const inLibrary = isCharInLocalLibrary(hit);
    const possibleMatch = !inLibrary && view.isCharPossibleMatch(hit.name || '', author);

    const badges = [];
    if (inLibrary) {
        badges.push('<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>');
    } else if (possibleMatch) {
        badges.push('<span class="browse-feature-badge possible-library" title="Possible Match in Library"><i class="fa-solid fa-check"></i></span>');
    }
    if (hit.has_book) {
        badges.push('<span class="browse-feature-badge" title="Has Lorebook"><i class="fa-solid fa-book"></i></span>');
    }

    const createdDate = hit.updated_at || hit.created_at;
    const dateStr = createdDate ? new Date(createdDate).toLocaleDateString() : '';
    const dateInfo = dateStr ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${dateStr}</span>` : '';

    const cardClass = inLibrary ? 'browse-card in-library' : possibleMatch ? 'browse-card possible-library' : 'browse-card';
    const rawPngUrl = hit.folder && hit.file ? getCardPngUrl(hit.folder, hit.file) : '/img/ai4.png';

    return `
        <div class="${cardClass}" data-cv-path="${escapeHtml(fullPath)}" ${desc ? `title="${escapeHtml(desc)}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" data-avatar="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="if(!this.dataset.retried){this.dataset.retried='1'; setTimeout(()=>this.src=this.dataset.avatar, 2000);} else if(!this.dataset.failed){this.dataset.failed='1';this.src='/img/ai4.png';}">
                ${hit.nsfw ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}
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
                <span class="browse-card-stat" title="Downloads"><i class="fa-solid fa-download"></i> ${formatNumber(hit.downloads || 0)}</span>
                <span class="browse-card-stat" title="Rating"><i class="fa-solid fa-star"></i> ${(hit.rating || 0).toFixed(1)}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}

function observeNewCards(startIdx) {
    const grid = document.getElementById('cvGrid');
    if (!grid) return;
    charavaultBrowseView.observeImages(grid);
}

// ========================================
// GRID RENDERING
// ========================================

function renderGrid(characters, append = false) {
    const grid = document.getElementById('cvGrid');
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
        cvGridRenderedCount = 0;
    }

    const startIdx = cvGridRenderedCount;
    const html = characters.slice(startIdx).map(c => createCvCard(c)).join('');
    grid.insertAdjacentHTML('beforeend', html);
    cvGridRenderedCount = characters.length;

    observeNewCards(startIdx);
    updateLoadMore();
}

function updateLoadMore() {
    charavaultBrowseView.updateLoadMoreVisibility('cvLoadMore', cvHasMore, cvCharacters.length > 0);
}

// ========================================
// HIT NORMALIZATION
// ========================================

function normalizeSearchResponse(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.cards)) return data.cards;
    if (Array.isArray(data.results)) return data.results;
    if (Array.isArray(data.data)) return data.data;
    return [];
}

function normalizeCvHit(hit) {
    const folder = hit.folder || hit.creator || (hit.full_path || hit.fullPath || '').split('/')[0] || '';
    const file = hit.file || hit.slug || (hit.full_path || hit.fullPath || '').split('/')[1] || '';
    const fullPath = folder && file ? `${folder}/${file}` : (hit.full_path || hit.fullPath || '');
    return {
        ...hit,
        folder,
        file,
        fullPath,
        name: hit.name || file || 'Unnamed',
        creator: hit.creator || hit.author || folder || '',
        tagline: hit.tagline || hit.description || '',
        tags: parseTags(hit.tags),
        token_count: hit.token_count ?? hit.tokenCount ?? 0,
        has_book: !!(hit.has_book ?? hit.hasBook),
        nsfw: !!hit.nsfw,
        downloads: hit.downloads ?? hit.download_count ?? 0,
        rating: hit.rating ?? hit.average_rating ?? 0,
        updated_at: hit.updated_at || hit.updatedAt || null,
        created_at: hit.created_at || hit.createdAt || null,
    };
}

// ========================================
// SEARCH / LOAD
// ========================================

async function loadCharacters(append = false) {
    if (append && cvIsLoading) return;

    // Concurrency control: prevent stale responses from overwriting newer ones
    const thisToken = ++cvLoadToken;
    cvIsLoading = true;

    const grid = document.getElementById('cvGrid');
    const loadMoreBtn = document.getElementById('cvLoadMoreBtn');

    if (!append && grid) {
        grid.innerHTML = `
            <div class="browse-loading-overlay" style="grid-column: 1 / -1; padding: 40px; text-align: center;">
                <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; color: var(--accent);"></i>
                <p style="margin-top: 12px; color: var(--text-muted);">Searching CharaVault...</p>
            </div>
        `;
    }

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        const opts = {
            q: cvCurrentSearch,
            creator: cvCurrentCreator,
            sort: cvSortMode,
            offset: append ? cvCurrentOffset : 0,
            limit: cvPageSize,
            nsfw: cvNsfwEnabled,
            hasBook: cvFilterHasBook,
        };

        if (cvIncludeTags.size > 0) opts.tags = [...cvIncludeTags].join(',');

        const data = await searchCards(opts, apiRequest);

        // Stale response check
        if (thisToken !== cvLoadToken) return;

        // Provider was deactivated during the fetch
        if (!delegatesInitialized) return;

        let hits = normalizeSearchResponse(data);
        cvTotal = data?.total ?? data?.count ?? (hits.length + (append ? cvCharacters.length : 0));
        hits = hits.map(normalizeCvHit);

        // Client-side: hide owned / possible match characters
        if (cvFilterHideOwned) {
            hits = hits.filter(h => !isCharInLocalLibrary(h));
        }
        if (cvFilterHidePossible) {
            hits = hits.filter(h => !isCharPossibleMatchObj(h));
        }

        // Apply provider-level exclude tags (local filter — CV API has no exclude_tags)
        const localExcludes = new Set([
            ...cvExcludeTags,
            ...getProviderExcludeTags('charavault'),
        ]);
        if (localExcludes.size > 0) {
            hits = hits.filter(h => {
                const tags = parseTags(h.tags).map(t => t.toLowerCase());
                for (const ex of localExcludes) {
                    if (tags.includes(ex.toLowerCase())) return false;
                }
                return true;
            });
        }

        const totalReturned = Array.isArray(data?.cards) ? data.cards.length
            : Array.isArray(data?.results) ? data.results.length
            : Array.isArray(data) ? data.length : hits.length;

        if (append) {
            const existingPaths = new Set(cvCharacters.map(c => c.fullPath));
            cvCharacters = cvCharacters.concat(hits.filter(h => h.fullPath && !existingPaths.has(h.fullPath)));
        } else {
            cvCharacters = hits;
        }

        cvCurrentOffset = (append ? cvCurrentOffset : 0) + totalReturned;
        cvHasMore = totalReturned >= cvPageSize && (cvTotal === 0 || cvCurrentOffset < cvTotal);

        renderGrid(cvCharacters, append);

        if (!append && cvCharacters.length === 0) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid fa-search" style="font-size: 2rem; opacity: 0.5;"></i>
                    <p style="margin-top: 12px;">No characters found</p>
                </div>
            `;
        }

        debugLog('[CVBrowse] Loaded', hits.length, 'characters, offset', cvCurrentOffset, 'total', cvTotal);

    } catch (err) {
        if (thisToken !== cvLoadToken) return;

        console.error('[CVBrowse] Search error:', err);
        showToast(`CharaVault search failed: ${err.message}`, 'error');
        if (!append && grid) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">
                    <i class="fa-solid fa-exclamation-triangle" style="font-size: 2rem; color: #e74c3c;"></i>
                    <p style="margin-top: 12px;">Search failed: ${escapeHtml(err.message)}</p>
                    <button class="glass-btn" style="margin-top: 12px;" id="cvRetryBtn">
                        <i class="fa-solid fa-redo"></i> Retry
                    </button>
                </div>
            `;
            const retryBtn = document.getElementById('cvRetryBtn');
            if (retryBtn) retryBtn.addEventListener('click', () => loadCharacters(false));
        }
    } finally {
        if (thisToken === cvLoadToken) {
            cvIsLoading = false;
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

let cvDetailFetchToken = 0;

function openPreviewModal(hit) {
    cvSelectedChar = hit;

    const modal = document.getElementById('cvCharModal');
    if (!modal) return;

    const name = hit.name || hit.file || 'Unknown';
    const author = hit.creator || hit.folder || 'Unknown';
    const folder = hit.folder || '';
    const file = hit.file || '';
    const avatarUrl = folder && file ? getAvatarUrl(folder, file) : '/img/ai4.png';
    const rawPngUrl = folder && file ? getCardPngUrl(folder, file) : '/img/ai4.png';
    const cvUrl = folder && file ? getCharacterPageUrl(folder, file) : '#';
    const inLibrary = isCharInLocalLibrary(hit);
    const possibleMatch = !inLibrary && view.isCharPossibleMatch(hit.name || '', author);

    let charDef = '';

    try {
        const tagline = stripHtml(hit.tagline || '');
        const creatorNotes = hit.creator_notes || hit.description || '';
        const tags = parseTags(hit.tags);
        const tokens = formatNumber(hit.token_count || 0);
        const downloads = formatNumber(hit.downloads || 0);
        const rating = (hit.rating || 0).toFixed(1);

        const rawCreated = hit.updated_at || hit.created_at;
        const createdDate = rawCreated ? new Date(rawCreated).toLocaleDateString() : '';

        // Header
        const avatarImg = document.getElementById('cvCharAvatar');
        if (avatarImg) {
            avatarImg.src = avatarUrl;
            avatarImg.dataset.fallback = rawPngUrl;
            avatarImg.onerror = () => {
                if (avatarImg.dataset.fallback && avatarImg.src !== avatarImg.dataset.fallback) {
                    avatarImg.src = avatarImg.dataset.fallback;
                } else {
                    avatarImg.src = '/img/ai4.png';
                }
            };
            BrowseView.adjustPortraitPosition(avatarImg);
        }
        const nameEl = document.getElementById('cvCharName');
        if (nameEl) nameEl.textContent = name;
        const creatorEl = document.getElementById('cvCharCreator');
        if (creatorEl) {
            creatorEl.textContent = author;
            creatorEl.href = '#';
            creatorEl.title = `Click to see all characters by ${author}`;
            creatorEl.onclick = (e) => {
                e.preventDefault();
                filterByAuthor(author);
            };
        }
        const openBtn = document.getElementById('cvOpenInBrowserBtn');
        if (openBtn) openBtn.href = cvUrl;

        // Tagline (above meta grid, no section header — matches Chub pattern)
        const taglineSection = document.getElementById('cvCharTaglineSection');
        const taglineEl = document.getElementById('cvCharTagline');
        if (taglineSection) {
            if (tagline) {
                taglineSection.style.display = 'block';
                if (taglineEl) taglineEl.textContent = tagline;
            } else {
                taglineSection.style.display = 'none';
            }
        }

        // Stats
        const tokensEl = document.getElementById('cvCharTokens');
        if (tokensEl) tokensEl.textContent = tokens;
        const downloadsEl = document.getElementById('cvCharDownloads');
        if (downloadsEl) downloadsEl.textContent = downloads;
        const ratingEl = document.getElementById('cvCharRating');
        if (ratingEl) ratingEl.textContent = rating;
        const dateEl = document.getElementById('cvCharDate');
        if (dateEl) dateEl.textContent = createdDate || 'Unknown';

        // Greetings stat
        const greetingsStat = document.getElementById('cvCharGreetingsStat');
        const greetingsCount = document.getElementById('cvCharGreetingsCount');
        const altGreetings = Array.isArray(hit.alternate_greetings) ? hit.alternate_greetings.filter(Boolean) : [];
        if (greetingsStat) {
            if (altGreetings.length > 0) {
                greetingsStat.style.display = 'flex';
                if (greetingsCount) greetingsCount.textContent = String(altGreetings.length + 1);
            } else {
                greetingsStat.style.display = 'none';
            }
        }

        // Lorebook stat
        const lorebookStat = document.getElementById('cvCharLorebookStat');
        if (lorebookStat) {
            lorebookStat.style.display = hit.has_book ? 'flex' : 'none';
        }

        // Tags
        const tagsEl = document.getElementById('cvCharTags');
        if (tagsEl) {
            tagsEl.innerHTML = tags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
            requestAnimationFrame(() => applyTagsClamp(tagsEl));
        }

        // Creator's Notes (public listing description — always visible)
        const creatorNotesEl = document.getElementById('cvCharCreatorNotes');
        if (creatorNotesEl) {
            if (creatorNotes) {
                creatorNotesEl.innerHTML = formatRichText(creatorNotes, name, false);
            } else {
                creatorNotesEl.textContent = 'No description available.';
            }
        }

        // Description (character definition)
        const descSection = document.getElementById('cvCharDescriptionSection');
        const descEl = document.getElementById('cvCharDescription');
        charDef = hit.description || '';
        if (descSection) {
            if (charDef) {
                descSection.style.display = 'block';
                if (descEl) descEl.innerHTML = formatRichText(charDef, name, false);
            } else {
                descSection.style.display = 'block';
                if (descEl) descEl.innerHTML = '<div style="color: var(--text-secondary, #888); padding: 8px 0;"><i class="fa-solid fa-spinner fa-spin"></i> Loading character definition...</div>';
            }
        }

        const scenarioSection = document.getElementById('cvCharScenarioSection');
        const scenarioEl = document.getElementById('cvCharScenario');
        const scenario = hit.scenario || '';
        if (scenarioSection) {
            if (scenario) {
                scenarioSection.style.display = 'block';
                if (scenarioEl) scenarioEl.innerHTML = formatRichText(scenario, name, false);
            } else {
                scenarioSection.style.display = 'none';
            }
        }

        const firstMsgSection = document.getElementById('cvCharFirstMsgSection');
        const firstMsgEl = document.getElementById('cvCharFirstMsg');
        const firstMsg = hit.first_mes || hit.first_message || '';
        if (firstMsgSection) {
            if (firstMsg) {
                firstMsgSection.style.display = 'block';
                if (firstMsgEl) firstMsgEl.innerHTML = formatRichText(firstMsg, name, false);
            } else {
                firstMsgSection.style.display = 'none';
            }
        }

        // Alternate Greetings — collapsible details with lazy rendering (matches Chub pattern)
        const altGreetingsSection = document.getElementById('cvCharAltGreetingsSection');
        const altGreetingsEl = document.getElementById('cvCharAltGreetings');
        const altGreetingsCountEl = document.getElementById('cvCharAltGreetingsCount');
        if (altGreetingsSection) {
            if (altGreetings.length > 0) {
                altGreetingsSection.style.display = 'block';
                if (altGreetingsCountEl) altGreetingsCountEl.textContent = `(${altGreetings.length})`;
                window.currentBrowseAltGreetings = altGreetings;
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
                                    body.innerHTML = DOMPurify.sanitize(formatRichText(altGreetings[idx], name, true), BROWSE_PURIFY_CONFIG);
                                }
                                body.dataset.rendered = '1';
                            }
                        }, { once: true });
                    });
                }
            } else {
                altGreetingsSection.style.display = 'none';
                window.currentBrowseAltGreetings = [];
            }
        }

        // Example Dialogs
        const examplesSection = document.getElementById('cvCharExamplesSection');
        const examplesEl = document.getElementById('cvCharExamples');
        const examples = hit.mes_example || hit.example_messages || '';
        if (examplesSection) {
            if (examples) {
                examplesSection.style.display = 'block';
                if (examplesEl) examplesEl.innerHTML = formatRichText(examples, name, false);
            } else {
                examplesSection.style.display = 'none';
            }
        }

        // Import button state
        const importBtn = document.getElementById('cvImportBtn');
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
        console.error('[CVBrowse] Error populating preview modal:', err);
    }

    modal.classList.remove('hidden');
    const charBody = modal.querySelector('.browse-char-body');
    if (charBody) charBody.scrollTop = 0;

    // If no definition was available in the search hit, fetch full details
    if (!charDef) {
        const fetchToken = ++cvDetailFetchToken;
        fetchAndPopulateDetails(hit, fetchToken);
    }
}

async function fetchAndPopulateDetails(hit, token) {
    const folder = hit.folder;
    const file = hit.file;
    if (!folder || !file) return;
    const name = hit.name || file || 'Unknown';

    try {
        const card = await fetchCardDetail(folder, file, apiRequest);
        if (token !== cvDetailFetchToken) return;

        if (!card) {
            const descEl = document.getElementById('cvCharDescription');
            if (descEl) descEl.innerHTML = '<em style="color: var(--text-secondary, #888)">Could not load character definition. The character can still be imported with basic info.</em>';
            return;
        }

        // Store full data on the selected char for import
        if (cvSelectedChar?.fullPath === hit.fullPath) {
            cvSelectedChar._fullDetail = card;
            // Backfill commonly-missing fields on the hit so import can use them
            cvSelectedChar.has_book = !!(card.has_book ?? cvSelectedChar.has_book);
            cvSelectedChar.tagline = card.tagline || cvSelectedChar.tagline;
        }

        // Creator's Notes
        const creatorNotesEl = document.getElementById('cvCharCreatorNotes');
        const detailNotes = card.creator_notes || card.description || '';
        if (detailNotes && creatorNotesEl) {
            creatorNotesEl.innerHTML = formatRichText(detailNotes, name, false);
        }

        const descSection = document.getElementById('cvCharDescriptionSection');
        const descEl = document.getElementById('cvCharDescription');
        const charDef = card.description || '';
        if (descSection) {
            if (charDef) {
                descSection.style.display = 'block';
                if (descEl) descEl.innerHTML = formatRichText(charDef, name, false);
            } else {
                descSection.style.display = 'none';
            }
        }

        const scenarioSection = document.getElementById('cvCharScenarioSection');
        const scenarioEl = document.getElementById('cvCharScenario');
        const scenario = card.scenario || '';
        if (scenarioSection && scenario) {
            scenarioSection.style.display = 'block';
            if (scenarioEl) scenarioEl.innerHTML = formatRichText(scenario, name, false);
        }

        const firstMsgSection = document.getElementById('cvCharFirstMsgSection');
        const firstMsgEl = document.getElementById('cvCharFirstMsg');
        const firstMsg = card.first_mes || card.first_message || '';
        if (firstMsgSection && firstMsg) {
            firstMsgSection.style.display = 'block';
            if (firstMsgEl) firstMsgEl.innerHTML = formatRichText(firstMsg, name, false);
        }

        const examplesSection = document.getElementById('cvCharExamplesSection');
        const examplesEl = document.getElementById('cvCharExamples');
        const examples = card.mes_example || card.example_messages || '';
        if (examplesSection && examples) {
            examplesSection.style.display = 'block';
            if (examplesEl) examplesEl.innerHTML = formatRichText(examples, name, false);
        }

        // Alternate greetings (detail API returns them even when search hit did not)
        const detailAlts = Array.isArray(card.alternate_greetings) ? card.alternate_greetings.filter(Boolean) : [];
        if (detailAlts.length > 0) {
            const altsSection = document.getElementById('cvCharAltGreetingsSection');
            const altsCountEl = document.getElementById('cvCharAltGreetingsCount');
            const greetingsStat = document.getElementById('cvCharGreetingsStat');
            const greetingsCount = document.getElementById('cvCharGreetingsCount');
            if (altsSection) altsSection.style.display = 'block';
            if (altsCountEl) altsCountEl.textContent = `(${detailAlts.length})`;
            if (greetingsStat) greetingsStat.style.display = 'flex';
            if (greetingsCount) greetingsCount.textContent = String(detailAlts.length + 1);
            window.currentBrowseAltGreetings = detailAlts;
        }

        // Lorebook stat
        const lorebookStat = document.getElementById('cvCharLorebookStat');
        if (lorebookStat && card.has_book) {
            lorebookStat.style.display = 'flex';
        }
    } catch (err) {
        debugLog('[CVBrowse] Detail fetch error:', err);
        if (token === cvDetailFetchToken) {
            const descEl = document.getElementById('cvCharDescription');
            if (descEl) descEl.innerHTML = '<em style="color: var(--text-secondary, #888)">Could not load character definition. The character can still be imported with basic info.</em>';
        }
    }
}

function cleanupCvCharModal() {
    BrowseView.closeAvatarViewer();
    window.currentBrowseAltGreetings = null;
    const sectionIds = [
        'cvCharDescription',
        'cvCharScenario',
        'cvCharFirstMsg',
        'cvCharExamples',
        'cvCharAltGreetings',
        'cvCharTags',
    ];
    for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    const notesEl = document.getElementById('cvCharCreatorNotes');
    if (notesEl) cleanupCreatorNotesContainer(notesEl);
}

function closePreviewModal() {
    cvDetailFetchToken++;
    cleanupCvCharModal();
    const modal = document.getElementById('cvCharModal');
    if (modal) modal.classList.add('hidden');
    cvSelectedChar = null;
}

// ========================================
// IMPORT
// ========================================

async function importCharacter(charData) {
    if (!charData?.fullPath) return;

    const importBtn = document.getElementById('cvImportBtn');
    if (importBtn) {
        importBtn.disabled = true;
        importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
    }

    let inheritedGalleryId = null;

    try {
        const provider = CoreAPI.getProvider('charavault');
        if (!provider?.importCharacter) throw new Error('CharaVault provider not available');

        const charName = charData.name || charData.file || '';
        const charCreator = charData.creator || charData.folder || '';
        const detail = charData._fullDetail || {};

        // === PRE-IMPORT DUPLICATE CHECK ===
        const duplicateMatches = await checkCharacterForDuplicatesAsync({
            name: charName,
            creator: charCreator,
            fullPath: charData.fullPath,
            description: detail.description || charData.description || '',
            first_mes: detail.first_mes || detail.first_message || charData.first_mes || '',
            personality: detail.personality || charData.personality || '',
            scenario: detail.scenario || charData.scenario || '',
        });

        if (duplicateMatches && duplicateMatches.length > 0) {
            if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-exclamation-triangle"></i> Duplicate found...';

            const avatarUrl = charData.folder && charData.file ? getAvatarUrl(charData.folder, charData.file) : '';
            const result = await showPreImportDuplicateWarning({
                name: charName,
                creator: charCreator,
                fullPath: charData.fullPath,
                avatarUrl,
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
                    console.warn('[CVBrowse] Could not delete existing character, proceeding with import anyway');
                }
            }
        }
        // === END DUPLICATE CHECK ===

        if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing...';

        const result = await provider.importCharacter(charData.fullPath, charData, { inheritedGalleryId });
        if (!result.success) throw new Error(result.error || 'Import failed');

        closePreviewModal();
        await new Promise(r => requestAnimationFrame(r));

        showToast(`Imported "${result.characterName}"`, 'success');

        // Show import summary if character has embedded media
        const mediaUrls = result.embeddedMediaUrls || [];
        if (mediaUrls.length > 0 && getSetting('notifyAdditionalContent') !== false) {
            showImportSummaryModal({
                mediaCharacters: [{
                    name: result.characterName,
                    avatar: result.fileName,
                    avatarUrl: result.avatarUrl,
                    mediaUrls: mediaUrls,
                    galleryId: result.galleryId
                }]
            });
        }

        // Lightweight single-character add (avoids OOM from full list reload on mobile)
        const added = await fetchAndAddCharacter(result.fileName);
        if (!added) await fetchCharacters(true);
        view.buildLocalLibraryLookup();
        markCardAsImported(charData.fullPath);

    } catch (err) {
        console.error('[CVBrowse] Import failed:', err);
        showToast(`Import failed: ${err.message}`, 'error');
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
        }
    }
}

function markCardAsImported(fullPath) {
    const grid = document.getElementById('cvGrid');
    if (!grid) return;
    const card = grid.querySelector(`[data-cv-path="${fullPath}"]`);
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

async function loadTopTags() {
    if (cvTopTagsFetched) return;
    try {
        const raw = await fetchTopTags(apiRequest);
        cvTopTags = (Array.isArray(raw) ? raw : []).map(t => {
            if (Array.isArray(t) && t.length >= 2) return { tag: String(t[0]), count: Number(t[1]) || 0 };
            if (typeof t === 'string') return { tag: t, count: 0 };
            return { tag: t.tag || t.name || String(t), count: t.count ?? t.total ?? 0 };
        }).filter(t => t.tag);
        cvTopTagsFetched = true;
    } catch (e) {
        console.warn('[CVBrowse] Failed to fetch top tags:', e.message);
        cvTopTags = [];
        cvTopTagsFetched = true;
    }
}

function renderTagsList(filter = '') {
    const container = document.getElementById('cvTagsList');
    if (!container) return;

    if (!cvTopTagsFetched) {
        container.innerHTML = '<div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>';
        return;
    }

    const filtered = filter
        ? cvTopTags.filter(t => t.tag.toLowerCase().includes(filter.toLowerCase()))
        : cvTopTags;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    container.innerHTML = filtered.map(({ tag, count }) => {
        const isIncluded = cvIncludeTags.has(tag);
        const isExcluded = cvExcludeTags.has(tag);
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
            if (cvIncludeTags.has(tagName)) {
                cvIncludeTags.delete(tagName);
                cvExcludeTags.add(tagName);
            } else if (cvExcludeTags.has(tagName)) {
                cvExcludeTags.delete(tagName);
            } else {
                cvIncludeTags.add(tagName);
            }
            cycleTagState(stateBtn, tagName);
            updateCvTagsButton();
            cvCurrentOffset = 0;
            loadCharacters(false);
        });
    });
}

function cycleTagState(btn, tagName) {
    btn.className = 'browse-tag-state-btn';
    if (cvIncludeTags.has(tagName)) {
        btn.classList.add('state-include');
        btn.innerHTML = '<i class="fa-solid fa-plus"></i>';
        btn.title = 'Included — click to exclude';
    } else if (cvExcludeTags.has(tagName)) {
        btn.classList.add('state-exclude');
        btn.innerHTML = '<i class="fa-solid fa-minus"></i>';
        btn.title = 'Excluded — click to clear';
    } else {
        btn.classList.add('state-neutral');
        btn.innerHTML = '';
        btn.title = 'Click to include';
    }
}

function updateCvTagsButton() {
    const btn = document.getElementById('cvTagsBtn');
    const label = document.getElementById('cvTagsBtnLabel');
    if (!btn) return;

    const count = cvIncludeTags.size + cvExcludeTags.size;
    if (count > 0) {
        btn.classList.add('has-filters');
        if (label) label.innerHTML = `Tags <span class="tag-count">(${count})</span>`;
    } else {
        btn.classList.remove('has-filters');
        if (label) label.textContent = 'Tags';
    }
}

function updateCvFiltersButton() {
    const btn = document.getElementById('cvFiltersBtn');
    if (!btn) return;

    const active = cvFilterHideOwned || cvFilterHidePossible || cvFilterHasBook;
    btn.classList.toggle('has-filters', active);
}

function updateHasBookToggle() {
    const btn = document.getElementById('cvHasBookToggle');
    if (!btn) return;
    btn.classList.toggle('active', cvFilterHasBook);
    btn.title = cvFilterHasBook
        ? 'Only showing cards with a lorebook — click to clear'
        : 'Click to show only cards with a lorebook';
}

// ========================================
// EVENT WIRING
// ========================================

let delegatesInitialized = false;
let modalEventsAttached = false;
function initCvView() {
    if (delegatesInitialized) return;
    delegatesInitialized = true;

    // Convert native selects to styled custom dropdowns
    const sortEl = document.getElementById('cvSortSelect');
    if (sortEl) CoreAPI.initCustomSelect?.(sortEl);

    // Grid card click → open preview (delegation)
    const grid = document.getElementById('cvGrid');
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
            const fullPath = card.dataset.cvPath;
            if (!fullPath) return;
            const hit = cvCharacters.find(c => c.fullPath === fullPath);
            if (hit) openPreviewModal(hit);
        });
    }

    // Search
    on('cvSearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch();
        }
    });
    on('cvSearchInput', 'input', (e) => {
        const clearBtn = document.getElementById('cvClearSearchBtn');
        if (clearBtn) clearBtn.classList.toggle('hidden', !e.target.value.trim());
    });
    on('cvSearchBtn', 'click', () => doSearch());
    on('cvClearSearchBtn', 'click', () => {
        const input = document.getElementById('cvSearchInput');
        const clearBtn = document.getElementById('cvClearSearchBtn');
        if (input) input.value = '';
        if (clearBtn) clearBtn.classList.add('hidden');
        cvCurrentSearch = '';
        cvCurrentOffset = 0;
        // Also clear author banner if visible
        const authorBanner = document.getElementById('cvAuthorBanner');
        if (authorBanner) authorBanner.classList.add('hidden');
        loadCharacters(false);
    });
    on('cvClearAuthorBtn', 'click', () => clearCvAuthorFilter());

    // Load More
    on('cvLoadMoreBtn', 'click', () => {
        cvCurrentOffset += cvPageSize;
        loadCharacters(true);
    });

    // NSFW toggle — no login required on CV (just includes NSFW in results)
    on('cvNsfwToggle', 'click', () => {
        cvNsfwEnabled = !cvNsfwEnabled;
        setSetting('charavaultNsfw', cvNsfwEnabled);
        updateNsfwToggle();
        cvCurrentOffset = 0;
        loadCharacters(false);
    });
    updateNsfwToggle();

    // Has-book toggle
    on('cvHasBookToggle', 'click', () => {
        cvFilterHasBook = !cvFilterHasBook;
        setSetting('charavaultHasBook', cvFilterHasBook);
        updateHasBookToggle();
        cvCurrentOffset = 0;
        loadCharacters(false);
    });
    updateHasBookToggle();

    // Sort mode
    on('cvSortSelect', 'change', () => {
        const el = document.getElementById('cvSortSelect');
        if (el) cvSortMode = el.value;
        cvCurrentOffset = 0;
        loadCharacters(false);
    });

    // Refresh
    on('cvRefreshBtn', 'click', () => {
        cvCurrentOffset = 0;
        loadCharacters(false);
    });

    // ── Tags dropdown ──
    const tagsDropdown = document.getElementById('cvTagsDropdown');

    on('cvTagsBtn', 'click', async (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        if (filtersDropdown) filtersDropdown.classList.add('hidden');
        if (tagsDropdown) tagsDropdown.classList.toggle('hidden');
        // Lazy-load tags on first open
        if (!cvTopTagsFetched) {
            await loadTopTags();
            renderTagsList();
        }
    });

    if (tagsDropdown) tagsDropdown.addEventListener('click', (e) => e.stopPropagation());

    renderTagsList();

    const tagSearchInput = document.getElementById('cvTagsSearchInput');
    if (tagSearchInput) {
        const debouncedFilter = debounce((val) => renderTagsList(val), 200);
        tagSearchInput.addEventListener('input', () => debouncedFilter(tagSearchInput.value));
    }

    on('cvTagsClearBtn', 'click', () => {
        cvIncludeTags.clear();
        cvExcludeTags.clear();
        renderTagsList(document.getElementById('cvTagsSearchInput')?.value || '');
        updateCvTagsButton();
        cvCurrentOffset = 0;
        loadCharacters(false);
    });

    // ── Features dropdown ──
    const filtersDropdown = document.getElementById('cvFiltersDropdown');

    on('cvFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns();
        if (tagsDropdown) tagsDropdown.classList.add('hidden');
        if (filtersDropdown) filtersDropdown.classList.toggle('hidden');
    });

    if (filtersDropdown) filtersDropdown.addEventListener('click', (e) => e.stopPropagation());

    on('cvFilterHasBook', 'change', () => {
        const el = document.getElementById('cvFilterHasBook');
        if (el) cvFilterHasBook = el.checked;
        const toggleBtn = document.getElementById('cvHasBookToggle');
        if (toggleBtn) toggleBtn.classList.toggle('active', cvFilterHasBook);
        setSetting('charavaultHasBook', cvFilterHasBook);
        updateCvFiltersButton();
        cvCurrentOffset = 0;
        loadCharacters(false);
    });

    on('cvFilterHideOwned', 'change', () => {
        const el = document.getElementById('cvFilterHideOwned');
        if (el) cvFilterHideOwned = el.checked;
        updateCvFiltersButton();
        cvCurrentOffset = 0;
        loadCharacters(false);
    });

    on('cvFilterHidePossible', 'change', () => {
        const el = document.getElementById('cvFilterHidePossible');
        if (el) cvFilterHidePossible = el.checked;
        updateCvFiltersButton();
        cvCurrentOffset = 0;
        loadCharacters(false);
    });

    // Close dropdowns when clicking outside (uses .contains() — works after mobile relocation to body)
    charavaultBrowseView._registerDropdownDismiss([
        { dropdownId: 'cvTagsDropdown', buttonId: 'cvTagsBtn' },
        { dropdownId: 'cvFiltersDropdown', buttonId: 'cvFiltersBtn' },
    ]);

    // ── Preview modal events (attached once — modal DOM persists across provider switches) ──
    if (!modalEventsAttached) {
        modalEventsAttached = true;

        on('cvCharClose', 'click', () => closePreviewModal());

        // Avatar click → full-size image viewer (desktop only; mobile has its own handler)
        const cvAvatar = document.getElementById('cvCharAvatar');
        if (cvAvatar && !window.matchMedia('(max-width: 768px)').matches) {
            cvAvatar.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!cvAvatar.src || cvAvatar.src.endsWith('/img/ai4.png')) return;
                // Strip CDN resize params to get original full-size PNG
                const fullSrc = cvAvatar.src.replace(/\/cdn-cgi\/image\/[^/]+\//, '/');
                BrowseView.openAvatarViewer(fullSrc, cvAvatar.src);
            });
        }

        on('cvImportBtn', 'click', () => {
            if (cvSelectedChar) importCharacter(cvSelectedChar);
        });

        const modalOverlay = document.getElementById('cvCharModal');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) closePreviewModal();
            });
        }

        // ── Login modal events ──
        on('cvLoginClose', 'click', () => closeCvLoginModal());

        const submitLogin = () => {
            const email = document.getElementById('cvEmailInput')?.value?.trim();
            const pass = document.getElementById('cvAppPasswordInput')?.value;
            const remember = !!document.getElementById('cvRememberCredentials')?.checked;
            doCvLogin(email, pass, remember);
        };

        on('cvLoginBtn', 'click', submitLogin);
        on('cvLogoutBtn', 'click', () => cvLogoutAction());

        on('cvTogglePasswordVisibility', 'click', () => {
            const input = document.getElementById('cvAppPasswordInput');
            const icon = document.querySelector('#cvTogglePasswordVisibility i');
            if (!input) return;
            const hidden = input.type === 'password';
            input.type = hidden ? 'text' : 'password';
            if (icon) {
                icon.classList.toggle('fa-eye', !hidden);
                icon.classList.toggle('fa-eye-slash', hidden);
            }
        });

        // Enter key on login fields
        const loginOnEnter = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitLogin();
            }
        };
        on('cvEmailInput', 'keydown', loginOnEnter);
        on('cvAppPasswordInput', 'keydown', loginOnEnter);

        const loginOverlay = document.getElementById('cvLoginModal');
        if (loginOverlay) {
            loginOverlay.addEventListener('click', (e) => {
                if (e.target === loginOverlay) closeCvLoginModal();
            });
        }

        window.registerOverlay?.({ id: 'cvCharModal', tier: 7, close: () => closePreviewModal() });
        window.registerOverlay?.({ id: 'cvLoginModal', tier: 6, close: () => closeCvLoginModal() });
        window.registerOverlay?.({ id: 'cvAuthorBanner', tier: 9, close: () => clearCvAuthorFilter() });
    }
}

function doSearch() {
    const input = document.getElementById('cvSearchInput');
    const clearBtn = document.getElementById('cvClearSearchBtn');
    const val = (input?.value || '').trim();

    // Clear author banner if user typed a manual search
    const authorBanner = document.getElementById('cvAuthorBanner');
    if (authorBanner) authorBanner.classList.add('hidden');

    cvCurrentSearch = val;
    cvCurrentOffset = 0;

    if (clearBtn) {
        clearBtn.classList.toggle('hidden', !val);
    }

    loadCharacters(false);
}

function filterByAuthor(authorName) {
    cvCurrentSearch = authorName;
    cvCurrentOffset = 0;

    const input = document.getElementById('cvSearchInput');
    if (input) input.value = authorName;

    const clearBtn = document.getElementById('cvClearSearchBtn');
    if (clearBtn) clearBtn.classList.toggle('hidden', !authorName);

    const banner = document.getElementById('cvAuthorBanner');
    const bannerName = document.getElementById('cvAuthorBannerName');
    if (banner && bannerName) {
        bannerName.textContent = authorName;
        banner.classList.remove('hidden');
        window.pushOverlayGuard?.();
    }

    closePreviewModal();

    loadCharacters(false);
}

function clearCvAuthorFilter() {
    const banner = document.getElementById('cvAuthorBanner');
    if (banner) banner.classList.add('hidden');

    cvCurrentSearch = '';
    cvCurrentOffset = 0;

    const input = document.getElementById('cvSearchInput');
    if (input) input.value = '';
    const clearBtn = document.getElementById('cvClearSearchBtn');
    if (clearBtn) clearBtn.classList.add('hidden');

    loadCharacters(false);
}

function updateNsfwToggle() {
    const btn = document.getElementById('cvNsfwToggle');
    if (!btn) return;

    if (cvNsfwEnabled) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa-solid fa-fire"></i> <span>NSFW On</span>';
        btn.title = 'NSFW content enabled — click to show SFW only';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>';
        btn.title = 'Showing SFW only — click to include NSFW';
    }
}

// ========================================
// AUTH — APP-PASSWORD SESSION VIA CL-HELPER
// ========================================

async function openCvLoginModal() {
    cvPluginAvailable = await checkCvPluginAvailable(apiRequest);
    await checkCvSession(apiRequest);
    updateCvLoginUI();

    // Pre-fill email/password fields from saved settings
    const sessionActive = isCvSessionActive();
    if (!sessionActive) {
        const emailInput = document.getElementById('cvEmailInput');
        const passInput = document.getElementById('cvAppPasswordInput');
        const rememberCb = document.getElementById('cvRememberCredentials');
        const remember = !!getSetting('charavaultRemember');
        if (rememberCb) rememberCb.checked = remember;
        if (emailInput) emailInput.value = getSetting('charavaultEmail') || '';
        if (passInput && remember) passInput.value = getSetting('charavaultAppPassword') || '';
    }

    const modal = document.getElementById('cvLoginModal');
    if (modal) modal.classList.remove('hidden');
}

function closeCvLoginModal() {
    const modal = document.getElementById('cvLoginModal');
    if (modal) modal.classList.add('hidden');
}

function updateCvLoginUI() {
    const pluginOk = document.getElementById('cvPluginStatusOk');
    const pluginMissing = document.getElementById('cvPluginStatusMissing');
    const loginForm = document.getElementById('cvLoginForm');
    const saveBtn = document.getElementById('cvLoginBtn');
    const sessionActive = isCvSessionActive();

    if (pluginOk) pluginOk.style.display = cvPluginAvailable ? '' : 'none';
    if (pluginMissing) pluginMissing.style.display = cvPluginAvailable ? 'none' : '';
    if (loginForm) loginForm.classList.toggle('cv-login-disabled', !cvPluginAvailable);
    if (saveBtn) saveBtn.disabled = !cvPluginAvailable || cvLoginInProgress;

    if (saveBtn) {
        saveBtn.innerHTML = cvLoginInProgress
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Signing in...'
            : '<i class="fa-solid fa-right-to-bracket"></i> Sign In';
    }

    // Session status
    const statusArea = document.getElementById('cvSessionStatus');
    if (statusArea) {
        if (sessionActive) {
            const email = getCvSessionEmail() || 'account';
            statusArea.innerHTML = `<i class="fa-solid fa-check-circle" style="color: #2ecc71;"></i> <strong>Signed in</strong> as ${escapeHtml(email)}`;
            statusArea.style.display = '';
        } else {
            statusArea.style.display = 'none';
        }
    }

    // Show/hide login fields vs logout
    const logoutBtn = document.getElementById('cvLogoutBtn');
    const loginFields = document.getElementById('cvLoginFields');
    if (logoutBtn) logoutBtn.style.display = sessionActive ? '' : 'none';
    if (saveBtn) saveBtn.style.display = sessionActive ? 'none' : '';
    if (loginFields) loginFields.style.display = sessionActive ? 'none' : '';
}

async function doCvLogin(email, appPassword, remember) {
    if (cvLoginInProgress) return;

    if (!email || !appPassword) {
        showToast('Enter both email and password', 'warning');
        return;
    }

    cvLoginInProgress = true;
    updateCvLoginUI();

    try {
        const result = await cvLogin(apiRequest, email, appPassword);
        if (!result.ok) {
            showToast(result.error || 'Login failed', 'error');
            return;
        }

        setSetting('charavaultEmail', email);
        setSetting('charavaultRemember', !!remember);
        setSetting('charavaultAppPassword', remember ? appPassword : null);

        if (result.warning) {
            showToast(result.warning, 'warning', 5000);
        }

        showToast(`Signed in to CharaVault as ${result.email || email}`, 'success');
        closeCvLoginModal();

        cvCurrentOffset = 0;
        loadCharacters(false);
    } catch (err) {
        console.error('[CVAuth] Login error:', err);
        showToast(`Login error: ${err.message}`, 'error');
    } finally {
        cvLoginInProgress = false;
        updateCvLoginUI();
    }
}

async function cvLogoutAction() {
    await cvLogout(apiRequest);

    // Only forget the password, keep email (user convenience)
    setSetting('charavaultAppPassword', null);

    const passInput = document.getElementById('cvAppPasswordInput');
    if (passInput) passInput.value = '';

    showToast('Signed out of CharaVault', 'info');
    updateCvLoginUI();

    cvCurrentOffset = 0;
    loadCharacters(false);
}

async function tryCheckSession() {
    cvPluginAvailable = await checkCvPluginAvailable(apiRequest);
    if (!cvPluginAvailable) return;

    const sessionActive = await checkCvSession(apiRequest);
    if (sessionActive) {
        // Validate the session still works
        const validation = await cvValidateSession(apiRequest);
        if (!validation.valid) {
            debugLog('[CVAuth] Session expired:', validation.reason);
            await cvLogout(apiRequest);
            return;
        }
        return;
    }

    // No active session — try silent re-login with saved credentials
    const remember = !!getSetting('charavaultRemember');
    if (!remember) return;
    const email = getSetting('charavaultEmail');
    const savedPass = getSetting('charavaultAppPassword');
    if (!email || !savedPass) return;

    try {
        const result = await cvLogin(apiRequest, email, savedPass);
        if (!result.ok) {
            debugLog('[CVAuth] Silent re-login failed:', result.error);
            setSetting('charavaultAppPassword', null);
        }
    } catch (err) {
        debugLog('[CVAuth] Silent re-login error:', err);
    }
}

// ========================================
// BROWSE VIEW CLASS
// ========================================

class CharaVaultBrowseView extends BrowseView {

    constructor(provider) {
        super(provider);
        view = this;
    }

    _extractProviderIds(char, idSet) {
        const cvData = char.data?.extensions?.charavault;
        if (cvData?.path) idSet.add(cvData.path);
    }

    get previewModalId() { return 'cvCharModal'; }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'most_downloaded', label: 'Most Downloaded' },
                { value: 'top_rated', label: 'Top Rated' },
                { value: 'newest', label: 'Newest' },
                { value: 'oldest', label: 'Oldest' },
                { value: 'name_asc', label: 'Name (A–Z)' },
                { value: 'name_desc', label: 'Name (Z–A)' },
                { value: 'token_count_asc', label: 'Tokens (Low–High)' },
                { value: 'token_count_desc', label: 'Tokens (High–Low)' },
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
            sort: 'cvSortSelect',
            tags: 'cvTagsBtn',
            filters: 'cvFiltersBtn',
            nsfw: 'cvNsfwToggle',
            refresh: 'cvRefreshBtn'
        };
    }

    // ── Filter Bar ──────────────────────────────────────────

    renderFilterBar() {
        return `
            <!-- Sort -->
            <div class="browse-sort-container">
                <select id="cvSortSelect" class="glass-select" title="Sort order">
                    <option value="most_downloaded" selected>⬇️ Most Downloaded</option>
                    <option value="top_rated">⭐ Top Rated</option>
                    <option value="newest">🆕 Newest</option>
                    <option value="oldest">🕐 Oldest</option>
                    <option value="name_asc">🔤 Name (A–Z)</option>
                    <option value="name_desc">🔡 Name (Z–A)</option>
                    <option value="token_count_asc">📏 Tokens ↑</option>
                    <option value="token_count_desc">📏 Tokens ↓</option>
                </select>
            </div>

            <!-- Tags -->
            <div class="browse-tags-dropdown-container" style="position: relative;">
                <button id="cvTagsBtn" class="glass-btn" title="Tag filters">
                    <i class="fa-solid fa-tags"></i> <span id="cvTagsBtnLabel">Tags</span>
                </button>
                <div id="cvTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="cvTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="cvTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="cvTagsList">
                        <div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>
                    </div>
                </div>
            </div>

            <!-- Feature Filters -->
            <div class="browse-more-filters" style="position: relative;">
                <button id="cvFiltersBtn" class="glass-btn" title="Additional filters">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="cvFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden" style="width: 240px;">
                    <div class="dropdown-section-title">Character must have:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="cvFilterHasBook"> <i class="fa-solid fa-book"></i> Lorebook</label>
                    <hr style="margin: 8px 0; border-color: var(--glass-border);">
                    <div class="dropdown-section-title">Library:</div>
                    <label class="filter-checkbox"><input type="checkbox" id="cvFilterHideOwned"> <i class="fa-solid fa-check"></i> Hide Owned Characters</label>
                    <label class="filter-checkbox"><input type="checkbox" id="cvFilterHidePossible"> <i class="fa-solid fa-check" style="color: #f0a500;"></i> Hide Possible Matches</label>
                </div>
            </div>

            <!-- Has Lorebook toggle -->
            <button id="cvHasBookToggle" class="glass-btn" title="Only show characters with a lorebook">
                <i class="fa-solid fa-book"></i> <span>Lorebook</span>
            </button>

            <!-- NSFW toggle -->
            <button id="cvNsfwToggle" class="glass-btn nsfw-toggle" title="Showing SFW only — click to include NSFW">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Refresh -->
            <button id="cvRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // ── Main View ───────────────────────────────────────────

    renderView() {
        return `
            <div id="cvBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="cvSearchInput" placeholder="Search CharaVault characters..." autocomplete="one-time-code">
                        <button id="cvClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="cvSearchBtn" class="browse-search-submit">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                </div>

                <div id="cvAuthorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <span>Searching for <strong id="cvAuthorBannerName">Author</strong> <span class="browse-author-banner-hint">(keyword search — may include unrelated results)</span></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <button id="cvClearAuthorBtn" class="glass-btn icon-only" title="Clear author filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="cvGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="cvLoadMore" style="display: none;">
                    <button id="cvLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // ── Modals ──────────────────────────────────────────────

    renderModals() {
        return this._renderLoginModal() + this._renderPreviewModal();
    }

    _renderLoginModal() {
        return `
    <div id="cvLoginModal" class="modal-overlay hidden">
        <div class="modal-glass chub-login-modal">
            <div class="modal-header">
                <h2><i class="fa-solid fa-vault"></i> CharaVault Sign In</h2>
                <button class="close-btn" id="cvLoginClose">&times;</button>
            </div>
            <div class="chub-login-body">
                <p class="chub-login-info">
                    <i class="fa-solid fa-check-circle" style="color: #2ecc71;"></i>
                    <strong>Browsing and downloading public characters works without signing in!</strong>
                </p>
                <p class="chub-login-info">
                    <i class="fa-solid fa-key" style="color: var(--accent);"></i>
                    <strong>Optional:</strong> Sign in for higher rate limits and private content.
                </p>

                <!-- Session status -->
                <div id="cvSessionStatus" class="pyg-auth-status" style="display:none;"></div>

                <!-- Login form (requires cl-helper plugin) -->
                <div class="pyg-login-section">
                    <div class="pyg-plugin-status">
                        <span id="cvPluginStatusOk" style="display:none;">
                            <i class="fa-solid fa-plug-circle-check" style="color: #2ecc71;"></i> cl-helper plugin detected
                        </span>
                        <span id="cvPluginStatusMissing" style="display:none;">
                            <i class="fa-solid fa-plug-circle-xmark" style="color: #e67e22;"></i>
                            cl-helper plugin not found — see <a href="https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary#cl-helper-plugin-not-detected" target="_blank" style="color: var(--accent);">setup instructions</a>
                        </span>
                    </div>

                    <div id="cvLoginForm" class="chub-login-form">
                        <div id="cvLoginFields">
                            <div class="form-group">
                                <label for="cvEmailInput">Email</label>
                                <input type="email" id="cvEmailInput" class="glass-input" autocomplete="email" placeholder="you@example.com">
                            </div>
                            <div class="form-group">
                                <label for="cvAppPasswordInput">Password</label>
                                <div class="cv-password-wrapper">
                                    <input type="password" id="cvAppPasswordInput" class="glass-input" autocomplete="current-password" placeholder="Your CharaVault password">
                                    <button type="button" id="cvTogglePasswordVisibility" class="cv-password-toggle" title="Show/hide password">
                                        <i class="fa-solid fa-eye"></i>
                                    </button>
                                </div>
                            </div>
                            <label class="filter-checkbox" style="margin-top: 8px;">
                                <input type="checkbox" id="cvRememberCredentials"> Remember credentials (stored locally)
                            </label>
                        </div>

                        <div class="chub-login-actions" style="margin-top: 12px;">
                            <button id="cvLoginBtn" class="action-btn primary">
                                <i class="fa-solid fa-right-to-bracket"></i> Sign In
                            </button>
                            <button id="cvLogoutBtn" class="action-btn danger" style="display:none;">
                                <i class="fa-solid fa-right-from-bracket"></i> Sign Out
                            </button>
                            <a href="https://charavault.net" target="_blank" class="action-btn secondary">
                                <i class="fa-solid fa-external-link"></i> CharaVault
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
    <div id="cvCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="cvCharAvatar" src="/img/ai4.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="cvCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="cvCharCreator" href="#" title="Click to see all characters by this author">Creator</a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="cvOpenInBrowserBtn" href="#" target="_blank" class="action-btn secondary" title="Open on CharaVault">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="cvImportBtn" class="action-btn primary" title="Download to SillyTavern">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="cvCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-tagline" id="cvCharTaglineSection" style="display: none;">
                    <i class="fa-solid fa-quote-left"></i>
                    <div id="cvCharTagline" class="browse-tagline-text"></div>
                </div>

                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-message"></i>
                            <span id="cvCharTokens">0</span> tokens
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-download"></i>
                            <span id="cvCharDownloads">0</span> downloads
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-heart"></i>
                            <span id="cvCharLikes">0</span> likes
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="cvCharDate">Unknown</span>
                        </div>
                        <div class="browse-stat" id="cvCharGreetingsStat" style="display: none;">
                            <i class="fa-solid fa-comment-dots"></i>
                            <span id="cvCharGreetingsCount">0</span> greetings
                        </div>
                        <div class="browse-stat" id="cvCharLorebookStat" style="display: none;">
                            <i class="fa-solid fa-book"></i>
                            Lorebook
                        </div>
                    </div>
                    <div class="browse-char-tags" id="cvCharTags"></div>
                </div>

                <!-- Creator's Notes -->
                <div class="browse-char-section">
                    <h3 class="browse-section-title" data-section="cvCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="cvCharCreatorNotes" class="scrolling-text">
                        No description available.
                    </div>
                </div>

                <!-- Description -->
                <div class="browse-char-section" id="cvCharDescriptionSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="cvCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="cvCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="cvCharScenarioSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="cvCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="cvCharScenario" class="scrolling-text"></div>
                </div>

                <!-- Example Dialogs -->
                <div class="browse-char-section browse-section-collapsed" id="cvCharExamplesSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="cvCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="cvCharExamples" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="cvCharFirstMsgSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="cvCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="cvCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <!-- Alternate Greetings -->
                <div class="browse-char-section" id="cvCharAltGreetingsSection" style="display: none;">
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="cvCharAltGreetingsCount"></span>
                    </h3>
                    <div id="cvCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // ── Lifecycle ───────────────────────────────────────────

    _getImageGridIds() {
        return ['cvGrid'];
    }

    canLoadMore() { return cvHasMore && !cvIsLoading; }

    loadMore() {
        cvCurrentOffset += cvPageSize;
        loadCharacters(true);
    }

    init() {
        super.init();
        this.buildLocalLibraryLookup();
        initCvView();
        const grid = document.getElementById('cvGrid');
        if (grid) this.observeImages(grid);
        // Check session silently — if logged in, update toggle and reload with NSFW
        tryCheckSession().then(() => loadCharacters(false));
    }

    applyDefaults(defaults) {
        if (defaults.sort) {
            cvSortMode = defaults.sort;
            const el = document.getElementById('cvSortSelect');
            if (el) el.value = defaults.sort;
        }
    }

    activate(container, options = {}) {
        if (options.domRecreated) {
            cvCurrentSearch = '';
            cvCharacters = [];
            cvCurrentOffset = 0;
            cvHasMore = true;
            cvIsLoading = false;
            cvGridRenderedCount = 0;
            cvFilterHideOwned = false;
            cvFilterHidePossible = false;
            cvFilterHasBook = false;
            cvIncludeTags = new Set();
            cvExcludeTags = new Set();
            cvSortMode = 'most_downloaded';
            cvNsfwEnabled = false;
            cvSelectedChar = null;
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
            const path = card.dataset.cvPath;
            const name = card.querySelector('.browse-card-name')?.textContent || '';
            const author = card.querySelector('.browse-card-creator-link')?.textContent || '';
            return isCharInLocalLibrary({ path, name, author });
        });
    }

    deactivate() {
        cvDetailFetchToken++;
        delegatesInitialized = false;
        super.deactivate();
        this.disconnectImageObserver();
    }
}

const charavaultBrowseView = new CharaVaultBrowseView(null);

// Expose for library.js to call from viewOnProvider (linked character preview)
window.openCvCharPreview = function(hit) {
    openPreviewModal(hit);
};

window.openCvLoginModal = function() {
    openCvLoginModal();
};

export default charavaultBrowseView;
