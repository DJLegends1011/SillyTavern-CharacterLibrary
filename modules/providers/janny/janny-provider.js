// JannyAI Provider - implementation for JanitorAI/JannyAI character source
//
// Uses MeiliSearch API for character search and browser hydration for full definitions.
// No version history (no Git-like API). No gallery support.

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { assignGalleryId, importFromPng } from '../provider-utils.js';
import jannyBrowseView from './janny-browse.js';
import {
    initJannyBrowserClient, jannyBrowserFetch, jannyBrowserSetSession,
    jannyBrowserSessionStatus, jannyBrowserRefreshSession, jannyBrowserLogout,
} from './janny-browser.js';
import { initJannySession, setJannySessionBrowserHooks } from './janny-session.js';
import {
    JANNY_IMAGE_BASE,
    meiliMultiSearch,
    fetchWithProxy,
    slugify,
    stripHtml,
    resolveTagNames,
} from './janny-api.js';

let api = null;

// Hosts JannyAI serves character art from. Anything the hydrated page hands us that is not
// one of these is not fetched: the props are page-supplied, so an arbitrary URL there would
// otherwise become an outbound request from the user's server on import.
const JANNY_IMAGE_HOSTS = new Set(['image.jannyai.com', 'jannyai.com', 'www.jannyai.com']);

/**
 * @param {unknown} value - candidate avatar URL out of the hydrated island props
 * @returns {boolean} true when it is an absolute https URL on a JannyAI image host
 */
export function isJannyImageUrl(value) {
    if (typeof value !== 'string' || !value) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && JANNY_IMAGE_HOSTS.has(url.hostname.toLowerCase());
    } catch { return false; }
}

// ========================================
// API FUNCTIONS
// ========================================

/**
 * Search JannyAI characters via MeiliSearch.
 * @param {Object} opts
 * @param {string} [opts.search='']
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=40]
 * @returns {Promise<Object>} MeiliSearch multi-search response
 */
async function searchJanny(opts = {}) {
    const { search = '', page = 1, limit = 40 } = opts;

    // Browse view ceiling is 100000 (janny-browse.js:65-66); 4101 was an old default that excluded heavy cards from fetchLinkStats / buildPreviewObject / searchForBulkLink.
    return meiliMultiSearch({
        search,
        page,
        limit,
        filters: ['totalToken >= 29'],
        facets: ['isLowQuality', 'tagIds', 'totalToken'],
        sort: ['createdAtStamp:desc'],
        highlight: true,
    });
}

/**
 * Full definitions come only from the browser's hydrated CharacterButtons island.
 * Validate again at the helper boundary before preview, diff, or import can use it.
 */
async function fetchCharacterDetails(characterId, slug) {
    const path = `/characters/${characterId}_${slug || 'character'}`;
    const result = await jannyBrowserFetch(path, { method: 'GET', inspectCharacterId: characterId });
    const hydrated = result.hydratedCharacter;
    const character = hydrated?.character;
    const hasText = value => typeof value === 'string' && value.trim().length > 0;
    if (!character || String(character.id) !== String(characterId)
        || !hasText(character.firstMessage)
        || ![character.personality, character.scenario, character.exampleDialogs].every(value => value == null || typeof value === 'string')
        || ![character.personality, character.scenario, character.exampleDialogs].some(hasText)) {
        const error = new Error('JannyAI loaded, but its character payload shape changed');
        error.code = 'JANNY_PAGE_SHAPE_CHANGED';
        throw error;
    }
    return hydrated;
}

/**
 * Map a complete hydrated character to a V2 card for import/diff.
 * JannyAI field mapping:
 *   - "personality" → V2 "description" (main character definition)
 *   - "description" → website blurb → V2 "creator_notes"
 *   - "firstMessage" → V2 "first_mes"
 *   - "exampleDialogs" → V2 "mes_example"
 *   - "scenario" → V2 "scenario"
 */
function buildV2FromDetails(charData) {
    const char = charData.character || charData;
    const rawDesc = char.description || '';

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: char.name || 'Unnamed',
            description: char.personality || '',
            personality: '',
            scenario: char.scenario || '',
            first_mes: char.firstMessage || '',
            mes_example: char.exampleDialogs || '',
            system_prompt: '',
            post_history_instructions: '',
            creator_notes: rawDesc,
            creator: char.creatorUsername || char.creatorId || '',
            character_version: '1.0',
            tags: resolveTagNames(char.tagIds),
            alternate_greetings: [],
            extensions: {
                jannyai: {
                    id: char.id,
                    creatorId: char.creatorId || null
                }
            },
            character_book: undefined
        }
    };
}

// ========================================
// PROVIDER CLASS
// ========================================

class JannyProvider extends ProviderBase {
    // ── Identity ────────────────────────────────────────────

    get id() { return 'jannyai'; }
    get name() { return 'JannyAI'; }
    get icon() { return 'fa-solid fa-broom'; }
    get iconUrl() { return 'https://tse3.mm.bing.net/th/id/OIP.nb-qi0od9W6zRsskVwL6QAHaHa?rs=1&pid=ImgDetMain&o=7&rm=3'; }
    get browseView() { return jannyBrowseView; }
    get minClHelperVersion() { return '1.13.1'; }

    get linkStatFields() {
        return {
            stat1: null,
            stat2: null,
            stat3: { icon: 'fa-solid fa-coins', label: 'Tokens' },
        };
    }

    // ── Lifecycle ───────────────────────────────────────────

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
        initJannyBrowserClient();
        setJannySessionBrowserHooks({
            setSession: jannyBrowserSetSession,
            status: jannyBrowserSessionStatus,
            refresh: jannyBrowserRefreshSession,
            logout: jannyBrowserLogout,
        });
        initJannySession();
    }

    // ── View ────────────────────────────────────────────────

    get hasView() { return true; }

    renderFilterBar() { return jannyBrowseView.renderFilterBar(); }
    renderView() { return jannyBrowseView.renderView(); }
    renderModals() { return jannyBrowseView.renderModals(); }

    async activate(container, options = {}) {
        jannyBrowseView.activate(container, options);
    }

    deactivate() {
        jannyBrowseView.deactivate();
    }

    // ── Character Linking ───────────────────────────────────

    getLinkInfo(char) {
        if (!char) return null;
        const extensions = char.data?.extensions || char.extensions;
        const janny = extensions?.jannyai;
        if (!janny) return null;

        const id = janny.id;
        if (!id) return null;

        return {
            providerId: 'jannyai',
            id,
            fullPath: janny.slug ? `${id}_${janny.slug}` : String(id),
            linkedAt: janny.linkedAt || null
        };
    }

    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};

        if (linkInfo) {
            const existing = char.data.extensions.jannyai || {};
            char.data.extensions.jannyai = {
                id: linkInfo.id,
                slug: linkInfo.slug || null,
                linkedAt: linkInfo.linkedAt || new Date().toISOString(),
                pageName: linkInfo.pageName || existing.pageName || null,
            };
        } else {
            delete char.data.extensions.jannyai;
        }
    }

    // ── Link Stats ───────────────────────────────────────────

    async fetchLinkStats(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            // Derive a search term from the slug portion of fullPath
            const parts = String(linkInfo.fullPath || '').split('_');
            const slugPart = parts.slice(1).join('_').replace(/^character-/, '');
            const searchName = slugPart.replace(/-/g, ' ').trim();
            if (!searchName) return null;

            const data = await searchJanny({ search: searchName, page: 1, limit: 20 });
            const hits = data?.results?.[0]?.hits || [];
            const match = hits.find(h => h.id === linkInfo.id);
            if (!match) return null;

            return {
                stat1: null,
                stat2: null,
                stat3: match.totalToken || 0
            };
        } catch (e) {
            api?.debugLog?.('[JannyProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    // ── Remote Data ─────────────────────────────────────────

    async fetchMetadata(fullPath) {
        if (!fullPath) return null;
        try {
            const parts = String(fullPath).split('_');
            const charId = parts[0];
            const slug = parts.slice(1).join('_') || 'character';
            const data = await fetchCharacterDetails(charId, slug);
            return data?.character || null;
        } catch (e) {
            if (e?.code?.startsWith('JANNY_')) throw e;
            console.error('[JannyProvider] fetchMetadata failed:', fullPath, e);
            return null;
        }
    }

    async fetchRemoteCard(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const slug = linkInfo.slug || slugify(linkInfo.name || '');
            const data = await fetchCharacterDetails(linkInfo.id, slug);
            if (data) {
                const result = buildV2FromDetails(data);
                if (result) result._listingName = this.getListingName(data.character);
                return result;
            }
            return null;
        } catch (e) {
            if (e?.code?.startsWith('JANNY_')) throw e;
            console.error('[JannyProvider] fetchRemoteCard failed:', linkInfo.id, e);
            return null;
        }
    }

    normalizeRemoteCard(rawData) {
        return buildV2FromDetails(rawData);
    }

    // ── Update Checking ─────────────────────────────────────

    getComparableFields() {
        return [
            {
                path: 'extensions.jannyai.tagline',
                label: 'Tagline',
                icon: 'fa-solid fa-quote-left',
                optional: true,
                group: 'tagline',
                groupLabel: 'Tagline'
            }
        ];
    }

    // ── Version History ─────────────────────────────────────

    // JannyAI has no public version/commit history API
    get supportsVersionHistory() { return false; }

    // ── Character URL / Link UI ─────────────────────────────

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.fullPath) return null;
        return `https://jannyai.com/characters/${linkInfo.fullPath}`;
    }

    openLinkUI(char) {
        CoreAPI.openProviderLinkModal?.(char);
    }

    // ── In-App Preview ───────────────────────────────────────

    get supportsInAppPreview() { return true; }

    async buildPreviewObject(char, linkInfo) {
        const charId = linkInfo?.id;
        if (!charId) return null;

        // Derive a search term from the slug to find this character remotely
        const parts = String(linkInfo.fullPath || '').split('_');
        const slugPart = parts.slice(1).join('_').replace(/^character-/, '');
        const searchName = slugPart.replace(/-/g, ' ').trim() || char?.name || '';
        if (!searchName) return null;

        try {
            const data = await searchJanny({ search: searchName, page: 1, limit: 20 });
            const hits = data?.results?.[0]?.hits || [];
            const match = hits.find(h => h.id === charId);
            if (match) return match;
        } catch (e) {
            console.warn('[JannyProvider] buildPreviewObject search failed:', e.message);
        }

        // Fallback to local data if remote fetch failed
        const jannyData = char?.data?.extensions?.jannyai || {};
        return {
            id: charId,
            name: char?.name || 'Unknown',
            description: char?.data?.description || '',
            avatar: jannyData.avatar || '',
            tagIds: jannyData.tagIds || [],
            totalToken: jannyData.totalToken || char?.data?.extensions?.total_tokens || 0,
            createdAtStamp: jannyData.createdAtStamp || 0,
            creatorId: jannyData.creatorId || char?.data?.creator || ''
        };
    }

    openPreview(previewChar) {
        window.openJannyCharPreview?.(previewChar);
    }

    // ── Local Import Enrichment ──────────────────────────────

    async enrichLocalImport(cardData, _fileName) {
        const ext = cardData.data?.extensions?.jannyai;

        // Card already has Janny metadata (previously imported via our app)
        if (ext?.id) {
            return {
                cardData,
                providerInfo: {
                    providerId: 'jannyai',
                    charId: ext.id,
                    fullPath: ext.slug ? `${ext.id}_${ext.slug}` : String(ext.id),
                    hasGallery: false,
                    avatarUrl: null
                }
            };
        }

        // No Janny extensions, try to find this character on JannyAI
        const name = cardData.data?.name;
        if (!name) return null;

        try {
            const creator = cardData.data?.creator || '';
            const results = await this.searchForBulkLink(name, creator);
            if (results.length === 0) return null;

            // Require exact name match
            const normalizedName = name.toLowerCase().trim();
            const match = results.find(r => (r.name || '').toLowerCase().trim() === normalizedName);
            if (!match) return null;

            // Fetch full details for verification + tagline/listing-name enrichment
            const parts = match.fullPath.split('_');
            const charId = parts[0];
            const slug = parts.slice(1).join('_') || 'character';

            const data = await fetchCharacterDetails(charId, slug);
            if (!data?.character) return null;

            const char = data.character;

            // Strict creator verification: require both sides to have a creator
            // and require an exact (case-insensitive) match. Names alone are far too
            // ambiguous ("Akari" exists on Janny dozens of times). Local cards may
            // store creator as a URL, in which case auto-linking is unsafe; skip.
            const localCreator = creator.trim();
            const remoteCreator = (char.creatorUsername || '').trim();
            if (!localCreator || !remoteCreator) return null;
            if (localCreator.toLowerCase() !== remoteCreator.toLowerCase()) return null;

            // Build the metadata block but do NOT touch any descriptive field.
            // The user's local PNG is the source of truth for description, scenario,
            // first_mes, alternate_greetings, etc. Replacing those would silently
            // overwrite the user's card with a same-named character's data.
            if (!cardData.data.extensions) cardData.data.extensions = {};
            cardData.data.extensions.jannyai = {
                ...(cardData.data.extensions.jannyai || {}),
                id: charId,
                creatorId: char.creatorId || null,
                creatorUsername: char.creatorUsername || null,
                slug,
                linkedAt: new Date().toISOString(),
                pageName: this.getListingName(char),
            };

            return {
                cardData,
                providerInfo: {
                    providerId: 'jannyai',
                    charId,
                    fullPath: match.fullPath,
                    hasGallery: false,
                    avatarUrl: null
                }
            };
        } catch (e) {
            console.warn('[JannyProvider] enrichLocalImport failed:', e.message);
            return null;
        }
    }

    // ── Authentication ──────────────────────────────────────

    // JannyAI MeiliSearch uses a public key, no user auth needed
    get hasAuth() { return false; }

    getAuthHeaders() { return {}; }

    // ── URL Handling ────────────────────────────────────────

    canHandleUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            return /^(www\.)?jannyai\.com$/i.test(u.hostname)
                || /^(www\.)?janitorai\.com$/i.test(u.hostname);
        } catch {
            return false;
        }
    }

    parseUrl(url) {
        if (!url) return null;
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            // Path: /characters/{uuid}_{slug}
            const match = u.pathname.match(/\/characters\/([a-f0-9-]+(?:_[^/]*)?)/i);
            if (match) return match[1];
        } catch { /* ignore */ }
        return null;
    }

    // ── Import Pipeline ─────────────────────────────────────

    get supportsImport() { return true; }

    /**
     * Import a character from JannyAI.
     * @param {string} identifier - e.g. "uuid_slug"
     * @param {Object} [hitData] - Optional listing metadata; never a definition source.
     */
    async importCharacter(identifier, hitData, options = {}) {
        try {
            const parts = String(identifier).split('_');
            const charId = parts[0];
            const slug = parts.slice(1).join('_') || 'character';

            const data = await fetchCharacterDetails(charId, slug);

            const char = data.character;
            const characterName = char.name || 'Unnamed';

            // Listing metadata can only supplement a complete, identity-checked definition.
            if (hitData && String(hitData.id) === String(charId)) {
                if (!char.tagIds?.length && hitData.tagIds) char.tagIds = hitData.tagIds;
                if (!char.creatorId && hitData.creatorId) char.creatorId = hitData.creatorId;
            }
            // Hydrated props may lack tagIds/creatorId - backfill from MeiliSearch
            if (!char.tagIds?.length || !char.creatorId) {
                try {
                    const searchData = await searchJanny({ search: char.name || '', page: 1, limit: 20 });
                    const hits = searchData?.results?.[0]?.hits || [];
                    const match = hits.find(h => h.id === charId);
                    if (match) {
                        if (!char.tagIds?.length && match.tagIds) char.tagIds = match.tagIds;
                        if (!char.creatorId && match.creatorId) char.creatorId = match.creatorId;
                    }
                } catch (e) {
                    console.warn('[JannyProvider] MeiliSearch backfill failed:', e.message);
                }
            }

            const characterCard = buildV2FromDetails(data);

            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            const existingJanny = characterCard.data.extensions.jannyai || {};
            characterCard.data.extensions.jannyai = {
                ...existingJanny,
                id: charId,
                creatorId: char.creatorId || null,
                creatorUsername: char.creatorUsername || null,
                slug: slug,
                linkedAt: new Date().toISOString(),
                pageName: this.getListingName(char),
            };

            // Gallery ID: inherit from replaced character, or generate new
            assignGalleryId(characterCard, options, api);

            // Download avatar. data.imageUrl is decoded out of the page's hydrated island props,
            // so it is page-supplied: keep it on JannyAI's own image hosts before fetching it,
            // and otherwise fall back to the avatar path we build ourselves.
            const fallbackAvatarUrl = char.avatar ? `${JANNY_IMAGE_BASE}${char.avatar}` : null;
            const avatarUrl = isJannyImageUrl(data.imageUrl) ? data.imageUrl : fallbackAvatarUrl;
            let imageBuffer = null;

            if (avatarUrl) {
                try {
                    const resp = await fetchWithProxy(avatarUrl);
                    imageBuffer = await resp.arrayBuffer();
                } catch (e) {
                    console.warn('[JannyProvider] Avatar download failed:', e.message);
                }
            }

            return await importFromPng({
                characterCard, imageBuffer,
                fileName: `janny_${slugify(characterName)}.png`,
                characterName, hasGallery: false,
                providerCharId: charId,
                fullPath: identifier,
                avatarUrl: avatarUrl || null,
                api
            });
        } catch (error) {
            if (error?.code?.startsWith('JANNY_')) throw error;
            console.error(`[JannyProvider] importCharacter failed for ${identifier}:`, error);
            return { success: false, error: error.message };
        }
    }

    // ── Settings ────────────────────────────────────────────

    getSettings() {
        // JannyAI needs no user-configurable settings for now.
        // The MeiliSearch token is fetched automatically.
        return [];
    }

    // ── Bulk Linking ────────────────────────────────────────

    get supportsBulkLink() { return true; }

    openBulkLinkUI() {
        CoreAPI.openBulkAutoLinkModal?.();
    }

    /**
     * Search JannyAI for characters matching a local character's name.
     * JannyAI doesn't expose creator names in search results, so matching
     * relies on name similarity and token counts.
     */
    async searchForBulkLink(name, creator) {
        try {
            // JannyAI has no creator filter - search by name only
            const searchTerm = name;
            const data = await searchJanny({ search: searchTerm, page: 1, limit: 15 });
            const hits = data?.results?.[0]?.hits || [];

            return hits.map(hit => this._normalizeSearchResult(hit));
        } catch (e) {
            console.error('[JannyProvider] searchForBulkLink error:', e);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        return result.avatarUrl || '';
    }

    // ── Private Helpers ─────────────────────────────────────

    _normalizeSearchResult(hit) {
        const slug = slugify(hit.name);
        const plainDesc = stripHtml(hit.description) || '';
        return {
            id: hit.id || null,
            fullPath: hit.id ? `${hit.id}_character-${slug}` : '',
            name: hit.name || 'Unnamed',
            avatarUrl: hit.avatar ? `${JANNY_IMAGE_BASE}${hit.avatar}` : '',
            rating: 0,
            starCount: 0,
            description: plainDesc,
            rawDescription: hit.description || '',
            tagline: plainDesc,
            nTokens: hit.totalToken || 0,
            slug
        };
    }
}

const jannyProvider = new JannyProvider();
export default jannyProvider;
