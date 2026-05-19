// MasqueradeAI Provider - browser-only public catalog integration.

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng, fetchWithProxy, slugify } from '../provider-utils.js';
import masqueradeBrowseView from './masquerade-browse.js';
import {
    MASQUERADE_SITE_BASE,
    initMasqueradeApi,
    masqueradeMetadataCache,
    fetchMasqueradeMetadata,
    searchMasqueradeCharacters,
    buildCharacterCardFromMasquerade,
    getAvatarUrl,
    getCharacterPageUrl,
    getGalleryUrls,
    parseCharacterUrl,
} from './masquerade-api.js';

let api = null;
let _cachedLinkNode = null;

function getLinkId(linkInfo) {
    return linkInfo?.id || linkInfo?.fullPath || '';
}

function metadataMatchesLink(metadata, charId) {
    return !!metadata && String(metadata.id || metadata.character_id || '') === String(charId || '');
}

class MasqueradeProvider extends ProviderBase {
    get id() { return 'masquerade'; }
    get name() { return 'MasqueradeAI'; }
    get icon() { return 'fa-solid fa-masks-theater'; }
    get iconUrl() { return `${MASQUERADE_SITE_BASE}/icon-192.png`; }
    get browseView() { return masqueradeBrowseView; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-comments', label: 'Messages' },
            stat2: { icon: 'fa-solid fa-bookmark', label: 'Saved' },
            stat3: { icon: 'fa-solid fa-star', label: 'Quality' },
        };
    }

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
        initMasqueradeApi({ getSetting: coreAPI.getSetting, debugLog: coreAPI.debugLog });
    }

    async activate(container, options = {}) {
        await masqueradeBrowseView.activate(container, options);
    }

    deactivate() {
        masqueradeBrowseView.deactivate();
    }

    get hasView() { return true; }
    renderFilterBar() { return masqueradeBrowseView.renderFilterBar(); }
    renderView() { return masqueradeBrowseView.renderView(); }
    renderModals() { return masqueradeBrowseView.renderModals(); }

    getLinkInfo(char) {
        if (!char) return null;
        const extensions = char.data?.extensions || char.extensions;
        const mq = extensions?.masquerade;
        if (!mq?.id) return null;

        return {
            providerId: 'masquerade',
            id: mq.id,
            fullPath: mq.id,
            linkedAt: mq.linkedAt || null,
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};

        if (linkInfo) {
            const existing = char.data.extensions.masquerade || {};
            const id = linkInfo.id || linkInfo.fullPath;
            char.data.extensions.masquerade = {
                ...existing,
                id,
                pageName: linkInfo.pageName || existing.pageName || null,
                linkedAt: linkInfo.linkedAt || existing.linkedAt || new Date().toISOString(),
            };
        } else {
            delete char.data.extensions.masquerade;
        }
    }

    getCharacterUrl(linkInfo) {
        const id = linkInfo?.id || linkInfo?.fullPath;
        return id ? getCharacterPageUrl(id) : null;
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    get supportsInAppPreview() { return true; }

    async buildPreviewObject(_char, linkInfo) {
        const charId = getLinkId(linkInfo);
        if (!charId) return null;

        let metadata = this.getCachedLinkNode();
        if (metadata) {
            this.clearCachedLinkNode();
            if (metadataMatchesLink(metadata, charId)) return metadata;
        }

        try {
            metadata = await this.fetchMetadata(charId);
        } catch {
            return null;
        }
        return metadata || null;
    }

    openPreview(previewChar) {
        if (typeof window !== 'undefined') window.openMasqueradeCharPreview?.(previewChar);
    }

    async enrichLocalImport(cardData, _fileName) {
        const ext = cardData.data?.extensions?.masquerade;
        if (!ext?.id) return null;

        return {
            cardData,
            providerInfo: {
                providerId: 'masquerade',
                charId: ext.id,
                fullPath: ext.id,
                hasGallery: !!(ext.background_url || ext.circle_avatar_url),
                avatarUrl: ext.image_url || null,
            },
        };
    }

    async fetchMetadata(charId) {
        return fetchMasqueradeMetadata(charId);
    }

    async fetchRemoteCard(linkInfo) {
        const charId = getLinkId(linkInfo);
        if (!charId) return null;

        try {
            const metadata = await this.fetchMetadata(charId);
            if (!metadata) return null;
            const result = buildCharacterCardFromMasquerade(metadata);
            if (result) result._listingName = this.getListingName(metadata);
            return result;
        } catch (error) {
            console.error('[MasqueradeProvider] fetchRemoteCard failed:', charId, error);
            return null;
        }
    }

    normalizeRemoteCard(rawData) {
        if (!rawData) return null;
        if (rawData.spec === 'chara_card_v2') return rawData;
        return buildCharacterCardFromMasquerade(rawData);
    }

    async fetchLinkStats(linkInfo) {
        const charId = getLinkId(linkInfo);
        if (!charId) return null;

        try {
            const node = await this.fetchMetadata(charId);
            if (!node) return null;
            _cachedLinkNode = node;
            return {
                stat1: node.total_messages || 0,
                stat2: node.subscriber_count || 0,
                stat3: node.quality_score || 0,
            };
        } catch (error) {
            api?.debugLog?.('[MasqueradeProvider] fetchLinkStats:', error.message);
            return null;
        }
    }

    getCachedLinkNode() {
        return _cachedLinkNode;
    }

    clearCachedLinkNode() {
        _cachedLinkNode = null;
    }

    getComparableFields() {
        return [
            {
                path: 'extensions.masquerade.tagline',
                label: 'Masquerade Tagline',
                icon: 'fa-solid fa-quote-left',
                optional: true,
                group: 'tagline',
                groupLabel: 'Tagline',
            },
        ];
    }

    get hasAuth() { return false; }
    get isAuthenticated() { return false; }
    getAuthHeaders() { return {}; }

    canHandleUrl(url) {
        return !!parseCharacterUrl(url);
    }

    parseUrl(url) {
        return parseCharacterUrl(url);
    }

    getSettings() {
        return [
            {
                key: 'masqueradeNsfw',
                label: 'Show NSFW content',
                type: 'checkbox',
                defaultValue: false,
                section: 'Display',
            },
            {
                key: 'showMasqueradeTagline',
                label: 'Show MasqueradeAI tagline in previews',
                type: 'checkbox',
                defaultValue: true,
                section: 'Display',
            },
        ];
    }

    get supportsBulkLink() { return true; }

    openBulkLinkUI() {
        CoreAPI.openBulkAutoLinkModal?.();
    }

    async searchForBulkLink(name, _creator) {
        try {
            const normalizedName = String(name || '').toLowerCase().trim();
            const results = await searchMasqueradeCharacters({
                query: name,
                limit: 20,
                nsfw: api?.getSetting?.('masqueradeNsfw') === true,
                excludeTags: api?.getProviderExcludeTags?.('masquerade') || [],
            });
            return results
                .filter(char => {
                    const remoteName = String(char.name || '').toLowerCase().trim();
                    return remoteName === normalizedName
                        || remoteName.includes(normalizedName)
                        || normalizedName.includes(remoteName);
                })
                .map(char => this._normalizeSearchResult(char));
        } catch (error) {
            console.error('[MasqueradeProvider] searchForBulkLink error:', error);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        return result.avatarUrl || '/img/ai4.png';
    }

    get supportsImport() { return true; }

    async importCharacter(charId, _hitData, options = {}) {
        try {
            const metadata = await this.fetchMetadata(charId);
            if (!metadata) throw new Error('Could not fetch character data from MasqueradeAI');

            const characterName = metadata.name || 'Unknown';
            const characterCard = buildCharacterCardFromMasquerade(metadata);
            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            characterCard.data.extensions.masquerade = {
                ...(characterCard.data.extensions.masquerade || {}),
                id: metadata.id,
                pageName: this.getListingName(metadata),
                linkedAt: new Date().toISOString(),
            };

            assignGalleryId(characterCard, options, api);

            const avatarUrl = getAvatarUrl(metadata);
            let imageBuffer = null;
            if (avatarUrl && avatarUrl !== '/img/ai4.png') {
                try {
                    const response = await fetchWithProxy(avatarUrl);
                    imageBuffer = await response.arrayBuffer();
                } catch (error) {
                    api?.debugLog?.('[MasqueradeProvider] Avatar download failed:', error.message);
                }
            }

            masqueradeMetadataCache.delete(charId);

            return await importFromPng({
                characterCard,
                imageBuffer,
                fileName: `masquerade_${slugify(characterName)}.png`,
                characterName,
                hasGallery: getGalleryUrls(metadata).length > 0,
                providerCharId: metadata.id,
                fullPath: metadata.id,
                avatarUrl,
                api,
            });
        } catch (error) {
            console.error(`[MasqueradeProvider] importCharacter failed for ${charId}:`, error);
            return { success: false, error: error.message };
        }
    }

    async searchForImportMatch(name, creator, _localChar) {
        if (!name) return null;
        const results = await this.searchForBulkLink(name, creator || '');
        if (!results.length) return null;
        return { id: results[0].id, fullPath: results[0].fullPath, hasGallery: true };
    }

    get supportsGallery() { return true; }

    async fetchGalleryImages(linkInfo) {
        const charId = getLinkId(linkInfo);
        if (!charId) return [];

        try {
            const metadata = await this.fetchMetadata(charId);
            return getGalleryUrls(metadata).map((url, index) => ({
                url,
                id: `${charId}-${index + 1}`,
            }));
        } catch (error) {
            console.error('[MasqueradeProvider] fetchGalleryImages failed:', error);
            return [];
        }
    }

    _normalizeSearchResult(char) {
        return {
            id: char.id || char.character_id || null,
            fullPath: char.id || char.character_id || '',
            name: char.name || 'Unnamed',
            avatarUrl: getAvatarUrl(char),
            rating: char.quality_score || 0,
            starCount: char.subscriber_count || 0,
            description: char.description || char.tagline || '',
            tagline: char.tagline || '',
            nTokens: 0,
        };
    }
}

const masqueradeProvider = new MasqueradeProvider();

export default masqueradeProvider;
