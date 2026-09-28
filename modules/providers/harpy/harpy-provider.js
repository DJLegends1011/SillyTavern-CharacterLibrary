// Harpy Provider - implementation for the harpy.chat character source
//
// Guest provider: browsing, creators, tags and gallery use Harpy's public Supabase REST API
// directly from the browser. Full definitions (description, scenario, every greeting) come
// from the public character page through cl-helper, or ST's /proxy/ without it. A creator
// can lock a card, which nulls its description and scenario on that page; such cards import
// only as incomplete cards until the capture path lands.

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng, fetchWithProxy } from '../provider-utils.js';
import harpyBrowseView from './harpy-browse.js';
import {
    HARPY_SITE_BASE,
    searchHarpy,
    fetchHarpyListingRow,
    fetchHarpyCharacterPage,
    fetchHarpyGallery,
    buildV2FromHarpy,
    harpyCharName,
    harpyListingTitle,
    harpyCreatorName,
    harpyAvatarUrl,
    harpyCharacterUrl,
    parseHarpyUrl,
    isHarpyId,
    slugify,
    stripHtml,
} from './harpy-api.js';

let api = null;

/** Thrown when a locked card is imported without the caller opting into an incomplete card. */
export class HarpyLockedError extends Error {
    constructor() {
        super('This Harpy character\'s definition is locked by its creator');
        this.name = 'HarpyLockedError';
        this.locked = true;
    }
}

// ========================================
// PROVIDER CLASS
// ========================================

class HarpyProvider extends ProviderBase {
    // ── Identity ────────────────────────────────────────────

    get id() { return 'harpy'; }
    get name() { return 'Harpy'; }
    get icon() { return 'fa-solid fa-feather-pointed'; }
    get iconUrl() { return `${HARPY_SITE_BASE}/favicon.ico`; }
    get beta() { return true; }
    get disabledByDefault() { return true; }
    get enableWarning() {
        return 'Harpy is an experimental source. Browsing works on its own; importing full definitions uses the cl-helper plugin (or SillyTavern\'s CORS proxy). Cards whose creator locked the definition import incomplete.';
    }
    // No cl-helper gate: browse needs nothing, and the definition fetch prefers cl-helper's
    // /harpy-page (feature-probed via /health) but falls back to ST's /proxy/ without it.
    get browseView() { return harpyBrowseView; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-comments', label: 'Chats' },
            stat2: { icon: 'fa-solid fa-heart', label: 'Likes' },
            stat3: { icon: 'fa-solid fa-coins', label: 'Tokens' },
        };
    }

    // ── Lifecycle ───────────────────────────────────────────

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
    }

    async activate(container, options = {}) {
        harpyBrowseView.activate(container, options);
    }

    deactivate() {
        harpyBrowseView.deactivate();
    }

    // ── View ────────────────────────────────────────────────

    get hasView() { return true; }

    renderFilterBar() { return harpyBrowseView.renderFilterBar(); }
    renderView() { return harpyBrowseView.renderView(); }
    renderModals() { return harpyBrowseView.renderModals(); }

    // ── Character Linking ───────────────────────────────────

    getLinkInfo(char) {
        if (!char) return null;
        const extensions = char.data?.extensions || char.extensions;
        const hp = extensions?.harpy;
        if (!hp?.id) return null;
        return {
            providerId: 'harpy',
            id: hp.id,
            fullPath: String(hp.id),
            linkedAt: hp.linkedAt || null,
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};

        if (linkInfo) {
            const existing = char.data.extensions.harpy || {};
            char.data.extensions.harpy = {
                id: linkInfo.id,
                linkedAt: linkInfo.linkedAt || existing.linkedAt || new Date().toISOString(),
                pageName: linkInfo.pageName || existing.pageName || null,
            };
            // Re-linking to the same card keeps creator info; a different target starts fresh
            if (existing.id === linkInfo.id) {
                for (const k of ['ownerId', 'creatorName', 'locked', 'definitionMissing']) {
                    if (existing[k] != null) char.data.extensions.harpy[k] = existing[k];
                }
            }
        } else {
            delete char.data.extensions.harpy;
        }
    }

    getListingName(hitData) {
        return hitData ? harpyListingTitle(hitData) : null;
    }

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.id) return null;
        return harpyCharacterUrl(linkInfo.id);
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    // ── Link Stats ──────────────────────────────────────────

    async fetchLinkStats(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const row = await fetchHarpyListingRow(linkInfo.id);
            if (!row) return null;
            return { stat1: row.chat_count ?? null, stat2: row.like_count ?? null, stat3: row.token_count ?? null };
        } catch (e) {
            api?.debugLog?.('[HarpyProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    // ── Remote Data ─────────────────────────────────────────

    async fetchMetadata(characterId) {
        try {
            return await fetchHarpyListingRow(characterId);
        } catch (e) {
            console.error('[HarpyProvider] fetchMetadata failed:', characterId, e);
            return null;
        }
    }

    async fetchRemoteCard(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const [row, page] = await Promise.all([
                fetchHarpyListingRow(linkInfo.id),
                fetchHarpyCharacterPage(linkInfo.id, api?.apiRequest),
            ]);
            if (!row) return null;
            const result = buildV2FromHarpy(row, page);
            result._listingName = this.getListingName(row);
            // Linked lorebooks are private on Harpy: an absent book is unread, not empty
            result._lorebookUnavailable = !result.data.character_book;
            if (page.isLocked) {
                // Locked definitions read as null: never propose blanking the local card
                result._unavailableFields = new Set(['description', 'scenario']);
            }
            return result;
        } catch (e) {
            console.error('[HarpyProvider] fetchRemoteCard failed:', linkInfo.id, e);
            return null;
        }
    }

    // ── Update Checking ─────────────────────────────────────
    // fetchRemoteCard already returns spec-v2, so the ProviderBase normalize/refresh defaults apply.

    get supportsVersionHistory() { return false; }

    // ── Gallery ─────────────────────────────────────────────

    get supportsGallery() { return true; }

    async fetchGalleryImages(linkInfo) {
        if (!linkInfo?.id) return [];
        try {
            return (await fetchHarpyGallery(linkInfo.id)).map(g => ({ url: g.url, id: g.id, name: g.name, nsfw: g.nsfw }));
        } catch (e) {
            console.error('[HarpyProvider] fetchGalleryImages failed:', linkInfo.id, e);
            return [];
        }
    }

    // ── In-App Preview ──────────────────────────────────────

    get supportsInAppPreview() { return true; }

    async buildPreviewObject(char, linkInfo) {
        const id = linkInfo?.id;
        if (!id) return null;
        try {
            const row = await fetchHarpyListingRow(id);
            if (row) return row;
        } catch (e) {
            console.warn('[HarpyProvider] buildPreviewObject fetch failed:', e.message);
        }
        // Offline / fetch failed: preview from the local card so "View on Harpy" still opens
        const data = char?.data || {};
        const hp = data.extensions?.harpy || {};
        return {
            id,
            name: char?.name || data.name || 'Unknown',
            title: hp.pageName || '',
            tags: Array.isArray(data.tags) ? data.tags : [],
            creator: hp.creatorName || data.creator || '',
            owner_id: hp.ownerId || null,
            is_locked: hp.locked === true,
            _localAvatar: char?.avatar ? `/thumbnail?type=avatar&file=${encodeURIComponent(char.avatar)}` : '',
        };
    }

    openPreview(previewChar) {
        harpyBrowseView.openPreview?.(previewChar);
    }

    // ── Local Import Enrichment ─────────────────────────────

    async enrichLocalImport(cardData, _fileName) {
        const ext = cardData.data?.extensions?.harpy;
        if (!ext?.id) return null;
        return {
            cardData,
            providerInfo: {
                providerId: 'harpy',
                charId: ext.id,
                fullPath: String(ext.id),
                hasGallery: false,
                avatarUrl: null,
            },
        };
    }

    // ── URL Handling ────────────────────────────────────────

    canHandleUrl(url) {
        return parseHarpyUrl(url)?.type === 'character';
    }

    parseUrl(url) {
        const parsed = parseHarpyUrl(url);
        return parsed?.type === 'character' ? parsed.id : null;
    }

    // ── Bulk Linking ────────────────────────────────────────

    get supportsBulkLink() { return true; }

    openBulkLinkUI() {
        CoreAPI.openBulkAutoLinkModal?.();
    }

    async searchForBulkLink(name, _creator) {
        if (!name?.trim()) return [];
        try {
            // Locked and NSFW cards stay listed: a link is identity, not an import
            const data = await searchHarpy({ search: name.trim(), limit: 25, nsfw: true, showLocked: true });
            return (data.characters || []).map(row => ({
                id: row.id,
                fullPath: String(row.id),
                name: harpyCharName(row),
                listingName: harpyListingTitle(row),
                creator: harpyCreatorName(row),
                avatarUrl: harpyAvatarUrl(row),
                rating: 0,
                starCount: row.like_count || 0,
                description: stripHtml(row.title || ''),
                nTokens: row.token_count || 0,
            }));
        } catch (error) {
            console.error('[HarpyProvider] searchForBulkLink error:', error);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        return result.avatarUrl || '';
    }

    // ── Import Pipeline ─────────────────────────────────────

    get supportsImport() { return true; }

    /**
     * Import a Harpy character by id.
     * @param {string} identifier - character UUID
     * @param {Object} [hitData] - listing row from the browse grid
     * @param {Object} [options] - { inheritedGalleryId, allowPartial }
     */
    async importCharacter(identifier, hitData, options = {}) {
        try {
            const id = String(identifier).toLowerCase();
            if (!isHarpyId(id)) throw new Error('Invalid Harpy character id');

            const [row, page] = await Promise.all([
                hitData?.id === id ? Promise.resolve(hitData) : fetchHarpyListingRow(id),
                fetchHarpyCharacterPage(id, api?.apiRequest),
            ]);
            if (!row) throw new Error('Character not found on Harpy (removed or made private?)');
            if (page.isLocked && !options.allowPartial) throw new HarpyLockedError();

            const characterCard = buildV2FromHarpy(row, page);
            const characterName = characterCard.data.name || harpyCharName(row);
            characterCard.data.extensions.harpy.linkedAt = new Date().toISOString();

            assignGalleryId(characterCard, options, api);

            const avatarUrl = harpyAvatarUrl(row) || page.raw?.image || '';
            let imageBuffer = null;
            if (avatarUrl) {
                try {
                    // Harpy's asset bucket sends no CORS headers: fetchWithProxy falls to ST /proxy/
                    const resp = await fetchWithProxy(avatarUrl);
                    imageBuffer = await resp.arrayBuffer();
                } catch (e) {
                    console.warn('[HarpyProvider] Avatar download failed:', e.message);
                }
            }

            let hasGallery = false;
            try {
                hasGallery = (await fetchHarpyGallery(id)).length > 0;
            } catch { /* gallery is optional */ }

            return await importFromPng({
                characterCard, imageBuffer,
                fileName: `harpy_${slugify(characterName)}.png`,
                characterName,
                hasGallery,
                providerCharId: id,
                fullPath: id,
                avatarUrl: avatarUrl || null,
                api,
            });
        } catch (error) {
            console.error(`[HarpyProvider] importCharacter failed for ${identifier}:`, error);
            return { success: false, error: error.message, locked: error instanceof HarpyLockedError };
        }
    }
}

const harpyProvider = new HarpyProvider();
export default harpyProvider;
