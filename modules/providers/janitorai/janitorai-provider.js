
import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng, fetchWithProxy, slugify } from '../provider-utils.js';
import { initJanitorSession } from '../janitor-session.js';
import janitoraiBrowseView from './janitorai-browse.js';
import {
    JANITORAI_SITE_BASE,
    fetchJanitoraiCharacter,
    fetchJanitoraiCharacters,
    buildV2FromJanitorai,
    hydrateJanitoraiScripts,
    hasUnfetchedLorebook,
    extractCharacterBookFromScripts,
    resolveJanitoraiAvatarUrl,
    janitoraiCharacterUrl,
    hasHiddenDefinition,
    hasBrowserEndpoint,
    extractViaBrowser,
    testBrowserEndpoint,
    browserLogin,
    browserLogout,
    browserSetSession,
    decodeHtmlEntities,
} from './janitorai-api.js';

let api = null;

// Extraction returns content client-side (no server cache to refresh), so refreshRemoteData
// hands its result to fetchRemoteCard through a one-shot map.
const _refreshedRemotes = new Map();

// Fields a hidden-definition card can't report; update check treats them as unknown.
function hiddenDefinitionFields(detail) {
    const fields = new Set(['description']);
    if (!detail?.first_message) fields.add('first_mes');
    if (!detail?.scenario) fields.add('scenario');
    if (!detail?.example_dialogs) fields.add('mes_example');
    return fields;
}


class JanitoraiProvider extends ProviderBase {

    get id() { return 'janitorai'; }
    get name() { return 'JanitorAI'; }
    get icon() { return 'fa-solid fa-broom'; }
    // The apex Cloudflare-gates /favicon.ico too; the media host serves it.
    get iconUrl() { return 'https://ella.janitorai.com/favicon.ico'; }
    get beta() { return true; }
    get disabledByDefault() { return true; }
    get enableWarning() { return 'JanitorAI only answers real browsers: Cloudflare challenges everything else. Character Library runs one for you, but it needs the machine hosting SillyTavern to have a working GPU; if it does not, point Settings > Online > JanitorAI at a browser on a desktop that does. Sign in there too, to get past the first page of results.'; }
    get minClHelperVersion() { return '1.9.0'; }
    get browseView() { return janitoraiBrowseView; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-comments', label: 'Chats' },
            stat2: { icon: 'fa-solid fa-envelope', label: 'Messages' },
            stat3: null,
        };
    }


    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
        initJanitorSession();
        // Window bridge: library.js is a classic script and cannot import from a module.
        window.janitoraiTestBrowserEndpoint = testBrowserEndpoint;
        window.janitoraiBrowserLogin = browserLogin;
        window.janitoraiBrowserLogout = browserLogout;
        window.janitoraiBrowserSetSession = browserSetSession;
        window.janitoraiFetchCharacter = fetchJanitoraiCharacter;
    }


    get hasView() { return true; }

    renderFilterBar() { return janitoraiBrowseView.renderFilterBar(); }
    renderView() { return janitoraiBrowseView.renderView(); }
    renderModals() { return janitoraiBrowseView.renderModals(); }

    async activate(container, options = {}) {
        janitoraiBrowseView.activate(container, options);
    }

    deactivate() {
        janitoraiBrowseView.deactivate();
    }


    getLinkInfo(char) {
        if (!char) return null;
        const extensions = char.data?.extensions || char.extensions;
        const ja = extensions?.janitorai;
        if (!ja) return null;
        const id = ja.id;
        if (!id) return null;

        return {
            providerId: 'janitorai',
            id,
            fullPath: String(id),
            pageName: ja.pageName || null,
            linkedAt: ja.linkedAt || null,
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};

        if (linkInfo) {
            const existing = char.data.extensions.janitorai || {};
            char.data.extensions.janitorai = {
                ...existing,
                id: linkInfo.id,
                linkedAt: linkInfo.linkedAt || new Date().toISOString(),
                pageName: linkInfo.pageName || existing.pageName || null,
            };
        } else {
            delete char.data.extensions.janitorai;
        }
    }

    getListingName(hitData) {
        return hitData?.name || null;
    }


    async fetchLinkStats(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const detail = await fetchJanitoraiCharacter(linkInfo.id);
            if (!detail) return null;
            return {
                stat1: parseInt(detail.stats?.chat, 10) || 0,
                stat2: parseInt(detail.stats?.message, 10) || 0,
                stat3: null,
            };
        } catch (e) {
            api?.debugLog?.('[JanitoraiProvider] fetchLinkStats:', e.message);
            return null;
        }
    }


    async fetchMetadata(characterId) {
        return fetchJanitoraiCharacter(characterId);
    }

    async refreshRemoteData(linkInfo, options = {}) {
        if (!linkInfo?.id) return;
        if (CoreAPI.getSetting('janitoraiExtractOnUpdate') !== true) return;
        if (!hasBrowserEndpoint()) return;
        const report = options?.onStatus;
        try {
            report?.('Extracting via browser...');
            // Short-circuits public cards helper-side after one detail fetch; only hidden
            // definitions pay the full extraction.
            const rec = await extractViaBrowser(linkInfo.id);
            if (rec?.detail) {
                _refreshedRemotes.set(linkInfo.id, {
                    detail: rec.detail,
                    definition: rec.definition || '',
                    firstMessage: rec.firstMessage || '',
                });
                report?.(rec.extracted ? 'Hidden definition recovered' : 'Definition is public');
            }
        } catch (err) {
            console.error('[JanitoraiProvider] refreshRemoteData failed, continuing without extraction:', err);
        }
    }

    async fetchRemoteCard(linkInfo) {
        if (!linkInfo?.id) return null;
        const refreshed = _refreshedRemotes.get(linkInfo.id) || null;
        if (refreshed) _refreshedRemotes.delete(linkInfo.id);
        // Null means gone (404 inside the fetch); a rate limit or block must throw, or the
        // update check reports a live card as Removed / Private.
        const detail = refreshed?.detail || await fetchJanitoraiCharacter(linkInfo.id);
        if (!detail) return null;
        await hydrateJanitoraiScripts(detail);
        const card = buildV2FromJanitorai(detail, refreshed || {});
        if (card) {
            card._listingName = this.getListingName(detail);
            // Unknown, not removed: an unreadable lorebook must not diff as deleted.
            if (hasUnfetchedLorebook(detail)) card._lorebookUnavailable = true;
            if (hasHiddenDefinition(detail)) {
                const fields = hiddenDefinitionFields(detail);
                if (refreshed?.definition) fields.delete('description');
                if (refreshed?.firstMessage) fields.delete('first_mes');
                if (fields.size) card._unavailableFields = fields;
            }
        }
        return card;
    }

    normalizeRemoteCard(rawData) {
        if (rawData?.spec === 'chara_card_v2') return rawData;
        const card = buildV2FromJanitorai(rawData);
        if (card && hasUnfetchedLorebook(rawData)) card._lorebookUnavailable = true;
        if (card && hasHiddenDefinition(rawData)) card._unavailableFields = hiddenDefinitionFields(rawData);
        return card;
    }

    async fetchLorebook(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const detail = await fetchJanitoraiCharacter(linkInfo.id);
            if (!detail) return null;
            await hydrateJanitoraiScripts(detail);
            return extractCharacterBookFromScripts(detail);
        } catch (e) {
            console.error('[JanitoraiProvider] fetchLorebook failed:', linkInfo.id, e);
            return null;
        }
    }


    getComparableFields() {
        return [];
    }


    get supportsVersionHistory() { return false; }


    get supportsGallery() { return false; }


    getCharacterUrl(linkInfo) {
        if (!linkInfo?.id) return null;
        return janitoraiCharacterUrl(linkInfo.id, linkInfo.pageName || '');
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    canHandleUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            return /^(www\.)?janitorai\.com$/i.test(u.hostname);
        } catch {
            return false;
        }
    }

    parseUrl(url) {
        if (!url) return null;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            if (!/^(www\.)?janitorai\.com$/i.test(u.hostname)) return null;
            const match = u.pathname.match(/\/characters?\/([a-f0-9-]{36})/i);
            return match ? match[1] : null;
        } catch {
            return null;
        }
    }


    get supportsInAppPreview() { return true; }

    async buildPreviewObject(char, linkInfo) {
        const charId = linkInfo?.id;
        if (!charId) return null;

        try {
            const detail = await fetchJanitoraiCharacter(charId);
            if (detail) {
                const preview = {
                    character_id: detail.id,
                    name: detail.chat_name || detail.name,
                    listing_name: detail.name,
                    // Decode so description matches the decoded state listing rows arrive in.
                    description: decodeHtmlEntities(detail.description || ''),
                    avatar: detail.avatar,
                    tags: detail.tags || [],
                    custom_tags: detail.custom_tags || [],
                    is_nsfw: detail.is_nsfw,
                    creator_id: detail.creator_id,
                    creator_name: detail.creator_name,
                    created_at: detail.created_at,
                    chat_count: detail.stats?.chat || 0,
                    message_count: detail.stats?.message || 0,
                    total_tokens: detail.token_counts?.total_tokens || 0,
                };
                // The full detail rides along so the IMPORT skips its refetch; the preview
                // modal still fetches its own fresh copy.
                preview._detail = detail;
                return preview;
            }
        } catch (e) {
            console.warn('[JanitoraiProvider] buildPreviewObject failed:', e.message);
        }

        const ext = char?.data?.extensions?.janitorai || {};
        return {
            character_id: charId,
            name: char?.name || 'Unknown',
            description: ext.tagline || '',
            avatar: ext.avatar || '',
            tags: [],
            is_nsfw: false,
            creator_name: char?.data?.creator || '',
        };
    }

    openPreview(previewChar) {
        window.openJanitoraiCharPreview?.(previewChar);
    }


    async enrichLocalImport(cardData, _fileName) {
        const ext = cardData.data?.extensions?.janitorai;
        if (ext?.id) {
            return {
                cardData,
                providerInfo: {
                    providerId: 'janitorai',
                    charId: ext.id,
                    fullPath: String(ext.id),
                    hasGallery: false,
                    avatarUrl: null,
                },
            };
        }
        return null;
    }


    get supportsImport() { return true; }

    /**
     * @param {string} identifier - character UUID
     * @param {Object} [hitData] - pre-fetched listing row or detail, when the caller has one
     */
    async importCharacter(identifier, hitData, options = {}) {
        try {
            const charId = String(identifier);

            // A listing row has none of the body fields, so anything without _detail must fetch.
            // _detail is only ever assigned from a real detail fetch; do not key any check on
            // showdefinition, which listing rows also carry (always false there).
            let detail = hitData?._detail || null;
            if (!detail) detail = await fetchJanitoraiCharacter(charId);
            if (!detail) throw new Error('Could not fetch character data from JanitorAI');

            const characterName = detail.chat_name || detail.name || 'Unnamed';

            // A withheld definition withholds the opening line too; both come from one recovery.
            let definition = options?.definition || '';
            let firstMessage = options?.firstMessage || '';
            let recoveryError = '';
            if (!definition && hasHiddenDefinition(detail) && hasBrowserEndpoint()) {
                try {
                    const rec = await extractViaBrowser(charId);
                    if (rec?.definition) definition = rec.definition;
                    if (rec?.firstMessage) firstMessage = rec.firstMessage;
                } catch (e) {
                    recoveryError = e?.message || 'extraction failed';
                    console.warn('[JanitoraiProvider] definition recovery failed:', recoveryError);
                    if (!options?.requireDefinition) {
                        api?.showToast?.(`Could not recover the hidden definition: ${recoveryError}`, 'warning', 7000);
                    }
                }
            }
            if (options?.requireDefinition && !definition && hasHiddenDefinition(detail)) {
                if (recoveryError) throw new Error(`Hidden definition recovery failed: ${recoveryError}`);
                throw new Error(hasBrowserEndpoint()
                    ? 'Hidden definition recovery returned nothing'
                    : 'Definition is hidden and no browser endpoint is available');
            }

            await hydrateJanitoraiScripts(detail);
            const characterCard = buildV2FromJanitorai(detail, { definition, firstMessage });
            if (!characterCard?.data) throw new Error('Failed to build character card');

            characterCard.data.extensions.janitorai = {
                ...(characterCard.data.extensions.janitorai || {}),
                id: charId,
                pageName: this.getListingName(detail),
                linkedAt: new Date().toISOString(),
            };

            assignGalleryId(characterCard, options, api);

            const avatarUrl = resolveJanitoraiAvatarUrl(detail, { preferOriginal: true });
            let imageBuffer = null;
            if (avatarUrl) {
                try {
                    const resp = await fetchWithProxy(avatarUrl);
                    imageBuffer = await resp.arrayBuffer();
                } catch (e) {
                    console.warn('[JanitoraiProvider] Avatar download failed:', e.message);
                }
            }

            return await importFromPng({
                characterCard,
                imageBuffer,
                fileName: `janitorai_${slugify(characterName)}.png`,
                characterName,
                hasGallery: false,
                providerCharId: charId,
                fullPath: charId,
                avatarUrl: avatarUrl || null,
                api,
            });
        } catch (error) {
            console.error(`[JanitoraiProvider] importCharacter failed for ${identifier}:`, error);
            return { success: false, error: error.message };
        }
    }


    getSettings() {
        return [];
    }


    get supportsBulkLink() { return true; }

    // creator arg is intentionally ignored; caller re-ranks results by content.
    async searchForBulkLink(name, creator) {
        try {
            const { characters } = await fetchJanitoraiCharacters({
                search: name,
                sort: 'relevance',
                page: 1,
                mode: CoreAPI.getSetting('janitoraiNsfw') === true ? 'all' : 'sfw',
            });
            return characters.slice(0, 15).map(hit => ({
                id: hit.character_id,
                fullPath: String(hit.character_id || ''),
                name: hit.name || 'Unnamed',
                avatarUrl: resolveJanitoraiAvatarUrl(hit, { width: 150 }) || '',
                rating: 0,
                starCount: hit.chat_count || 0,
                description: hit.description || '',
                rawDescription: hit.description || '',
                tagline: hit.description || '',
                nTokens: hit.total_tokens || 0,
                creator: hit.creator_name || '',
                slug: slugify(hit.name || ''),
            }));
        } catch (e) {
            console.error('[JanitoraiProvider] searchForBulkLink error:', e);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        return result.avatarUrl || '';
    }
}

const janitoraiProvider = new JanitoraiProvider();
export default janitoraiProvider;

export { JANITORAI_SITE_BASE };
