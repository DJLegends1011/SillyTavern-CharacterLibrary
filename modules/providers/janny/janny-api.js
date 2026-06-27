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

import { fetchWithProxy, CL_HELPER_PLUGIN_BASE } from '../provider-utils.js';
export { fetchWithProxy };
export { slugify, stripHtml } from '../provider-utils.js';

export function resolveTagNames(tagIds) {
    return (tagIds || []).map(id => TAG_MAP[id] || `Tag ${id}`);
}

// ========================================
// BOOKMARK SYNC (via cl-helper proxy)
// ========================================

let _jannyBookmarkSessionActive = false;

function jannyApiRequest(path, method = 'GET', body = null) {
    const endpoint = `${CL_HELPER_PLUGIN_BASE}${path}`;
    if (typeof window !== 'undefined' && typeof window.apiRequest === 'function') {
        return window.apiRequest(endpoint, method, body);
    }

    const opts = { method, headers: {} };
    const csrfToken = typeof window !== 'undefined' && typeof window.getCSRFToken === 'function'
        ? window.getCSRFToken()
        : '';
    if (csrfToken) opts.headers['X-CSRF-Token'] = csrfToken;
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    return fetch(endpoint, opts);
}

function asArrayPayload(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.characters)) return data.characters;
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.results)) return data.results;
    return [];
}

function normalizeTagIds(char) {
    const rawTags = Array.isArray(char?.tagIds) ? char.tagIds
        : Array.isArray(char?.tags) ? char.tags
        : [];
    return rawTags
        .map(tag => {
            if (tag && typeof tag === 'object') return Number(tag.id ?? tag.tagId ?? tag.tag_id);
            return Number(tag);
        })
        .filter(Number.isFinite);
}

function normalizeTimestamp(value, fallbackDate) {
    const stamp = Number(value);
    if (Number.isFinite(stamp) && stamp > 0) return stamp;
    if (!fallbackDate) return 0;
    const parsed = Date.parse(fallbackDate);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function normalizeAvatar(rawAvatar) {
    const avatar = String(rawAvatar || '').trim();
    if (!avatar) return { avatar: '', avatarUrl: '' };
    if (avatar.startsWith(JANNY_IMAGE_BASE)) {
        return { avatar: avatar.slice(JANNY_IMAGE_BASE.length), avatarUrl: '' };
    }
    if (/^https?:\/\//i.test(avatar)) {
        return { avatar: '', avatarUrl: avatar };
    }
    return { avatar, avatarUrl: '' };
}

function bookmarkIdFromRecord(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string' || typeof raw === 'number') return String(raw).trim();
    if (typeof raw !== 'object') return '';

    const nested = raw.character || raw.characterData || raw.bot || raw.card || {};
    const value = raw.characterID
        ?? raw.characterId
        ?? raw.character_id
        ?? raw.characterUUID
        ?? raw.characterUuid
        ?? raw.character_uuid
        ?? nested.id
        ?? nested.characterID
        ?? nested.characterId
        ?? nested.character_id
        ?? raw.id
        ?? raw.uuid;
    return value != null ? String(value).trim() : '';
}

export function normalizeJannyBookmarkIds(data) {
    const payload = Array.isArray(data) ? data
        : Array.isArray(data?.bookmarks) ? data.bookmarks
        : Array.isArray(data?.bookmarkIDs) ? data.bookmarkIDs
        : Array.isArray(data?.bookmarkIds) ? data.bookmarkIds
        : Array.isArray(data?.bookmark_ids) ? data.bookmark_ids
        : Array.isArray(data?.characterIDs) ? data.characterIDs
        : Array.isArray(data?.characterIds) ? data.characterIds
        : Array.isArray(data?.character_ids) ? data.character_ids
        : Array.isArray(data?.characters) ? data.characters
        : Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.items) ? data.items
        : Array.isArray(data?.results) ? data.results
        : [];

    const seen = new Set();
    const ids = [];
    for (const item of payload) {
        const id = bookmarkIdFromRecord(item);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

export function normalizeJannyBookmarkCharacter(raw) {
    const char = raw?.character || raw || {};
    const rawId = char.id ?? char.characterId ?? char.characterID ?? char.uuid;
    const createdAt = char.createdAt || char.created_at || '';
    const avatarData = normalizeAvatar(char.avatar || char.avatarUrl || char.imageUrl || char.image);
    const normalized = {
        id: rawId != null ? String(rawId) : '',
        name: char.name || char.title || 'Unknown',
        avatar: avatarData.avatar,
        avatarUrl: avatarData.avatarUrl,
        description: char.description || char.tagline || '',
        tagIds: normalizeTagIds(char),
        totalToken: Number(char.totalToken ?? char.totalTokens ?? char.tokenCount ?? char.nTokens ?? char.n_tokens ?? 0) || 0,
        creatorUsername: char.creatorUsername || char.creatorName || char.creator?.username || char.creator?.name || '',
        createdAt,
        createdAtStamp: normalizeTimestamp(char.createdAtStamp ?? char.created_at_stamp, createdAt),
    };
    if (typeof char.isLowQuality === 'boolean') normalized.isLowQuality = char.isLowQuality;
    if (typeof char.isNsfw === 'boolean') normalized.isNsfw = char.isNsfw;
    return normalized;
}

export async function setJannyBookmarkCookie(apiRequest, cookieString) {
    try {
        const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/janny-set-cookie`, 'POST', {
            cookie: cookieString,
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return { ok: false, error: `Server returned ${resp.status}: ${text.substring(0, 100)}` };
        }
        const data = await resp.json();
        if (data?.ok) {
            _jannyBookmarkSessionActive = true;
            return { ok: true };
        }
        return { ok: false, error: data?.error || 'Unknown error' };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

export async function validateJannySession(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/janny-validate`);
        if (!resp.ok) return { valid: false, reason: 'validation request failed' };
        const data = await resp.json();
        _jannyBookmarkSessionActive = data?.valid === true;
        return data;
    } catch {
        _jannyBookmarkSessionActive = false;
        return { valid: false, reason: 'network error' };
    }
}

export async function jannyLogout(apiRequest) {
    try {
        await apiRequest(`${CL_HELPER_PLUGIN_BASE}/janny-logout`, 'POST');
    } catch { /* ignore */ }
    _jannyBookmarkSessionActive = false;
}

export async function checkJannySession() {
    try {
        const resp = await jannyApiRequest('/janny-session');
        if (!resp.ok) return false;
        const data = await resp.json();
        _jannyBookmarkSessionActive = !!data?.active;
        return _jannyBookmarkSessionActive;
    } catch {
        return false;
    }
}

export function isJannyBookmarkSessionActive() {
    return _jannyBookmarkSessionActive;
}

export async function fetchJannyBookmarks() {
    const resp = await jannyApiRequest('/janny-bookmarks');
    if (!resp.ok) throw new Error(`JannyAI bookmarks failed: ${resp.status}`);
    const data = await resp.json();
    return normalizeJannyBookmarkIds(data);
}

export async function fetchJannyBookmarkCharacters(characterIDs) {
    const ids = (characterIDs || []).map(id => String(id || '').trim()).filter(Boolean);
    if (ids.length === 0) return [];
    const resp = await jannyApiRequest(`/janny-bookmark-chars?ids=${encodeURIComponent(ids.join(','))}`);
    if (!resp.ok) throw new Error(`JannyAI bookmark characters failed: ${resp.status}`);
    const data = await resp.json();
    return asArrayPayload(data).map(normalizeJannyBookmarkCharacter).filter(c => c.id);
}

export async function addJannyBookmarks(characterIDs) {
    const resp = await jannyApiRequest('/janny-bookmarks', 'POST', { characterIDs });
    if (!resp.ok) throw new Error(`JannyAI add bookmark failed: ${resp.status}`);
    const data = await resp.json();
    return data?.bookmarks || [];
}

export async function removeJannyBookmarks(characterIDs) {
    const ids = characterIDs.join(',');
    const resp = await jannyApiRequest(`/janny-bookmarks?ids=${encodeURIComponent(ids)}`, 'DELETE');
    if (!resp.ok) throw new Error(`JannyAI remove bookmark failed: ${resp.status}`);
    const data = await resp.json();
    return data?.bookmarks || [];
}
