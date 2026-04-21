// CharaVault Provider — implementation for charavault.net character source
//
// Uses CharaVault's public REST API (with optional App Password auth via
// cl-helper). The card PNG at /cards/{folder}/{file}.card.png is served
// as a static file and is NOT rate-limited; it's the authoritative source
// for import. The JSON metadata endpoints ARE rate-limited and all flow
// through the token-bucket in charavault-api.js.

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng, fetchWithProxy } from '../provider-utils.js';
import charavaultBrowseView from './charavault-browse.js';
import {
    CV_SITE_BASE,
    initCvApi,
    searchCards,
    fetchCardDetail,
    fetchCardLorebooks,
    fetchLorebook,
    getAvatarUrl,
    getCardPngUrl,
    getCharacterPageUrl,
    parseCharacterUrl,
    splitFullPath,
    slugify,
    stripHtml,
    parseTags,
    buildCharacterCardFromCv,
    normalizeLorebookToV2,
    sha256Hex,
    isCvSessionActive,
    checkCvSession,
    checkCvPluginAvailable,
    cvLogin,
    cvLogout,
    cvValidateSession,
} from './charavault-api.js';

let api = null;

// ========================================
// PROVIDER CLASS
// ========================================

class CharaVaultProvider extends ProviderBase {
    // ── Identity ────────────────────────────────────────────

    get id() { return 'charavault'; }
    get name() { return 'CharaVault'; }
    get icon() { return 'fa-solid fa-vault'; }
    get iconUrl() { return `${CV_SITE_BASE}/favicon.ico`; }
    get browseView() { return charavaultBrowseView; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-download', label: 'Downloads' },
            stat2: { icon: 'fa-solid fa-star', label: 'Rating' },
            stat3: { icon: 'fa-solid fa-coins', label: 'Tokens' },
        };
    }

    // ── Lifecycle ───────────────────────────────────────────

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
        initCvApi({ getSetting: coreAPI.getSetting, debugLog: coreAPI.debugLog });
    }

    async activate(container, options = {}) {
        charavaultBrowseView.activate(container, options);
    }

    deactivate() {
        charavaultBrowseView.deactivate();
    }

    // ── View ────────────────────────────────────────────────

    get hasView() { return true; }

    renderFilterBar() { return charavaultBrowseView.renderFilterBar(); }
    renderView() { return charavaultBrowseView.renderView(); }
    renderModals() { return charavaultBrowseView.renderModals(); }

    // ── Character Linking ───────────────────────────────────

    getLinkInfo(char) {
        if (!char) return null;
        const extensions = char.data?.extensions || char.extensions;
        const cv = extensions?.charavault;
        if (!cv) return null;

        const fullPath = cv.fullPath || (cv.folder && cv.file ? `${cv.folder}/${cv.file}` : null);
        if (!fullPath) return null;

        return {
            providerId: 'charavault',
            id: fullPath,
            fullPath,
            linkedAt: cv.linkedAt || null,
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};

        if (linkInfo) {
            const parts = splitFullPath(linkInfo.fullPath);
            const existing = char.data.extensions.charavault || {};
            char.data.extensions.charavault = {
                ...existing,
                folder: parts?.folder || existing.folder || '',
                file: parts?.file || existing.file || '',
                fullPath: linkInfo.fullPath,
                linkedAt: linkInfo.linkedAt || new Date().toISOString(),
                _v: 1,
            };
        } else {
            delete char.data.extensions.charavault;
        }
    }

    getCharacterUrl(linkInfo) {
        const parts = splitFullPath(linkInfo?.fullPath);
        if (!parts) return null;
        return getCharacterPageUrl(parts.folder, parts.file);
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    // ── In-App Preview ───────────────────────────────────────

    get supportsInAppPreview() { return true; }

    async buildPreviewObject(char, linkInfo) {
        const parts = splitFullPath(linkInfo?.fullPath);
        if (!parts) return null;

        // Try to fetch live detail so the preview matches the browse grid hit shape
        try {
            const data = await fetchCardDetail(parts.folder, parts.file, api?.apiRequest);
            if (data) {
                return this._hitFromDetail(data, parts.folder, parts.file);
            }
        } catch (e) {
            api?.debugLog?.('[CharaVault] buildPreviewObject detail failed:', e.message);
        }

        // Fallback: synthesize a hit from local extension data
        const cv = char?.data?.extensions?.charavault || {};
        return {
            folder: parts.folder,
            file: parts.file,
            fullPath: linkInfo.fullPath,
            name: char?.name || parts.file,
            creator: parts.folder,
            tagline: cv.tagline || '',
            tags: char?.data?.tags || [],
            token_count: cv.tokenCount || 0,
            updated_at: cv.updatedAt || null,
            has_book: false,
            nsfw: false,
        };
    }

    openPreview(previewChar) {
        window.openCharavaultCharPreview?.(previewChar);
    }

    // ── Local Import Enrichment ──────────────────────────────

    async enrichLocalImport(cardData, _fileName) {
        const ext = cardData.data?.extensions?.charavault;
        if (ext?.fullPath) {
            const parts = splitFullPath(ext.fullPath);
            return {
                cardData,
                providerInfo: {
                    providerId: 'charavault',
                    charId: ext.fullPath,
                    fullPath: ext.fullPath,
                    hasGallery: false,
                    avatarUrl: parts ? getAvatarUrl(parts.folder, parts.file) : null,
                },
            };
        }
        return null;
    }

    // ── Link Stats ───────────────────────────────────────────

    async fetchLinkStats(linkInfo) {
        const parts = splitFullPath(linkInfo?.fullPath);
        if (!parts) return null;
        try {
            const card = await fetchCardDetail(parts.folder, parts.file, api?.apiRequest);
            if (!card) return null;
            return {
                stat1: card.downloads ?? card.download_count ?? null,
                stat2: card.rating ?? card.average_rating ?? null,
                stat3: card.token_count ?? card.tokenCount ?? null,
            };
        } catch (e) {
            api?.debugLog?.('[CharaVault] fetchLinkStats:', e.message);
            return null;
        }
    }

    // ── Remote Data (for update checks) ──────────────────────

    async fetchMetadata(fullPath) {
        const parts = splitFullPath(fullPath);
        if (!parts) return null;
        try {
            return await fetchCardDetail(parts.folder, parts.file, api?.apiRequest);
        } catch (e) {
            console.error('[CharaVault] fetchMetadata failed:', fullPath, e);
            return null;
        }
    }

    async fetchRemoteCard(linkInfo) {
        const parts = splitFullPath(linkInfo?.fullPath);
        if (!parts) return null;

        try {
            // Update-check flow: metadata-first. Only touch the PNG if the
            // timestamp changed (prevents unnecessary downloads under steady state).
            const meta = await fetchCardDetail(parts.folder, parts.file, api?.apiRequest);
            if (!meta) return null;

            // Always pull the PNG card for the authoritative comparison —
            // the static PNG download doesn't count against the rate limit.
            const pngUrl = getCardPngUrl(parts.folder, parts.file);
            const resp = await fetchWithProxy(pngUrl);
            const buffer = await resp.arrayBuffer();
            const cardData = api?.extractCharacterDataFromPng?.(buffer);
            if (!cardData?.data) return null;

            // Backfill CharaVault-only fields
            if (!cardData.data.extensions) cardData.data.extensions = {};
            cardData.data.extensions.charavault = {
                ...(cardData.data.extensions.charavault || {}),
                folder: parts.folder,
                file: parts.file,
                fullPath: linkInfo.fullPath,
                tagline: meta?.tagline || '',
                updatedAt: meta?.updated_at || meta?.updatedAt || null,
                tokenCount: meta?.token_count || meta?.tokenCount || 0,
                _v: 1,
            };
            if (meta?.has_book && !cardData.data.character_book) {
                try {
                    const books = await fetchCardLorebooks(parts.folder, parts.file, api?.apiRequest);
                    if (books.length > 0) {
                        const id = books[0]?.id || books[0]?.lorebook_id;
                        if (id) {
                            const rawBook = await fetchLorebook(id, api?.apiRequest);
                            const v2 = normalizeLorebookToV2(rawBook);
                            if (v2) cardData.data.character_book = v2;
                        }
                    }
                } catch (e) {
                    api?.debugLog?.('[CharaVault] Lorebook refetch failed:', e.message);
                }
            }

            cardData._listingName = this.getListingName(meta) || meta?.name || parts.file;
            return cardData;
        } catch (e) {
            console.error('[CharaVault] fetchRemoteCard failed:', linkInfo?.fullPath, e);
            return null;
        }
    }

    normalizeRemoteCard(rawData) {
        return buildCharacterCardFromCv(rawData);
    }

    // ── Update Checking ─────────────────────────────────────

    getComparableFields() {
        return [
            {
                path: 'extensions.charavault.tagline',
                label: 'CharaVault Tagline',
                icon: 'fa-solid fa-quote-left',
                optional: true,
                group: 'tagline',
                groupLabel: 'Tagline',
            },
        ];
    }

    // ── Version History ─────────────────────────────────────

    get supportsVersionHistory() { return false; }

    // ── Authentication ──────────────────────────────────────

    get hasAuth() { return true; }

    get isAuthenticated() { return isCvSessionActive(); }

    openAuthUI() {
        window.openCharavaultLoginModal?.();
    }

    getAuthHeaders() { return {}; }

    // ── URL Handling ────────────────────────────────────────

    canHandleUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            return /^(www\.)?charavault\.net$/i.test(u.hostname);
        } catch {
            return false;
        }
    }

    parseUrl(url) {
        const parsed = parseCharacterUrl(url);
        return parsed?.fullPath || null;
    }

    // ── Bulk Linking ────────────────────────────────────────

    get supportsBulkLink() { return true; }

    openBulkLinkUI() {
        CoreAPI.openBulkAutoLinkModal?.();
    }

    async searchForBulkLink(name, creator) {
        try {
            const data = await searchCards(
                { q: name, creator: creator || '', limit: 15, sort: 'most_downloaded', nsfw: true },
                api?.apiRequest,
            );
            const results = Array.isArray(data?.cards) ? data.cards
                : Array.isArray(data?.results) ? data.results
                : Array.isArray(data) ? data : [];
            return results.map(hit => this._normalizeSearchResult(hit));
        } catch (e) {
            console.error('[CharaVault] searchForBulkLink:', e);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        return result.avatarUrl || '';
    }

    // ── Import Pipeline ─────────────────────────────────────

    get supportsImport() { return true; }

    /**
     * Import a character from CharaVault.
     * Flow:
     *   1. Fetch metadata (1 API call, throttled)
     *   2. Fetch static PNG (free, not throttled)
     *   3. Extract embedded V2 card; backfill from metadata
     *   4. If has_book, fetch lorebook list + first book (2 API calls)
     *   5. importFromPng()
     *
     * @param {string} fullPath - "folder/file"
     * @param {Object} [hitData] - Optional pre-fetched search-hit data
     */
    async importCharacter(fullPath, hitData, options = {}) {
        try {
            const parts = splitFullPath(fullPath);
            if (!parts) throw new Error('Invalid CharaVault path');
            const { folder, file } = parts;

            // 1. Metadata (throttled)
            let metadata = null;
            try {
                metadata = await fetchCardDetail(folder, file, api?.apiRequest);
            } catch (e) {
                api?.debugLog?.('[CharaVault] Metadata fetch failed:', e.message);
                if (!hitData) throw e;
                metadata = hitData;
            }

            const characterName = metadata?.name || hitData?.name || file;

            // 2. Static PNG download (free, unthrottled)
            const pngUrl = getCardPngUrl(folder, file);
            let imageBuffer = null;
            try {
                const resp = await fetchWithProxy(pngUrl);
                imageBuffer = await resp.arrayBuffer();
            } catch (e) {
                console.warn('[CharaVault] PNG download failed:', e.message);
            }

            // 3. Extract V2 from PNG (authoritative) or fall back to metadata
            let characterCard = null;
            if (imageBuffer) {
                try {
                    const pngCard = api?.extractCharacterDataFromPng?.(imageBuffer);
                    if (pngCard?.data) characterCard = pngCard;
                } catch (_) { /* fallback below */ }
            }

            if (!characterCard) {
                characterCard = buildCharacterCardFromCv(metadata || hitData || { folder, file });
            }

            // Backfill tags from metadata when the PNG's card had none
            if (!characterCard.data.tags?.length) {
                const metaTags = parseTags(metadata?.tags || hitData?.tags);
                if (metaTags.length) characterCard.data.tags = metaTags;
            }

            // Set CharaVault link metadata + content hash
            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            const contentHash = imageBuffer ? await sha256Hex(imageBuffer) : null;
            characterCard.data.extensions.charavault = {
                ...(characterCard.data.extensions.charavault || {}),
                folder,
                file,
                fullPath: `${folder}/${file}`,
                tagline: metadata?.tagline || hitData?.tagline || '',
                updatedAt: metadata?.updated_at || metadata?.updatedAt || null,
                tokenCount: metadata?.token_count || metadata?.tokenCount || 0,
                contentHash: contentHash || null,
                linkedAt: new Date().toISOString(),
                _v: 1,
            };

            // 4. Fetch and attach lorebook when the card advertises one
            const hasBook = metadata?.has_book || hitData?.has_book;
            if (hasBook) {
                try {
                    const books = await fetchCardLorebooks(folder, file, api?.apiRequest);
                    if (books.length > 0) {
                        const firstId = books[0]?.id || books[0]?.lorebook_id;
                        if (firstId) {
                            const rawBook = await fetchLorebook(firstId, api?.apiRequest);
                            const v2Book = normalizeLorebookToV2(rawBook);
                            if (v2Book) {
                                // Only overwrite if the fetched book has more entries
                                const existingEntries = characterCard.data.character_book?.entries?.length || 0;
                                if (!characterCard.data.character_book || v2Book.entries.length > existingEntries) {
                                    characterCard.data.character_book = v2Book;
                                    api?.debugLog?.(`[CharaVault] Attached lorebook (${v2Book.entries.length} entries)`);
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[CharaVault] Lorebook fetch failed:', e.message);
                }
            }

            assignGalleryId(characterCard, options, api);

            return await importFromPng({
                characterCard,
                imageBuffer,
                fileName: `cv_${slugify(characterName)}.png`,
                characterName,
                hasGallery: false,
                providerCharId: `${folder}/${file}`,
                fullPath: `${folder}/${file}`,
                avatarUrl: getAvatarUrl(folder, file),
                api,
            });
        } catch (error) {
            console.error(`[CharaVault] importCharacter failed for ${fullPath}:`, error);
            return { success: false, error: error.message };
        }
    }

    // ── Gallery ─────────────────────────────────────────────

    get supportsGallery() { return false; }

    // ── Import Duplicate Detection ──────────────────────────

    async searchForImportMatch(name, creator, _localChar) {
        if (!name) return null;
        try {
            const results = await this.searchForBulkLink(name, creator || '');
            if (results.length === 0) return null;

            const normalizedName = name.toLowerCase().trim();
            for (const r of results) {
                const rName = (r.name || '').toLowerCase().trim();
                if (rName === normalizedName || rName.includes(normalizedName) || normalizedName.includes(rName)) {
                    return { id: r.fullPath, fullPath: r.fullPath, hasGallery: false };
                }
            }
            return { id: results[0].fullPath, fullPath: results[0].fullPath, hasGallery: false };
        } catch (e) {
            console.error('[CharaVault] searchForImportMatch:', e);
            return null;
        }
    }

    // ── Private Helpers ─────────────────────────────────────

    _hitFromDetail(detail, folder, file) {
        return {
            folder,
            file,
            fullPath: `${folder}/${file}`,
            name: detail?.name || file,
            creator: detail?.creator || folder,
            tagline: detail?.tagline || '',
            description: detail?.description || detail?.creator_notes || '',
            tags: parseTags(detail?.tags),
            token_count: detail?.token_count || detail?.tokenCount || 0,
            has_book: !!detail?.has_book,
            nsfw: !!detail?.nsfw,
            downloads: detail?.downloads || detail?.download_count || 0,
            rating: detail?.rating || detail?.average_rating || 0,
            updated_at: detail?.updated_at || detail?.updatedAt || null,
            created_at: detail?.created_at || detail?.createdAt || null,
        };
    }

    _normalizeSearchResult(hit) {
        const folder = hit.folder || hit.creator || (hit.full_path || hit.fullPath || '').split('/')[0] || '';
        const file = hit.file || hit.slug || (hit.full_path || hit.fullPath || '').split('/')[1] || '';
        const fullPath = `${folder}/${file}`;
        return {
            id: fullPath,
            fullPath,
            name: hit.name || file,
            avatarUrl: folder && file ? getAvatarUrl(folder, file) : '',
            rating: hit.rating || hit.average_rating || 0,
            starCount: 0,
            description: stripHtml(hit.tagline || hit.description || ''),
            tagline: hit.tagline || '',
            nTokens: hit.token_count || hit.tokenCount || 0,
        };
    }
}

const charavaultProvider = new CharaVaultProvider();

// ========================================
// WINDOW EXPORTS (for library.js settings modal + openAuthUI)
// ========================================

window.charavaultLogin = async (email, appPassword) => {
    await checkCvPluginAvailable(CoreAPI.apiRequest);
    return cvLogin(CoreAPI.apiRequest, email, appPassword);
};

window.charavaultLogout = async () => {
    await cvLogout(CoreAPI.apiRequest);
};

window.charavaultValidateSession = async () => {
    await checkCvPluginAvailable(CoreAPI.apiRequest);
    await checkCvSession(CoreAPI.apiRequest);
    if (!isCvSessionActive()) return { valid: false, reason: 'no active session' };
    return cvValidateSession(CoreAPI.apiRequest);
};

window.charavaultCheckPluginAvailable = async () => {
    return checkCvPluginAvailable(CoreAPI.apiRequest);
};

export default charavaultProvider;
