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

let _cachedToken = JANNY_FALLBACK_TOKEN;

/**
 * Return the known public MeiliSearch token without scraping JannyAI pages on
 * provider boot. The page scrape is Cloudflare-prone and can make SillyTavern
 * log noisy 403 binary bodies even though the fallback search token works.
 */
export async function getSearchToken() {
    return _cachedToken || JANNY_FALLBACK_TOKEN;
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
async function helperJsonGet(path, params = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && String(value) !== '') query.set(key, String(value));
    }
    const suffix = query.toString();
    const resp = await helperRequest(`${path}${suffix ? `?${suffix}` : ''}`);
    const data = await resp.json().catch(() => null);
    if (!resp.ok || data?.cloudflare) {
        const err = new Error(data?.error || (data?.cloudflare ? 'Cloudflare challenge' : `HTTP ${resp.status}`));
        err.status = resp.status;
        err.cloudflare = !!data?.cloudflare;
        err.payload = data;
        throw err;
    }
    return data || {};
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

// /api/bookmark returns [{ characterId, createdAt }], not bare id strings,
// so pull the id out of each entry (tolerating a plain-string shape too).
function bookmarkEntryId(entry) {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') return entry.characterId || entry.character_id || entry.id || '';
    return '';
}

export async function fetchJannyBookmarks(options = {}) {
    try {
        const data = await jannyAccountProxy('GET', '/api/bookmark', undefined, options);
        const bookmarks = data.json?.bookmarks || data.bookmarks || [];
        return Array.isArray(bookmarks) ? bookmarks.map(bookmarkEntryId).filter(Boolean) : [];
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

// cl-helper caps each proxied path at 1024 chars, so a ?ids= query fits only
// ~26 UUIDs before it's rejected as "path not allowed". Chunk conservatively so
// any number of ids works regardless of how many a caller passes.
const JANNY_GET_CHARACTERS_CHUNK = 20;

export async function fetchJannyCharactersByIds(ids, options = {}) {
    const characterIDs = toIdArray(ids);
    if (!characterIDs.length) return [];
    const out = [];
    for (let i = 0; i < characterIDs.length; i += JANNY_GET_CHARACTERS_CHUNK) {
        const chunk = characterIDs.slice(i, i + JANNY_GET_CHARACTERS_CHUNK);
        const path = `/api/get-characters?ids=${encodeURIComponent(chunk.join(','))}`;
        const data = await jannyAccountProxy('GET', path, undefined, options);
        const chars = data.json?.characters || data.characters || [];
        if (Array.isArray(chars)) out.push(...chars);
    }
    return out;
}

export async function fetchJannyCollections(options = {}) {
    const data = await jannyAccountProxy('GET', '/api/collections/mine', undefined, options);
    return data.json?.collections || data.collections || [];
}

export async function fetchJannyPublicCollections({ sort = 'latest', page = 1 } = {}) {
    return helperJsonGet(`${CL_HELPER_PLUGIN_BASE}/janny-public-collections`, { sort, page });
}

export async function fetchJannyPublicCollection(path) {
    return helperJsonGet(`${CL_HELPER_PLUGIN_BASE}/janny-public-collection`, { path });
}

export async function fetchJannyPublicCharactersByIds(ids) {
    const characterIDs = toIdArray(ids);
    if (!characterIDs.length) return [];
    const out = [];
    for (let i = 0; i < characterIDs.length; i += JANNY_GET_CHARACTERS_CHUNK) {
        const chunk = characterIDs.slice(i, i + JANNY_GET_CHARACTERS_CHUNK);
        const data = await helperJsonGet(`${CL_HELPER_PLUGIN_BASE}/janny-public-characters`, { ids: chunk.join(',') });
        if (Array.isArray(data.characters)) out.push(...data.characters);
    }
    return out;
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
export async function updateJannyCollection({ id, name, description = '', isPrivate = true } = {}, options = {}) {
    const body = { id, name, description, isPrivate: isPrivate ? 'yes' : 'no' };
    const data = await jannyAccountProxy('POST', '/collections/form/edit-collection', body, options);
    return { success: true, location: data.location || '' };
}

export async function deleteJannyCollection(id, options = {}) {
    const data = await jannyAccountProxy('POST', '/collections/form/delete-collection', { id }, options);
    return { success: true, location: data.location || '' };
}