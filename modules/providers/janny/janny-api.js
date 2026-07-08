// Shared JannyAI API utilities - used by both janny-provider.js and janny-browse.js
//
// Contains constants, tag mapping, MeiliSearch token management,
// proxy fetch helpers, and text utilities.

// ========================================
// CONSTANTS
// ========================================

export const JANNY_SEARCH_URL = 'https://search.jannyai.com/multi-search';
export const JANNY_IMAGE_BASE = 'https://image.jannyai.com/bot-avatars/';
export const JANNY_SITE_BASE = 'https://jannyai.com';
export const JANNY_FALLBACK_TOKEN = '88a6463b66e04fb07ba87ee3db06af337f492ce511d93df6e2d2968cb2ff2b30';

// Tag ID → name mapping (JannyAI uses numeric IDs internally)
export const TAG_MAP = {
    1: 'Male', 2: 'Female', 3: 'Non-binary', 4: 'Celebrity', 5: 'OC',
    6: 'Fictional', 7: 'Real', 8: 'Game', 9: 'Anime', 10: 'Historical',
    11: 'Royalty', 12: 'Detective', 13: 'Hero', 14: 'Villain', 15: 'Magical',
    16: 'Non-human', 17: 'Monster', 18: 'Monster Girl', 19: 'Alien', 20: 'Robot',
    21: 'Politics', 22: 'Vampire', 23: 'Giant', 24: 'OpenAI', 25: 'Elf',
    26: 'Multiple', 27: 'VTuber', 28: 'Dominant', 29: 'Submissive', 30: 'Scenario',
    31: 'Pokemon', 32: 'Assistant', 34: 'Non-English', 36: 'Philosophy',
    38: 'RPG', 39: 'Religion', 41: 'Books', 42: 'AnyPOV', 43: 'Angst',
    44: 'Demi-Human', 45: 'Enemies to Lovers', 46: 'Smut', 47: 'MLM',
    48: 'WLW', 49: 'Action', 50: 'Romance', 51: 'Horror', 52: 'Slice of Life',
    53: 'Fantasy', 54: 'Drama', 55: 'Comedy', 56: 'Mystery', 57: 'Sci-Fi',
    59: 'Yandere', 60: 'Furry', 61: 'Movies/TV'
};

// ========================================
// TOKEN MANAGEMENT
// ========================================

let _cachedToken = null;
let _tokenFetchPromise = null;

/**
 * Fetch the MeiliSearch API key from JannyAI's client config JS bundle.
 * Falls back to a known hardcoded key if scraping fails.
 * Token is cached across calls (shared between provider and browse view).
 */
export async function getSearchToken() {
    if (_cachedToken) return _cachedToken;
    if (_tokenFetchPromise) return _tokenFetchPromise;

    _tokenFetchPromise = (async () => {
        try {
            const pageResp = await fetchWithProxy(`${JANNY_SITE_BASE}/characters/search`);
            const html = await pageResp.text();

            let configPath = null;
            const configMatch = html.match(/client-config\.[a-zA-Z0-9_-]+\.js/);
            if (configMatch) {
                configPath = '/_astro/' + configMatch[0];
            } else {
                const spMatch = html.match(/SearchPage\.[a-zA-Z0-9_-]+\.js/);
                if (spMatch) {
                    const spResp = await fetchWithProxy(`${JANNY_SITE_BASE}/_astro/${spMatch[0]}`);
                    if (spResp.ok) {
                        const spJs = await spResp.text();
                        const impMatch = spJs.match(/client-config\.[a-zA-Z0-9_-]+\.js/);
                        if (impMatch) configPath = '/_astro/' + impMatch[0];
                    }
                }
            }

            if (configPath) {
                const cfgResp = await fetchWithProxy(`${JANNY_SITE_BASE}${configPath}`);
                if (cfgResp.ok) {
                    const cfgJs = await cfgResp.text();
                    const tokenMatch = cfgJs.match(/"([a-f0-9]{64})"/);
                    if (tokenMatch) {
                        _cachedToken = tokenMatch[1];
                        return _cachedToken;
                    }
                }
            }

            throw new Error('Could not extract MeiliSearch token');
        } catch (e) {
            console.warn('[JannyAPI] Token fetch failed, using fallback:', e.message);
            _cachedToken = JANNY_FALLBACK_TOKEN;
            return _cachedToken;
        } finally {
            _tokenFetchPromise = null;
        }
    })();

    return _tokenFetchPromise;
}

// ========================================
// NETWORK & TEXT UTILITIES (shared)
// ========================================

import { CL_HELPER_PLUGIN_BASE, fetchWithProxy } from '../provider-utils.js';
export { fetchWithProxy };
export { slugify, stripHtml } from '../provider-utils.js';

export function resolveTagNames(tagIds) {
    return (tagIds || []).map(id => TAG_MAP[id] || `Tag ${id}`);
}

// ========================================
// ACCOUNT SYNC (bookmarks + collections via cl-helper)
// ========================================

let _apiRequest = null;

export function setJannyApiRequest(fn) { _apiRequest = fn; }

async function helperRequest(path, method = 'GET', data = null) {
    if (_apiRequest) return _apiRequest(path, method, data);
    const opts = { method };
    if (data != null) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(data);
    }
    return fetch(`/api${path}`, opts);
}

export async function checkJannyPluginAvailable() {
    try {
        const resp = await helperRequest(`${CL_HELPER_PLUGIN_BASE}/health`);
        if (!resp.ok) return false;
        const data = await resp.json();
        return data?.ok === true;
    } catch {
        return false;
    }
}

export async function setJannySessionCookie(cookie, userAgent = '') {
    const resp = await helperRequest(`${CL_HELPER_PLUGIN_BASE}/janny-set-cookie`, 'POST', { cookie, userAgent });
    const payload = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error(payload?.error || `HTTP ${resp.status}`);
    return payload;
}

export async function clearJannySession() {
    try {
        const resp = await helperRequest(`${CL_HELPER_PLUGIN_BASE}/janny-clear-session`, 'POST');
        return resp.ok;
    } catch {
        return false;
    }
}

export async function getJannySessionStatus() {
    try {
        const resp = await helperRequest(`${CL_HELPER_PLUGIN_BASE}/janny-session`);
        if (!resp.ok) return { active: false };
        return resp.json();
    } catch {
        return { active: false };
    }
}

function jannyValidatePath(options = {}) {
    const params = new URLSearchParams();
    const flareUrl = options.flareSolverrUrl || options.flareUrl || '';
    if (flareUrl) params.set('flareUrl', flareUrl);
    if (options.flareSessionId) params.set('flareSessionId', options.flareSessionId);
    const query = params.toString();
    return `${CL_HELPER_PLUGIN_BASE}/janny-validate${query ? `?${query}` : ''}`;
}

export async function validateJannySession(options = {}) {
    try {
        const resp = await helperRequest(jannyValidatePath(options));
        const payload = await resp.json().catch(() => null);
        if (!resp.ok) {
            return {
                valid: false,
                cloudflare: !!payload?.cloudflare,
                reason: payload?.reason || payload?.error || `HTTP ${resp.status}`,
            };
        }
        return payload || { valid: false, reason: 'empty response' };
    } catch (err) {
        return { valid: false, reason: err.message };
    }
}

function accountOptions(options = {}) {
    const flareUrl = options.flareSolverrUrl || options.flareUrl || '';
    return {
        flareUrl,
        useFlare: !!flareUrl && options.useFlare !== false,
        flareSessionId: options.flareSessionId || '',
    };
}

async function jannyAccountProxy(method, path, body = undefined, options = {}) {
    const payload = { method, path, ...accountOptions(options) };
    if (body !== undefined) payload.body = body;

    const resp = await helperRequest(`${CL_HELPER_PLUGIN_BASE}/janny-proxy`, 'POST', payload);
    const data = await resp.json().catch(() => null);
    if (!resp.ok || data?.cloudflare) {
        const msg = data?.error || (data?.cloudflare ? 'Cloudflare challenge' : `HTTP ${resp.status}`);
        const err = new Error(msg);
        err.status = resp.status;
        err.cloudflare = !!data?.cloudflare;
        err.payload = data;
        throw err;
    }
    return data || {};
}

function toIdArray(ids) {
    return [...new Set((Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean))];
}

export async function fetchJannyBookmarks(options = {}) {
    try {
        const data = await jannyAccountProxy('GET', '/api/bookmark', undefined, options);
        const bookmarks = data.json?.bookmarks || data.bookmarks || [];
        return Array.isArray(bookmarks) ? bookmarks.map(String) : [];
    } catch (err) {
        if (!err.cloudflare) throw err;
        const data = await jannyAccountProxy('GET', '/bookmark', undefined, options);
        return data.bookmarkPage?.characterIds || [];
    }
}

export async function fetchJannyBookmarkPage(options = {}) {
    const data = await jannyAccountProxy('GET', '/bookmark', undefined, options);
    return data.bookmarkPage || { totalCount: null, characterIds: [], characterUrls: [] };
}

export async function addJannyBookmarks(ids, options = {}) {
    const characterIDs = toIdArray(ids);
    if (!characterIDs.length) return [];
    const data = await jannyAccountProxy('POST', '/api/bookmark', { characterIDs }, options);
    return data.json?.bookmarks || data.bookmarks || [];
}

export async function removeJannyBookmarks(ids, options = {}) {
    const characterIDs = toIdArray(ids);
    if (!characterIDs.length) return [];
    const path = `/api/bookmark?ids=${encodeURIComponent(characterIDs.join(','))}`;
    const data = await jannyAccountProxy('DELETE', path, undefined, options);
    return data.json?.bookmarks || data.bookmarks || [];
}

export async function fetchJannyCharactersByIds(ids, options = {}) {
    const characterIDs = toIdArray(ids);
    if (!characterIDs.length) return [];
    const path = `/api/get-characters?ids=${encodeURIComponent(characterIDs.join(','))}`;
    const data = await jannyAccountProxy('GET', path, undefined, options);
    return data.json?.characters || data.characters || [];
}

export async function fetchJannyCollections(options = {}) {
    const data = await jannyAccountProxy('GET', '/api/collections/mine', undefined, options);
    return data.json?.collections || data.collections || [];
}

export async function fetchJannyCollectionCharacters(collectionId, options = {}) {
    if (!collectionId) return [];
    const data = await jannyAccountProxy('GET', `/api/collections/${collectionId}/characters`, undefined, options);
    return data.json?.characters || data.characters || [];
}

export async function addJannyCharacterToCollection(collectionId, characterId, options = {}) {
    const data = await jannyAccountProxy('POST', `/api/collections/${collectionId}/characters`, { characterId }, options);
    return data.json || data;
}

export async function removeJannyCharacterFromCollection(collectionId, characterId, options = {}) {
    const path = `/api/collections/${collectionId}/characters?characterId=${encodeURIComponent(characterId)}`;
    const data = await jannyAccountProxy('DELETE', path, undefined, options);
    return data.json || data;
}

export async function createJannyCollection({ name, description = '', isPrivate = true } = {}, options = {}) {
    // JannyAI has no JSON create API; it's a server-rendered form POST that
    // answers 302 -> /collections/<id>_<slug>/edit. cl-helper form-encodes the
    // body and surfaces that Location as `location`.
    const body = { name, description, isPrivate: isPrivate ? 'yes' : 'no' };
    let data;
    try {
        data = await jannyAccountProxy('POST', '/collections/form/add-collection', body, options);
    } catch (err) {
        if (err.status === 404 && !err.cloudflare) err.unsupported = true;
        throw err;
    }
    const location = data.location || '';
    const idMatch = location.match(/\/collections\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
    return { success: true, id: idMatch ? idMatch[1] : null, location };
}