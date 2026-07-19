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

import { fetchWithProxy } from '../provider-utils.js';
export { fetchWithProxy };
export { slugify, stripHtml } from '../provider-utils.js';

export function resolveTagNames(tagIds) {
    return (tagIds || []).map(id => TAG_MAP[id] || `Tag ${id}`);
}

// ========================================
// ACCOUNT SYNC (bookmarks + collections via the userscript bridge)
// ========================================
// All jannyai.com account and public-collection requests ride the companion userscript
// (extras/cl-janny-bridge.user.js): GM_xmlhttpRequest carries the browser's own jannyai
// cookies, so Cloudflare passes and being logged into jannyai.com IS the login. No
// cookies are captured, stored, or relayed through cl-helper.

import { isJannyBridgeAvailable, jannyBridgeFetch } from './janny-bridge.js';
import {
    parseJannyPublicCollectionsPage,
    parseJannyPublicCollectionDetailPage,
    validateJannyPublicCollectionPath,
    validateJannyCollectorName,
    detectJannyCloudflareBody,
} from './janny-html.js';

async function jannyBridgeRequest(method, path, { json, form } = {}) {
    if (!isJannyBridgeAvailable()) {
        const err = new Error('JannyAI bridge userscript not detected');
        err.code = 'JANNY_BRIDGE_MISSING';
        throw err;
    }
    let body, contentType;
    if (json !== undefined) { body = JSON.stringify(json); contentType = 'application/json'; }
    if (form !== undefined) { body = new URLSearchParams(form).toString(); contentType = 'application/x-www-form-urlencoded'; }

    const res = await jannyBridgeFetch(method, `${JANNY_SITE_BASE}${path}`, { body, contentType });
    if (!res.ok) {
        const err = new Error(`JannyAI HTTP ${res.status}`);
        err.status = res.status;
        err.cloudflare = detectJannyCloudflareBody(res.status, res.body);
        if (res.status === 401) err.code = 'JANNY_LOGIN_REQUIRED';
        throw err;
    }
    return res;
}

function parseJsonBody(res) {
    try { return JSON.parse(res.body); } catch { return null; }
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

// Reports transport + login state for gating and the Settings panel. Never throws.
export async function probeJannyAccount() {
    if (!isJannyBridgeAvailable()) {
        return { bridge: false, active: false, cloudflare: false, reason: 'JannyAI bridge userscript not detected' };
    }
    try {
        await jannyBridgeRequest('GET', '/api/bookmark');
        return { bridge: true, active: true, cloudflare: false, reason: '' };
    } catch (err) {
        return {
            bridge: true,
            active: false,
            cloudflare: !!err.cloudflare,
            reason: err.code === 'JANNY_LOGIN_REQUIRED' ? 'Not logged into jannyai.com in this browser' : err.message,
        };
    }
}

export async function fetchJannyBookmarks() {
    const data = parseJsonBody(await jannyBridgeRequest('GET', '/api/bookmark'));
    const bookmarks = data?.bookmarks || [];
    return Array.isArray(bookmarks) ? bookmarks.map(bookmarkEntryId).filter(Boolean) : [];
}

export async function addJannyBookmarks(ids) {
    const characterIDs = toIdArray(ids);
    if (!characterIDs.length) return [];
    const data = parseJsonBody(await jannyBridgeRequest('POST', '/api/bookmark', { json: { characterIDs } }));
    return data?.bookmarks || [];
}

export async function removeJannyBookmarks(ids) {
    const characterIDs = toIdArray(ids);
    if (!characterIDs.length) return [];
    const data = parseJsonBody(await jannyBridgeRequest('DELETE', `/api/bookmark?ids=${encodeURIComponent(characterIDs.join(','))}`));
    return data?.bookmarks || [];
}

// Keep ?ids= URLs comfortably short regardless of how many ids a caller passes.
const JANNY_GET_CHARACTERS_CHUNK = 20;

export async function fetchJannyCharactersByIds(ids) {
    const characterIDs = toIdArray(ids);
    if (!characterIDs.length) return [];
    const out = [];
    for (let i = 0; i < characterIDs.length; i += JANNY_GET_CHARACTERS_CHUNK) {
        const chunk = characterIDs.slice(i, i + JANNY_GET_CHARACTERS_CHUNK);
        const data = parseJsonBody(await jannyBridgeRequest('GET', `/api/get-characters?ids=${encodeURIComponent(chunk.join(','))}`));
        const chars = data?.characters || [];
        if (Array.isArray(chars)) out.push(...chars);
    }
    return out;
}

// /api/get-characters is public; with the bridge there is no separate anonymous path.
export const fetchJannyPublicCharactersByIds = fetchJannyCharactersByIds;

export async function fetchJannyCollections() {
    const data = parseJsonBody(await jannyBridgeRequest('GET', '/api/collections/mine'));
    return data?.collections || [];
}

export async function fetchJannyCollectionCharacters(collectionId) {
    if (!collectionId) return [];
    const data = parseJsonBody(await jannyBridgeRequest('GET', `/api/collections/${collectionId}/characters`));
    return data?.characters || [];
}

export async function addJannyCharacterToCollection(collectionId, characterId) {
    const res = await jannyBridgeRequest('POST', `/api/collections/${collectionId}/characters`, { json: { characterId } });
    return parseJsonBody(res) || {};
}

export async function removeJannyCharacterFromCollection(collectionId, characterId) {
    const res = await jannyBridgeRequest('DELETE', `/api/collections/${collectionId}/characters?characterId=${encodeURIComponent(characterId)}`);
    return parseJsonBody(res) || {};
}

// Collection create/edit/delete are server-rendered Astro form POSTs
// (application/x-www-form-urlencoded). Success answers 302; the userscript manager
// follows the redirect, so the created collection's id is read from finalUrl.
export async function createJannyCollection({ name, description = '', isPrivate = true } = {}) {
    const res = await jannyBridgeRequest('POST', '/collections/form/add-collection', {
        form: { name, description, isPrivate: isPrivate ? 'yes' : 'no' },
    });
    const location = res.finalUrl || '';
    const idMatch = location.match(/\/collections\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
    return { success: true, id: idMatch ? idMatch[1] : null, location };
}

export async function updateJannyCollection({ id, name, description = '', isPrivate = true } = {}) {
    const res = await jannyBridgeRequest('POST', '/collections/form/edit-collection', {
        form: { id, name, description, isPrivate: isPrivate ? 'yes' : 'no' },
    });
    return { success: true, location: res.finalUrl || '' };
}

export async function deleteJannyCollection(id) {
    const res = await jannyBridgeRequest('POST', '/collections/form/delete-collection', { form: { id } });
    return { success: true, location: res.finalUrl || '' };
}

// ========================================
// PUBLIC COLLECTIONS (HTML pages via the bridge, parsed client-side)
// ========================================

export async function fetchJannyPublicCollections({ sort = 'latest', page = 1 } = {}) {
    const params = new URLSearchParams({ sort: String(sort), page: String(page) });
    const res = await jannyBridgeRequest('GET', `/collections?${params}`);
    return { ok: true, status: res.status, ...parseJannyPublicCollectionsPage(res.body) };
}

export async function fetchJannyCollectorCollections(name) {
    const validation = validateJannyCollectorName(name);
    if (!validation.ok) throw new Error(validation.error);
    const res = await jannyBridgeRequest('GET', `/collectors/${encodeURIComponent(validation.name)}`);
    return { ok: true, status: res.status, ...parseJannyPublicCollectionsPage(res.body) };
}

export async function fetchJannyPublicCollection(path) {
    const validation = validateJannyPublicCollectionPath(path);
    if (!validation.ok) throw new Error(validation.error);
    const res = await jannyBridgeRequest('GET', validation.path);
    return { ok: true, status: res.status, ...parseJannyPublicCollectionDetailPage(res.body, validation.path) };
}