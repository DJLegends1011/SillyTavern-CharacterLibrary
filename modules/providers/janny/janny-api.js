// Shared JannyAI API utilities - used by both janny-provider.js and janny-browse.js
//
// Contains constants, tag mapping, MeiliSearch token management,
// proxy fetch helpers, and text utilities.

// ========================================
// CONSTANTS
// ========================================

const JANNY_SEARCH_URL = 'https://search.jannyai.com/multi-search';
export const JANNY_IMAGE_BASE = 'https://image.jannyai.com/bot-avatars/';
export const JANNY_SITE_BASE = 'https://jannyai.com';
const JANNY_FALLBACK_TOKEN = '88a6463b66e04fb07ba87ee3db06af337f492ce511d93df6e2d2968cb2ff2b30';

// Tag ID -> name mapping (JannyAI uses numeric IDs internally)
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
async function getSearchToken() {
    return _cachedToken || JANNY_FALLBACK_TOKEN;
}

// ========================================
// NETWORK & TEXT UTILITIES (shared)
// ========================================

import { fetchWithProxy, readJsonClassified } from '../provider-utils.js';
export { fetchWithProxy };
export { slugify, stripHtml } from '../provider-utils.js';

/**
 * One JannyAI MeiliSearch multi-search request. Callers own their filters, facets and
 * sort; the envelope, auth headers, direct-then-proxy fallback and classified read are
 * shared (the browse view, the provider's lookups, DataCat's Janny sorts and the Creator
 * Downloads adapter all query the same index and drifted into four copies of this before).
 * @param {Object} opts
 * @param {string} [opts.search] - q
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=80] - hitsPerPage
 * @param {string[]} [opts.filters] - MeiliSearch filter expressions
 * @param {string[]} [opts.facets]
 * @param {string[]} [opts.sort] - empty for relevance
 * @param {boolean} [opts.highlight] - add the crop/highlight attributes the browse grids render
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Object>} raw multi-search response ({ results: [...] })
 */
export async function meiliMultiSearch({ search = '', page = 1, limit = 80, filters = [], facets = [], sort = [], highlight = false, signal } = {}) {
    const query = {
        indexUid: 'janny-characters',
        q: search,
        filter: filters,
        hitsPerPage: limit,
        page,
    };
    if (facets.length) query.facets = facets;
    if (highlight) {
        query.attributesToCrop = ['description:300'];
        query.cropMarker = '...';
        query.attributesToHighlight = ['name', 'description'];
        query.highlightPreTag = '__ais-highlight__';
        query.highlightPostTag = '__/ais-highlight__';
    }
    if (sort.length) query.sort = sort;

    const token = await getSearchToken();
    const headers = {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': JANNY_SITE_BASE,
        'Referer': `${JANNY_SITE_BASE}/`,
        'x-meilisearch-client': 'Meilisearch instant-meilisearch (v0.19.0) ; Meilisearch JavaScript (v0.41.0)',
    };

    const body = JSON.stringify({ queries: [query] });
    const requestInit = { method: 'POST', headers, body, signal };
    let response;
    try {
        response = await fetch(JANNY_SEARCH_URL, requestInit);
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        response = await fetchWithProxy(JANNY_SEARCH_URL, requestInit);
    }
    return readJsonClassified(response);
}

export function resolveTagNames(tagIds) {
    return (tagIds || []).map(id => TAG_MAP[id] || `Tag ${id}`);
}

// ========================================
// ACCOUNT SYNC (bookmarks + collections via the shared browser)
// ========================================
// The persistent browser profile owns authentication and Cloudflare cookies.
import { jannyBrowserFetch } from './janny-browser.js';
import { jannyRecoverSession, jannySessionStatus } from './janny-session.js';
import {
    parseJannyPublicCollectionsPage,
    parseJannyPublicCollectionDetailPage,
    validateJannyPublicCollectionPath,
    validateJannyCollectorName,
    detectJannyCloudflareBody,
} from './janny-html.js';

function createJannyResponseError(code, status = 0) {
    const error = new Error(code === 'JANNY_CF_BLOCKED'
        ? 'JannyAI is blocked by a Cloudflare challenge.'
        : 'JannyAI login is required.');
    error.code = code;
    error.status = status;
    error.cloudflare = code === 'JANNY_CF_BLOCKED';
    return error;
}

function finishJannyBrowserResponse(result) {
    // JSON fields can contain arbitrary character text, including HTML examples.
    const isHtml = /^\s*</.test(result.body || '');
    if (isHtml && detectJannyCloudflareBody(result.status, result.body)) {
        throw createJannyResponseError('JANNY_CF_BLOCKED', result.status);
    }
    let finalPath = '';
    try { finalPath = new URL(result.finalUrl, JANNY_SITE_BASE).pathname; } catch { /* no final URL */ }
    const loginRedirect = /^\/(?:auth\/)?(?:login|log-in|signin|sign-in)(?:\/|$)/i.test(finalPath);
    const loginPage = /<title[^>]*>\s*(?:log\s*in|sign\s*in)(?:\s|[|:<-])/i.test(result.body || '');
    if (loginRedirect || (isHtml && loginPage)) {
        throw createJannyResponseError('JANNY_LOGIN_REQUIRED', result.status);
    }
    return result;
}

async function jannyBrowserRequest(method, path, { jsonBody, formBody } = {}) {
    const options = { method, jsonBody, formBody };
    let result;
    try {
        result = await jannyBrowserFetch(path, options);
    } catch (error) {
        // The browser client throws classified HTTP errors rather than returning a 401.
        // Recover only an unauthorized account response, never a transport/policy failure.
        if (error.code !== 'JANNY_LOGIN_REQUIRED' || error.status !== 401) throw error;
        const recovered = await jannyRecoverSession();
        if (!recovered.active) throw error;
        result = await jannyBrowserFetch(path, options);
    }
    // Empty 2xx bodies are valid after browser-followed collection form redirects.
    return finishJannyBrowserResponse(result);
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
    let browser = false;
    try {
        const status = await jannySessionStatus();
        browser = true;
        if (!status.active) {
            return { browser, active: false, cloudflare: false, reason: 'JannyAI login is required.', code: 'JANNY_LOGIN_REQUIRED' };
        }
        await jannyBrowserRequest('GET', '/api/bookmark');
        return { browser, active: true, cloudflare: false, reason: '', code: '' };
    } catch (error) {
        const code = error.code || 'JANNY_HTTP_ERROR';
        if (code === 'JANNY_HELPER_UNAVAILABLE' || code === 'JANNY_BROWSER_UNAVAILABLE') browser = false;
        return {
            browser,
            active: false,
            cloudflare: code === 'JANNY_CF_BLOCKED',
            reason: error.message,
            code,
        };
    }
}

export async function fetchJannyBookmarks() {
    const data = parseJsonBody(await jannyBrowserRequest('GET', '/api/bookmark'));
    const bookmarks = data?.bookmarks || [];
    return Array.isArray(bookmarks) ? bookmarks.map(bookmarkEntryId).filter(Boolean) : [];
}

export async function addJannyBookmarks(ids) {
    const characterIDs = toIdArray(ids);
    if (!characterIDs.length) return [];
    const data = parseJsonBody(await jannyBrowserRequest('POST', '/api/bookmark', { jsonBody: { characterIDs } }));
    return data?.bookmarks || [];
}

export async function removeJannyBookmarks(ids) {
    const characterIDs = toIdArray(ids);
    if (!characterIDs.length) return [];
    const data = parseJsonBody(await jannyBrowserRequest('DELETE', `/api/bookmark?ids=${encodeURIComponent(characterIDs.join(','))}`));
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
        const data = parseJsonBody(await jannyBrowserRequest('GET', `/api/get-characters?ids=${encodeURIComponent(chunk.join(','))}`));
        const chars = data?.characters || [];
        if (Array.isArray(chars)) out.push(...chars);
    }
    return out;
}

// /api/get-characters is public; browser cookies apply without a separate anonymous path.
export const fetchJannyPublicCharactersByIds = fetchJannyCharactersByIds;

export async function fetchJannyCollections() {
    const data = parseJsonBody(await jannyBrowserRequest('GET', '/api/collections/mine'));
    return data?.collections || [];
}

export async function fetchJannyCollectionCharacters(collectionId) {
    if (!collectionId) return [];
    const data = parseJsonBody(await jannyBrowserRequest('GET', `/api/collections/${collectionId}/characters`));
    return data?.characters || [];
}

export async function addJannyCharacterToCollection(collectionId, characterId) {
    const res = await jannyBrowserRequest('POST', `/api/collections/${collectionId}/characters`, { jsonBody: { characterId } });
    return parseJsonBody(res) || {};
}

export async function removeJannyCharacterFromCollection(collectionId, characterId) {
    const res = await jannyBrowserRequest('DELETE', `/api/collections/${collectionId}/characters?characterId=${encodeURIComponent(characterId)}`);
    return parseJsonBody(res) || {};
}

// Collection create/edit/delete are server-rendered Astro form POSTs
// (application/x-www-form-urlencoded). Success answers 302; the browser
// follows the redirect, so the created collection's id is read from finalUrl.
export async function createJannyCollection({ name, description = '', isPrivate = true } = {}) {
    const res = await jannyBrowserRequest('POST', '/collections/form/add-collection', {
        formBody: { name, description, isPrivate: isPrivate ? 'yes' : 'no' },
    });
    const location = res.finalUrl || '';
    const idMatch = location.match(/\/collections\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
    return { success: true, id: idMatch ? idMatch[1] : null, location };
}

export async function updateJannyCollection({ id, name, description = '', isPrivate = true } = {}) {
    const res = await jannyBrowserRequest('POST', '/collections/form/edit-collection', {
        formBody: { id, name, description, isPrivate: isPrivate ? 'yes' : 'no' },
    });
    return { success: true, location: res.finalUrl || '' };
}

export async function deleteJannyCollection(id) {
    const res = await jannyBrowserRequest('POST', '/collections/form/delete-collection', { formBody: { id } });
    return { success: true, location: res.finalUrl || '' };
}

// ========================================
// PUBLIC COLLECTIONS (HTML pages via the shared browser, parsed client-side)
// ========================================

export async function fetchJannyPublicCollections({ sort = 'latest', page = 1 } = {}) {
    const params = new URLSearchParams({ sort: String(sort), page: String(page) });
    const res = await jannyBrowserRequest('GET', `/collections?${params}`);
    return { ok: true, status: res.status, ...parseJannyPublicCollectionsPage(res.body) };
}

export async function fetchJannyCollectorCollections(name) {
    const validation = validateJannyCollectorName(name);
    if (!validation.ok) throw new Error(validation.error);
    const res = await jannyBrowserRequest('GET', `/collectors/${encodeURIComponent(validation.name)}`);
    return { ok: true, status: res.status, ...parseJannyPublicCollectionsPage(res.body) };
}

export async function fetchJannyPublicCollection(path) {
    const validation = validateJannyPublicCollectionPath(path);
    if (!validation.ok) throw new Error(validation.error);
    const res = await jannyBrowserRequest('GET', validation.path);
    return { ok: true, status: res.status, ...parseJannyPublicCollectionDetailPage(res.body, validation.path) };
}
