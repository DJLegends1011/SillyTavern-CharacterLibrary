// CharaVault Provider - character source backed by charavault.net

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng, slugify } from '../provider-utils.js';
import charavaultBrowseView, { markCvCardImported } from './charavault-browse.js';
import {
    initCvApi,
    getCvCdnBase,
    cvFetch,
    cvThumbUrl,
    cvThumbImgUrl,
    cvDownloadUrl,
    cvFullPath,
    splitCvPath,
    fetchCvCards,
    fetchCvCardDetail,
    buildCvCharacterCard,
    cvCardFields,
    cvMetadataCache,
} from './charavault-api.js';

const CV_ICON_DATA_URI = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><rect width="32" height="32" rx="6" fill="#0c0c0f"/><rect x="0.5" y="0.5" width="31" height="31" rx="5.5" fill="none" stroke="#d4a54a" stroke-opacity="0.3" stroke-width="1"/><text x="14" y="19.5" font-family="Arial,Helvetica,sans-serif" font-weight="800" font-size="15" fill="#d4a54a" text-anchor="middle" letter-spacing="-0.5">CV</text><rect x="22" y="22" width="8" height="7" rx="1.5" fill="#d4a54a"/><path d="M24 22v-2.5a2 2 0 0 1 4 0V22" fill="none" stroke="#d4a54a" stroke-width="1.8" stroke-linecap="round"/><circle cx="26" cy="25.5" r="1" fill="#0c0c0f"/></svg>');

let api = null;

// Cached raw API node from fetchLinkStats - reused by getCachedLinkNode
let _cachedLinkNode = null;

class CharaVaultProvider extends ProviderBase {
    // ── Identity ────────────────────────────────────────────

    get id() { return 'charavault'; }
    get name() { return 'CharaVault'; }
    get icon() { return 'fa-solid fa-vault'; }
    // charavault.net/favicon.ico inlined: CORP same-site blocks it cross-origin, and ST /proxy/
    // drops the svg content-type so the proxied copy will not render either.
    get iconUrl() { return CV_ICON_DATA_URI; }
    get clHelperFeatures() { return { login: { minVersion: '1.13.0', label: 'Logging in (NSFW)' } }; }
    get browseView() { return charavaultBrowseView; }

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
        const ext = char.data?.extensions?.charavault;
        if (!ext?.full_path) return null;
        return {
            providerId: 'charavault',
            id: ext.full_path,
            fullPath: ext.full_path,
            linkedAt: ext.linkedAt || null,
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};
        if (linkInfo) {
            const existing = char.data.extensions.charavault || {};
            char.data.extensions.charavault = {
                ...existing,
                full_path: linkInfo.fullPath,
                linkedAt: linkInfo.linkedAt || new Date().toISOString(),
            };
        } else {
            delete char.data.extensions.charavault;
        }
    }

    // charavault.net has no per-card page (its card view is a modal with no URL, and it reads no
    // query params), so the closest external link is the card PNG itself.
    getCharacterUrl(linkInfo) {
        if (!linkInfo?.fullPath) return null;
        const { folder, file } = splitCvPath(linkInfo.fullPath);
        return `https://charavault.net/cards/preview/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    // ── Remote Data ─────────────────────────────────────────

    async fetchMetadata(fullPath) {
        const detail = await fetchCvCardDetail(fullPath);
        return detail?.entry || null;
    }

    async fetchRemoteCard(linkInfo) {
        const fullPath = linkInfo?.fullPath;
        if (!fullPath) return null;
        try {
            const detail = await fetchCvCardDetail(fullPath);
            if (!detail) return null;
            const card = buildCvCharacterCard(detail, fullPath, null);
            return card;
        } catch (e) {
            api?.debugLog?.('[CharaVaultProvider] fetchRemoteCard:', e.message);
            return null;
        }
    }

    async fetchLinkStats(linkInfo) {
        const fullPath = linkInfo?.fullPath;
        if (!fullPath) return null;
        try {
            const detail = await fetchCvCardDetail(fullPath);
            const entry = detail?.entry;
            if (!entry) return null;
            _cachedLinkNode = entry;
            // Same row as the other providers (downloads / popularity / tokens). CharaVault has no
            // favorites; its rating is usually unrated (0), so it goes in the middle slot.
            return {
                stat1: entry.download_count || 0,
                stat2: entry.avg_rating ? parseFloat(entry.avg_rating.toFixed(1)) : 0,
                stat3: entry.token_count || 0,
            };
        } catch (e) {
            api?.debugLog?.('[CharaVaultProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-download', label: 'Downloads' },
            stat2: { icon: 'fa-solid fa-star', label: 'Rating' },
            stat3: { icon: 'fa-solid fa-coins', label: 'Tokens' },
        };
    }

    getCachedLinkNode() { return _cachedLinkNode; }
    clearCachedLinkNode() { _cachedLinkNode = null; }

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
        if (!url) return null;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            // Paths: /cards/preview/{folder}/{file} or /cards/{folder}/{file}
            const match = u.pathname.match(/\/cards(?:\/(?:preview|thumb|download))?\/([^/]+)\/(.+)/);
            if (match) return cvFullPath(match[1], match[2]);
        } catch { /* ignore */ }
        return null;
    }

    // ── Settings ────────────────────────────────────────────

    getSettings() {
        return [
            {
                key: 'charavaultGatewayUrl',
                label: 'Gateway URL (optional)',
                type: 'text',
                defaultValue: '',
                hint: 'Leave empty to talk to charavault.net directly. Only set this if you proxy CharaVault through your own gateway.',
                section: 'CharaVault',
            },
            {
                key: 'charavaultGatewayKey',
                label: 'Gateway API Key (optional)',
                type: 'password',
                defaultValue: '',
                hint: 'Bearer token sent to your gateway. Ignored when Gateway URL is empty.',
                section: 'CharaVault',
            },
            {
                key: 'charavaultEmail',
                label: 'Email',
                type: 'text',
                defaultValue: null,
                hint: 'CharaVault account email, used with the app password to log in.',
                section: 'CharaVault',
            },
            {
                key: 'charavaultAppPassword',
                label: 'App Password',
                type: 'password',
                defaultValue: null,
                hint: 'CharaVault app password (cv_...). Logging in unlocks NSFW (18+ verified accounts) and higher rate limits.',
                section: 'CharaVault',
            },
        ];
    }

    // ── Bulk Linking ────────────────────────────────────────

    get supportsBulkLink() { return true; }

    openBulkLinkUI() {
        CoreAPI.openBulkAutoLinkModal?.();
    }

    async searchForBulkLink(name, creator) {
        try {
            const results = [];

            // Search by creator first if available (most precise)
            if (creator && creator.trim()) {
                const creatorData = await fetchCvCards({
                    creator: creator.trim(),
                    q: name,
                    limit: 20,
                    sort: 'most_downloaded',
                });
                for (const r of (creatorData.results || [])) {
                    r.fullPath = cvFullPath(r.folder, r.file);
                    results.push(this._normalizeSearchResult(r));
                }
                if (results.length > 0) return results;
            }

            // Name-only fallback
            const data = await fetchCvCards({ q: name, limit: 15, sort: 'most_downloaded' });
            for (const r of (data.results || [])) {
                r.fullPath = cvFullPath(r.folder, r.file);
                if (!results.some(x => x.fullPath === r.fullPath)) {
                    results.push(this._normalizeSearchResult(r));
                }
            }
            return results;
        } catch (e) {
            api?.debugLog?.('[CharaVaultProvider] searchForBulkLink:', e.message);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        const fp = result.fullPath || '';
        const slash = fp.indexOf('/');
        if (slash < 0) return '';
        const folder = fp.slice(0, slash);
        const file = fp.slice(slash + 1);
        return cvThumbImgUrl(folder, file);
    }

    // ── Import Pipeline ─────────────────────────────────────

    get supportsImport() { return true; }

    /**
     * Import a character from CharaVault by fullPath.
     * Downloads the PNG card directly; the PNG already has the character
     * data embedded, so we extract it, rebuild with our extension metadata,
     * then re-embed and upload to SillyTavern.
     */
    async importCharacter(fullPath, hitData, options = {}) {
        try {
            const detail = await fetchCvCardDetail(fullPath);
            if (!detail) throw new Error('Could not fetch character metadata');

            const { folder, file } = splitCvPath(fullPath);
            const pngUrl = cvDownloadUrl(folder, file);
            let imageBuffer = null;
            let embeddedCard = null;
            try {
                const resp = await cvFetch(pngUrl);
                if (resp.ok) {
                    imageBuffer = await resp.arrayBuffer();
                    // The original upload's card: importFromPng re-embeds characterCard, so
                    // anything not copied from here (lorebook etc.) would be lost.
                    embeddedCard = api?.extractCharacterDataFromPng?.(imageBuffer) || null;
                    if (!cvCardFields(embeddedCard).name && !cvCardFields(embeddedCard).description) embeddedCard = null;
                }
            } catch (e) {
                api?.debugLog?.('[CharaVaultProvider] PNG download:', e.message);
            }

            // hitData is the search-list row passed from the browse modal -
            // it carries `has_lorebook` which is missing from the detail entry.
            const characterCard = buildCvCharacterCard(detail, fullPath, hitData, embeddedCard);
            const characterName = characterCard.data.name || fullPath.split('/').pop().replace(/\.png$/i, '');

            assignGalleryId(characterCard, options, api);

            // Fall back to thumbnail if PNG download failed
            if (!imageBuffer) {
                try {
                    const thumbUrl = cvThumbUrl(folder, file);
                    const resp = await cvFetch(thumbUrl);
                    if (resp.ok) imageBuffer = await resp.arrayBuffer();
                } catch (e) {
                    api?.debugLog?.('[CharaVaultProvider] thumb fallback:', e.message);
                }
            }

            cvMetadataCache.delete(fullPath);

            const result = await importFromPng({
                characterCard,
                imageBuffer,
                fileName: `cv_${slugify(characterName)}.png`,
                characterName,
                hasGallery: false,
                providerCharId: fullPath,
                fullPath,
                avatarUrl: cvThumbUrl(folder, file),
                api,
            });

            if (result.success) {
                markCvCardImported(fullPath);
            }
            return result;
        } catch (e) {
            api?.debugLog?.('[CharaVaultProvider] importCharacter:', e.message);
            return { success: false, error: e.message };
        }
    }

    // ── In-App Preview ──────────────────────────────────────

    get supportsInAppPreview() { return true; }

    /**
     * Preview object for "View on CharaVault" from a linked library character: the live detail
     * entry (same shape as a browse row), else the local card so the preview still opens when
     * the card is gone, the network is down, or it is an NSFW card and the session is missing.
     */
    async buildPreviewObject(char, linkInfo) {
        const fullPath = linkInfo?.fullPath || linkInfo?.id;
        if (!fullPath) return null;
        const { folder, file } = splitCvPath(fullPath);
        const detail = await fetchCvCardDetail(fullPath);
        if (detail?.entry) {
            return { ...detail.entry, folder: detail.entry.folder || folder, file: detail.entry.file || file, fullPath };
        }
        const data = char?.data || {};
        const cv = data.extensions?.charavault || {};
        return {
            fullPath,
            folder,
            file,
            name: char?.name || data.name || file.replace(/\.png$/i, ''),
            creator: data.creator || '',
            tags: Array.isArray(data.tags) ? data.tags : [],
            nsfw: false,
            avg_rating: cv.avg_rating || 0,
            rating_count: cv.rating_count || 0,
            download_count: cv.download_count || 0,
            has_lorebook: !!cv.has_lorebook,
        };
    }

    openPreview(previewChar) {
        charavaultBrowseView.openPreview?.(previewChar);
    }

    // ── Local Import Enrichment ─────────────────────────────

    /**
     * A PNG exported from CL after a CharaVault import carries extensions.charavault.full_path;
     * re-importing it from disk re-links it. (A PNG downloaded straight from charavault.net is the
     * creator's original upload and carries no CharaVault id, so there is nothing to match.)
     */
    async enrichLocalImport(cardData, _fileName) {
        const fullPath = cardData?.data?.extensions?.charavault?.full_path;
        if (!fullPath) return null;
        const { folder, file } = splitCvPath(fullPath);
        return {
            cardData,
            providerInfo: {
                providerId: 'charavault',
                charId: fullPath,
                fullPath,
                hasGallery: false,
                avatarUrl: cvThumbUrl(folder, file),
            },
        };
    }

    // ── Private ─────────────────────────────────────────────

    _normalizeSearchResult(r) {
        return {
            id: r.fullPath,
            fullPath: r.fullPath,
            name: r.name || r.file || '',
            avatarUrl: cvThumbImgUrl(r.folder || r.fullPath.split('/')[0], r.file || r.fullPath.split('/').pop()),
            rating: r.avg_rating || 0,
            starCount: r.rating_count || 0,
            description: r.description_preview || '',
            tagline: (r.tags || []).slice(0, 4).join(', '),
            nTokens: r.token_count || 0,
        };
    }
}

const charavaultProvider = new CharaVaultProvider();
export default charavaultProvider;
