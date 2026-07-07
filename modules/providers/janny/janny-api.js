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

import { CL_HELPER_PLUGIN_BASE } from '../provider-utils.js';
import { canAddBookmarks, reconcileBookmarkSet, capForSettings } from './janny-bookmark-logic.js';

const JANNY_PROXY_BASE = `${CL_HELPER_PLUGIN_BASE}/jy-proxy`;
const GET_CHARACTERS_CHUNK = 100; // ids per get-characters request (URL-length safe)

let _apiRequest = null;
let _getSetting = () => undefined;
const _bookmarkIds = new Set();

export function configureJannyAccount(deps = {}) {
    _apiRequest = deps.apiRequest || null;
    if (typeof deps.getSetting === 'function') _getSetting = deps.getSetting;
}

export function getJannyBookmarkIds() { return _bookmarkIds; }
export function jannyBookmarkCap() { return capForSettings(_getSetting); }

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

import { fetchWithProxy } from '../provider-utils.js';
export { fetchWithProxy };
export { slugify, stripHtml } from '../provider-utils.js';

export function resolveTagNames(tagIds) {
    return (tagIds || []).map(id => TAG_MAP[id] || `Tag ${id}`);
}

// ========================================
// ACCOUNT (cl-helper session: cookie, validate, logout)
// ========================================

export async function jannyHelperAvailable() {
    if (!_apiRequest) return false;
    try {
        const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/health`);
        return resp?.ok === true;
    } catch { return false; }
}

export async function connectJanny(cookie) {
    if (!_apiRequest) return { ok: false, error: 'cl-helper plugin not available' };
    try {
        await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/jy-set-cookie`, 'POST', {
            cookie,
            userAgent: (typeof navigator !== 'undefined' ? navigator.userAgent : ''),
        });
        const status = await jannyAuthStatus();
        if (status.connected) {
            await refreshJannyBookmarkIds();
            return { ok: true, bookmarkCount: status.bookmarkCount };
        }
        return { ok: false, error: status.reason || 'Session did not validate' };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export async function jannyAuthStatus() {
    if (!_apiRequest) return { connected: false, reason: 'no cl-helper' };
    try {
        const resp = await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/jy-validate`);
        if (!resp?.ok) return { connected: false, reason: `HTTP ${resp?.status}` };
        const data = await resp.json().catch(() => ({}));
        return { connected: !!data?.valid, bookmarkCount: data?.bookmarkCount, reason: data?.reason };
    } catch (e) {
        return { connected: false, reason: e.message };
    }
}

export async function disconnectJanny() {
    _bookmarkIds.clear();
    if (!_apiRequest) return;
    try { await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/jy-logout`, 'POST'); } catch { /* ignore */ }
}

// ========================================
// BOOKMARKS (fetch / toggle with cap enforcement / batch character fetch)
// ========================================

export async function refreshJannyBookmarkIds() {
    _bookmarkIds.clear();
    if (!_apiRequest) return _bookmarkIds;
    try {
        const resp = await _apiRequest(`${JANNY_PROXY_BASE}/api/bookmark`);
        if (!resp?.ok) {
            console.warn('[JannyAPI] refresh bookmarks failed: HTTP', resp?.status);
            return _bookmarkIds;
        }
        const data = await resp.json().catch(() => ({}));
        const ids = Array.isArray(data) ? data : (data?.characterIds || data?.ids || []);
        for (const id of ids) _bookmarkIds.add(typeof id === 'string' ? id : id?.id);
    } catch (e) {
        console.warn('[JannyAPI] refresh bookmarks failed:', e.message);
    }
    return _bookmarkIds;
}

/** Add or remove one bookmark, enforcing the cap on add. */
export async function toggleJannyBookmark(id, add) {
    if (!_apiRequest) return { ok: false, error: 'cl-helper plugin not available' };
    if (add) {
        const guard = canAddBookmarks(_bookmarkIds.size, 1, jannyBookmarkCap());
        if (!guard.ok) return { ok: false, error: guard.reason };
    }
    try {
        let resp;
        if (add) {
            resp = await _apiRequest(`${JANNY_PROXY_BASE}/api/bookmark`, 'POST', { characterIds: [id] });
        } else {
            resp = await _apiRequest(`${JANNY_PROXY_BASE}/api/bookmark?ids=${encodeURIComponent(id)}`, 'DELETE');
        }
        if (!resp?.ok) {
            const detail = await resp?.text?.().catch(() => '');
            return { ok: false, error: detail || `HTTP ${resp?.status}` };
        }
        reconcileBookmarkSet(_bookmarkIds, [id], add);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export async function fetchJannyBookmarkCharacters(ids) {
    const out = [];
    if (!_apiRequest || !ids?.length) return out;
    for (let i = 0; i < ids.length; i += GET_CHARACTERS_CHUNK) {
        const chunk = ids.slice(i, i + GET_CHARACTERS_CHUNK);
        try {
            const resp = await _apiRequest(`${JANNY_PROXY_BASE}/api/get-characters?ids=${chunk.map(encodeURIComponent).join(',')}`);
            if (!resp?.ok) {
                console.warn('[JannyAPI] get-characters chunk failed: HTTP', resp?.status);
                continue;
            }
            const data = await resp.json().catch(() => ({}));
            const list = Array.isArray(data) ? data : (data?.characters || data?.results || []);
            out.push(...list);
        } catch (e) {
            console.warn('[JannyAPI] get-characters chunk failed:', e.message);
        }
    }
    return out;
}
