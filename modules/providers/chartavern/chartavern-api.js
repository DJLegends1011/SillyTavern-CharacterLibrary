// Shared CharacterTavern API utilities - used by both chartavern-provider.js and chartavern-browse.js
//
// Contains constants, fetch helpers, and text utilities for character-tavern.com.
//
// CT's JSON API (/api/search/cards, /api/character/*, /api/catalog/top-tags) was removed in its
// 2026-10 SvelteKit rework. The same data now ships as the pages' own `__data.json` payloads
// (devalue-encoded, streamed promises as trailing chunk lines). The fetchers below decode those and
// adapt them back to the legacy shapes so the provider/browse code keeps one data model.

// ========================================
// CONSTANTS
// ========================================

import { CL_HELPER_PLUGIN_BASE as CL_HELPER_CT_BASE } from '../provider-utils.js';
export { CL_HELPER_CT_BASE };

export const CT_SITE_BASE = 'https://character-tavern.com';
export const CT_CARDS_CDN = 'https://ct-cards.storage.character-tavern.com';

// The catalog serves a fixed page size; its `limit` param is ignored.
export const CT_PAGE_SIZE = 30;

// Sort values the catalog accepts (anything else silently becomes `best`)
export const CT_SORT_OPTIONS = {
    popular: 'Popular',
    best: 'Best',
    new_noteworthy: 'New & Noteworthy',
    most_liked: 'Top Rated',
    hidden_gems: 'Hidden Gems',
    newest: 'Newest',
    recently_updated: 'Recently Updated',
};
export const CT_DEFAULT_SORT = 'popular';

// The homepage's own feeds: fixed 28-card sets (its 7x4 grid), no paging or filters.
// Sort values carry a `feed:` prefix so they share the sort dropdown with the catalog.
export const CT_FEED_PREFIX = 'feed:';
export const CT_HOME_FEEDS = {
    trending: { label: 'Trending', key: 'TrendingCharacters' },
    newest: { label: 'Newest', key: 'NewCharacters' },
    popular: { label: 'Popular', key: 'PopularCharacters' },
};

/** @param {string} sort @returns {string|null} feed id for a `feed:` sort, else null */
export function ctFeedOf(sort) {
    if (typeof sort !== 'string' || !sort.startsWith(CT_FEED_PREFIX)) return null;
    const id = sort.slice(CT_FEED_PREFIX.length);
    return Object.hasOwn(CT_HOME_FEEDS, id) ? id : null;
}

// Pre-rework sort values, still found in saved browse defaults
const CT_LEGACY_SORTS = {
    most_popular: 'popular',
    trending: 'new_noteworthy',
    most_likes: 'most_liked',
    oldest: 'newest',
};

/** @param {string} sort @returns {string} a sort value the catalog accepts */
export function normalizeCtSort(sort) {
    if (sort && Object.hasOwn(CT_SORT_OPTIONS, sort)) return sort;
    if (ctFeedOf(sort)) return sort;
    return CT_LEGACY_SORTS[sort] || CT_DEFAULT_SORT;
}

// ========================================
// NETWORK (shared)
// ========================================

import { fetchWithProxy, classifyErrorPage } from '../provider-utils.js';
export { fetchWithProxy };

// ========================================
// AUTH - cl-helper cookie session
// ========================================

let ctSessionActive = false;

/**
 * Check if the cl-helper plugin is reachable.
 * @param {Function} apiRequest - CoreAPI.apiRequest
 * @returns {Promise<boolean>}
 */
export async function checkCtPluginAvailable(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/health`);
        if (!resp.ok) return false;
        const data = await resp.json();
        return data?.ok === true;
    } catch {
        return false;
    }
}

/**
 * Check if a CT session is active in cl-helper.
 * @param {Function} apiRequest - CoreAPI.apiRequest
 * @returns {Promise<boolean>}
 */
export async function checkCtSession(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-session`);
        if (!resp.ok) return false;
        const data = await resp.json();
        ctSessionActive = data?.active === true;
        return ctSessionActive;
    } catch {
        ctSessionActive = false;
        return false;
    }
}

/**
 * Store cookies in cl-helper for proxied CT requests.
 * @param {Function} apiRequest
 * @param {string} cookieString - Raw cookie header value (e.g. "session=abc123")
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function ctSetCookie(apiRequest, cookieString) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-set-cookie`, 'POST', {
            cookie: cookieString,
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return { ok: false, error: `Server returned ${resp.status}: ${text.substring(0, 100)}` };
        }
        const data = await resp.json();
        if (data?.ok) {
            ctSessionActive = true;
            return { ok: true };
        }
        return { ok: false, error: data?.error || 'Failed to store cookies' };
    } catch (err) {
        return { ok: false, error: err.message || 'Network error' };
    }
}

/**
 * Validate stored CT cookies by making a test request through cl-helper.
 * Clears session state if cookies are expired/invalid.
 * @param {Function} apiRequest
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function ctValidateSession(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-validate`);
        // Client-side failures never judged the cookie, so they are transient by construction
        if (!resp.ok) return { valid: false, transient: true, reason: 'validation request failed' };
        const data = await resp.json();
        if (!data?.valid) {
            ctSessionActive = false;
        }
        return data;
    } catch {
        ctSessionActive = false;
        return { valid: false, transient: true, reason: 'network error' };
    }
}

/**
 * Log out from CharacterTavern via cl-helper.
 * @param {Function} apiRequest
 */
export async function ctLogout(apiRequest) {
    try {
        await apiRequest(`${CL_HELPER_CT_BASE}/ct-logout`, 'POST');
    } catch { /* ignore */ }
    ctSessionActive = false;
}

/** @returns {boolean} */
export function isCtSessionActive() {
    return ctSessionActive;
}

/**
 * Richer session read: the last-known rolling expiry cl-helper snapshotted from CT's
 * Set-Cookie. Purely a stored-state read (no CT request), so it never slides the window.
 * @param {Function} apiRequest
 * @returns {Promise<{active: boolean, expires: number|null}>} expires in ms epoch
 */
export async function fetchCtSessionInfo(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-session`);
        if (!resp.ok) return { active: false, expires: null };
        const data = await resp.json();
        ctSessionActive = data?.active === true;
        return { active: ctSessionActive, expires: data?.expires ?? null };
    } catch {
        return { active: false, expires: null };
    }
}

// One /health probe per session backing ctFetch's transport choice; concurrent callers share it.
let _ctHelperProbe = null;

function ctHelperAvailable(apiRequest) {
    if (!apiRequest) return Promise.resolve(false);
    if (!_ctHelperProbe) _ctHelperProbe = checkCtPluginAvailable(apiRequest);
    return _ctHelperProbe;
}

// Set once a cl-helper predating the __data.json allowlist refuses a path, so later calls skip it
let _ctProxyOutdated = false;

/**
 * Fetch a CT URL, routing through cl-helper's /ct-proxy whenever cl-helper is available.
 * @param {string} url - Full CT URL (e.g. https://character-tavern.com/search/cards/__data.json?...)
 * @param {Function} [apiRequest] - CoreAPI.apiRequest (required for proxied requests)
 * @returns {Promise<Response>}
 */
async function ctFetch(url, apiRequest) {
    // /ct-proxy is preferred even with NO session, not just for the cookie: ST's /proxy/ forwards
    // the browser's Accept-Encoding (modern Chrome/Firefox advertise zstd), CT's edge then answers
    // zstd, and STs node-fetch pipe can neither decompress it nor forward the Content-Encoding
    // header, so the browser receives undecodable bytes. /ct-proxy negotiates only encodings its
    // runtime can decode, so its responses always arrive readable.
    if (apiRequest && !_ctProxyOutdated && (ctSessionActive || await ctHelperAvailable(apiRequest))) {
        const path = url.replace(CT_SITE_BASE, '');
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-proxy${path}`);
        if (resp.status !== 403) return resp;
        // An older cl-helper only allowlists the removed /api/ paths. Guest browsing still works
        // through ST's /proxy/ (CT streams __data.json uncompressed); only the session is lost.
        const body = await resp.clone().json().catch(() => null);
        if (body?.error !== 'Proxy path not allowed') return resp;
        _ctProxyOutdated = true;
        console.warn('[CharacterTavern] cl-helper is outdated for the new CT site; browsing as guest. Update cl-helper to restore the session.');
    }
    return fetchWithProxy(url);
}

// ========================================
// SVELTEKIT DATA DECODING
// ========================================

// devalue's reserved negative indices
const DV_UNDEFINED = -1, DV_HOLE = -2, DV_NAN = -3, DV_POS_INF = -4, DV_NEG_INF = -5, DV_NEG_ZERO = -6;

/**
 * Rebuild one devalue-flattened value array. SvelteKit encodes a streamed promise as
 * ["Promise", <id>], so `chunks` resolves those to the matching chunk line's data.
 * @param {Array} values
 * @param {(id: number) => any} resolveChunk
 */
function unflattenDevalue(values, resolveChunk) {
    if (!Array.isArray(values)) return undefined;
    const done = new Map();

    function hydrate(i) {
        switch (i) {
            case DV_UNDEFINED: case DV_HOLE: return undefined;
            case DV_NAN: return NaN;
            case DV_POS_INF: return Infinity;
            case DV_NEG_INF: return -Infinity;
            case DV_NEG_ZERO: return -0;
        }
        if (done.has(i)) return done.get(i);
        const v = values[i];
        if (v === null || typeof v !== 'object') {
            done.set(i, v);
            return v;
        }
        if (Array.isArray(v)) {
            if (typeof v[0] === 'string') {
                const type = v[0];
                switch (type) {
                    case 'Date': { const d = new Date(v[1]); done.set(i, d); return d; }
                    case 'Promise': { const r = resolveChunk(hydrate(v[1])); done.set(i, r); return r; }
                    case 'Set': {
                        const s = new Set();
                        done.set(i, s);
                        for (let j = 1; j < v.length; j++) s.add(hydrate(v[j]));
                        return s;
                    }
                    case 'Map': {
                        const m = new Map();
                        done.set(i, m);
                        for (let j = 1; j < v.length; j += 2) m.set(hydrate(v[j]), hydrate(v[j + 1]));
                        return m;
                    }
                    case 'null': {
                        const o = Object.create(null);
                        done.set(i, o);
                        for (let j = 1; j < v.length; j += 2) o[v[j]] = hydrate(v[j + 1]);
                        return o;
                    }
                    case 'BigInt': { const b = BigInt(v[1]); done.set(i, b); return b; }
                    // Other built-ins (RegExp, URL, typed arrays) carry no card data; keep the raw payload
                    default: { const raw = hydrate(v[1]); done.set(i, raw); return raw; }
                }
            }
            const arr = new Array(v.length);
            done.set(i, arr);
            for (let j = 0; j < v.length; j++) {
                if (v[j] !== DV_HOLE) arr[j] = hydrate(v[j]);
            }
            return arr;
        }
        const obj = {};
        done.set(i, obj);
        for (const key of Object.keys(v)) obj[key] = hydrate(v[key]);
        return obj;
    }

    return hydrate(0);
}

/** A load-function error node (eg. 404 "This user does not exist"), keeping its HTTP status. */
function ctNodeError(error) {
    const err = new Error(`CharacterTavern error: ${error?.message || 'unknown'}`);
    if (error?.status) err.status = error.status;
    return err;
}

/**
 * Decode a SvelteKit `__data.json` body: one `{type:"data", nodes}` line, then one
 * `{type:"chunk", id, data}` line per streamed promise. Every node's data is merged into one
 * object (layout first, page last), so callers read page fields straight off it.
 * @param {string} text
 * @returns {Object}
 */
export function parseSvelteKitData(text) {
    const lines = String(text || '').split('\n').filter(l => l.trim());
    if (!lines.length) throw new Error('CharacterTavern returned an empty response');

    let head;
    const rawChunks = new Map();
    for (const line of lines) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            throw new Error('CharacterTavern returned an unreadable page payload');
        }
        if (msg.type === 'chunk') rawChunks.set(msg.id, msg);
        else if (!head) head = msg;
    }
    if (head?.type === 'redirect') {
        const err = new Error(`CharacterTavern redirected to ${head.location}`);
        err.redirect = head.location;
        throw err;
    }
    if (head?.type === 'error') throw ctNodeError(head.error);
    if (!Array.isArray(head?.nodes)) throw new Error('CharacterTavern returned an unexpected page payload');

    const chunkCache = new Map();
    const resolveChunk = (id) => {
        if (chunkCache.has(id)) return chunkCache.get(id);
        const raw = rawChunks.get(id);
        // A rejected promise (raw.error) or an unsent chunk reads as missing data, never a throw
        const val = raw && !raw.error ? unflattenDevalue(raw.data, resolveChunk) : null;
        chunkCache.set(id, val);
        return val;
    };

    const merged = {};
    for (const node of head.nodes) {
        if (node?.type === 'error') throw ctNodeError(node.error);
        if (node?.type !== 'data') continue;
        const data = unflattenDevalue(node.data, resolveChunk);
        if (data && typeof data === 'object') Object.assign(merged, data);
    }
    return merged;
}

/**
 * Fetch and decode a CT page's `__data.json`.
 * @param {string} pagePath - site path without trailing slash, e.g. "/search/cards"
 * @param {URLSearchParams|null} params
 * @param {Function} [apiRequest]
 * @returns {Promise<Object>} merged node data
 */
async function fetchCtPageData(pagePath, params, apiRequest) {
    const qs = params && String(params) ? `?${params}` : '';
    const resp = await ctFetch(`${CT_SITE_BASE}${pagePath}/__data.json${qs}`, apiRequest);
    const text = await resp.text();
    if (!resp.ok) {
        const pageMsg = classifyErrorPage(text, resp.status);
        const err = new Error(pageMsg || `CharacterTavern returned HTTP ${resp.status}`);
        err.status = resp.status;
        err.bodySnippet = text.slice(0, 300);
        throw err;
    }
    // A Cloudflare challenge or HTML error page can arrive as 200; the payload is always JSON lines
    if (!text.trimStart().startsWith('{')) {
        const err = new Error(classifyErrorPage(text, resp.status) || 'CharacterTavern returned a web page instead of data');
        err.status = resp.status;
        err.bodySnippet = text.slice(0, 300);
        throw err;
    }
    return parseSvelteKitData(text);
}

// ========================================
// SHAPE ADAPTERS (new payloads -> legacy shapes)
// ========================================

/** @param {string[]} [warnings] */
function hasSexualWarning(warnings) {
    return Array.isArray(warnings) && warnings.includes('nsfw_sexual');
}

/**
 * Catalog hits now carry only id/name/tagline/path/author/contentWarnings/permanentTokens.
 * Stats, tags and definitions live on the detail page only.
 */
function adaptSearchHit(hit) {
    return {
        ...hit,
        totalTokens: hit.permanentTokens ?? 0,
        isNSFW: hasSexualWarning(hit.contentWarnings),
    };
}

/** Normalize an alternative-greetings payload (strings or {content|message|text} rows) to strings. */
function adaptAltGreetings(raw) {
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.greetings) ? raw.greetings : [];
    return list
        .map(g => (typeof g === 'string' ? g : g?.content ?? g?.message ?? g?.text ?? ''))
        .filter(g => typeof g === 'string' && g.trim());
}

function toEpochSeconds(value) {
    if (!value) return 0;
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * Character page data -> the legacy detail `card`. Adds the fields the old search hits used to
 * carry (tags, likes, alt greetings, lorebook flag) so callers no longer need a second request.
 */
function adaptDetail(data) {
    const character = data?.character;
    if (!character) return null;
    const altGreetings = adaptAltGreetings(data.alternativeGreetings);
    const username = data.authorUsername || character.path?.split('/')[0] || '';
    const card = {
        ...character,
        // `author` is now CT's numeric user id; everything here reads it as the username
        author: username,
        author_username: username,
        authorId: character.author ?? null,
        tags: Array.isArray(data.tags) ? data.tags.filter(Boolean) : [],
        contentWarnings: data.contentWarnings || [],
        isNSFW: character.isNSFW === true || hasSexualWarning(data.contentWarnings),
        likes: data.likesData?.likeCount ?? null,
        dislikes: data.likesData?.dislikeCount ?? null,
        userReaction: data.likesData?.userReaction ?? null, // 'like' | 'dislike' | null (guest: null)
        authorUserId: data.authorUserId ?? null,
        chats: character.analytics_chats ?? null,
        totalTokens: character.tokenTotal ?? 0,
        createdAt: toEpochSeconds(character.createdAt),
        hasLorebook: !!(character.lorebookId || data.lorebook),
        alternativeFirstMessage: altGreetings,
        lorebook: data.lorebook || null,
    };
    return { card, ownerCTId: data.authorUserId ?? null };
}

/**
 * CT lorebook (detail page `lorebook`) -> V2 character_book.
 * @param {Object|null} lorebook - { name, description, scanDepth, entries: [{ id, name, content, keys, enabled, insertionOrder, constant }] }
 * @returns {Object|undefined}
 */
export function buildCtCharacterBook(lorebook) {
    const entries = Array.isArray(lorebook?.entries) ? lorebook.entries : [];
    if (!entries.length) return undefined;
    return {
        name: (lorebook.name || '').trim(),
        description: lorebook.description || '',
        scan_depth: lorebook.scanDepth ?? undefined,
        extensions: {},
        entries: entries.map((e, i) => ({
            id: i,
            keys: Array.isArray(e.keys) ? e.keys.filter(Boolean) : [],
            secondary_keys: [],
            content: e.content || '',
            comment: (e.name || '').trim(),
            name: (e.name || '').trim(),
            enabled: e.enabled !== false,
            constant: e.constant === true,
            selective: false,
            insertion_order: e.insertionOrder ?? 100,
            case_sensitive: false,
            extensions: {},
        })),
    };
}

// ========================================
// API FUNCTIONS
// ========================================

/**
 * Search the catalog via /search/cards/__data.json
 * @param {Object} opts
 * @param {Function} [apiRequest] - CoreAPI.apiRequest for authenticated proxy
 * @returns {Promise<{hits: Array, totalHits: number, totalPages: number, page: number, hiddenByPrefs: boolean}>}
 */
export async function searchCards(opts = {}, apiRequest) {
    const {
        query = '',
        sort = CT_DEFAULT_SORT,
        page = 1,
        tags = '',
        excludeTags = '',
        minimumTokens,
        maximumTokens,
        hasLorebook,
        isOC,
        nsfw = true
    } = opts;

    const params = new URLSearchParams();
    if (query) params.set('query', query);
    // A feed sort never reaches the catalog; relevance is the sane stand-in for a search
    params.set('sort', ctFeedOf(sort) ? 'best' : normalizeCtSort(sort));
    params.set('page', String(page));
    if (tags) params.set('tags', tags);
    if (excludeTags) params.set('exclude_tags', excludeTags);
    if (minimumTokens != null) params.set('minimum_tokens', String(minimumTokens));
    if (maximumTokens != null) params.set('maximum_tokens', String(maximumTokens));
    if (hasLorebook != null) params.set('hasLorebook', String(hasLorebook));
    if (isOC != null) params.set('isOC', String(isOC));

    // CT API has no explicit NSFW toggle - exclude_tags is used instead
    if (!nsfw) {
        const existing = excludeTags ? excludeTags.split(',').map(t => t.trim()) : [];
        if (!existing.includes('nsfw')) existing.push('nsfw');
        params.set('exclude_tags', existing.join(','));
    }

    const data = await fetchCtPageData('/search/cards', params, apiRequest);
    const results = data?.searchResults;
    if (!results || !Array.isArray(results.hits)) {
        throw new Error('CharacterTavern search returned no results block');
    }
    return {
        hits: results.hits.map(adaptSearchHit),
        totalHits: results.totalHits ?? 0,
        totalPages: results.totalPages ?? 1,
        page: results.page ?? page,
        hiddenByPrefs: results.hiddenByPrefs === true,
    };
}

// Preview, enrichment, link stats and import often read the same card back to back
const DETAIL_TTL_MS = 60_000;
const _detailCache = new Map(); // key -> { at, promise }

/**
 * Fetch full character details via /character/{author}/{slug}/__data.json
 * @param {string} author
 * @param {string} slug
 * @param {Function} [apiRequest] - CoreAPI.apiRequest for authenticated proxy
 * @returns {Promise<{card: Object, ownerCTId: string|null}|null>} null when the page has no character
 */
export function fetchCharacterDetail(author, slug, apiRequest) {
    const key = `${ctSessionActive ? 'auth' : 'guest'}:${author}/${slug}`;
    const hit = _detailCache.get(key);
    if (hit && Date.now() - hit.at < DETAIL_TTL_MS) return hit.promise;

    const pagePath = `/character/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`;
    const promise = fetchCtPageData(pagePath, null, apiRequest).then(adaptDetail);
    promise.catch(() => _detailCache.delete(key)); // never cache a failure
    _detailCache.set(key, { at: Date.now(), promise });
    if (_detailCache.size > 50) _detailCache.delete(_detailCache.keys().next().value);
    return promise;
}

// The homepage data holds every feed at once; switching feeds shouldnt refetch it
const HOME_TTL_MS = 60_000;
let _homeCache = null; // { at, key, promise }

/**
 * Fetch the homepage's page data (all feeds + the logged-in timeline in one payload).
 * @param {Function} [apiRequest]
 * @param {{ fresh?: boolean }} [opts] - fresh bypasses the short cache (refresh button)
 * @returns {Promise<Object>} merged node data
 */
function fetchHomeData(apiRequest, { fresh = false } = {}) {
    const key = ctSessionActive ? 'auth' : 'guest';
    if (!fresh && _homeCache && _homeCache.key === key && Date.now() - _homeCache.at < HOME_TTL_MS) {
        return _homeCache.promise;
    }
    const promise = fetchCtPageData('', null, apiRequest);
    promise.catch(() => { if (_homeCache?.promise === promise) _homeCache = null; });
    _homeCache = { at: Date.now(), key, promise };
    return promise;
}

/**
 * One homepage feed, adapted to catalog-hit shape.
 * @param {string} feedId - a CT_HOME_FEEDS key
 * @param {Function} [apiRequest]
 * @param {{ fresh?: boolean }} [opts]
 * @returns {Promise<Array>} the feed's cards in site order
 */
export async function fetchHomeFeed(feedId, apiRequest, opts) {
    const feed = CT_HOME_FEEDS[feedId];
    if (!feed) throw new Error(`Unknown CharacterTavern feed: ${feedId}`);
    const data = await fetchHomeData(apiRequest, opts);
    const list = data?.[feed.key];
    if (!Array.isArray(list)) throw new Error(`CharacterTavern homepage has no ${feed.label} feed`);
    return list.map(adaptSearchHit);
}

// ========================================
// ACCOUNT (cookie session via cl-helper)
// ========================================

/**
 * POST one allowlisted CT account write through cl-helper's /ct-write.
 * @returns {Promise<Object>} CT's JSON reply
 */
async function ctWrite(path, body, apiRequest) {
    if (!apiRequest) throw new Error('CharacterTavern account actions need cl-helper');
    const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-write${path}`, 'POST', body);
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
        if (resp.status === 401) ctSessionActive = false;
        const err = new Error(data?.message || data?.error || `CharacterTavern returned HTTP ${resp.status}`);
        err.status = resp.status;
        throw err;
    }
    return data;
}

/**
 * Toggle the account's like on a card. CT's endpoint TOGGLES: liking an already-liked card
 * removes the like, so callers send this only when the wanted state differs from userReaction.
 * @param {string} cardId - CT card id (CT_...)
 * @returns {Promise<{likeCount: number, dislikeCount: number, userReaction: 'like'|'dislike'|null}>}
 */
export function ctToggleLike(cardId, apiRequest) {
    return ctWrite('/api/cards/like', { cardId, like: true }, apiRequest).then((d) => {
        _detailCache.clear(); // cached detail pages carry the old likesData
        return d;
    });
}

/**
 * Follow or unfollow a creator.
 * @param {string} authorUserId - the creator's CT user id (profile.userId / authorUserId)
 * @param {boolean} follow
 * @returns {Promise<{isFollowing: boolean}>}
 */
export async function ctSetFollow(authorUserId, follow, apiRequest) {
    const d = await ctWrite('/api/creator/follow', { authorUserId, action: follow ? 'follow' : 'unfollow' }, apiRequest);
    _homeCache = null; // the timeline follows the follow list
    return { isFollowing: d?.isFollowing === true };
}

/**
 * The account's timeline (homepage TimelineCards: newest from followed creators, fixed 28).
 * @returns {Promise<Array>} empty for guests
 */
export async function fetchTimeline(apiRequest, opts) {
    const data = await fetchHomeData(apiRequest, opts);
    return (data?.TimelineCards || []).map(adaptSearchHit);
}

/**
 * The account's liked cards (/library/reactions), newest reaction first.
 * @returns {Promise<Array>} catalog-hit shaped, with reactedAt (epoch seconds)
 */
export async function fetchLikedCards(apiRequest) {
    const data = await fetchCtPageData('/library/reactions', null, apiRequest);
    if (!data?.user) {
        const err = new Error('Log in to CharacterTavern to see your liked characters');
        err.status = 401;
        throw err;
    }
    return (data.likedCards || []).map(c => adaptSearchHit({
        ...c,
        author: c.path?.split('/')[0] || '',
        contentWarnings: c.isNSFW ? ['nsfw_sexual'] : [],
        reactedAt: toEpochSeconds(c.reactedAt),
    }));
}

/**
 * The account's followed creators as CT user ids. CT exposes no "following" page; every
 * character page streams this list, so read it off one (any card works; a feed card is cached).
 * @returns {Promise<string[]>}
 */
export async function fetchFollowedCreatorIds(apiRequest) {
    const home = await fetchHomeData(apiRequest);
    const anyCard = home?.TimelineCards?.[0] || home?.TrendingCharacters?.[0];
    if (!anyCard?.path) return [];
    const [author, slug] = anyCard.path.split('/');
    const pagePath = `/character/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`;
    const data = await fetchCtPageData(pagePath, null, apiRequest);
    const ids = data?.follows?.follows;
    return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [];
}

// Sort values the creator page accepts (anything else becomes newest)
export const CT_CREATOR_SORTS = {
    newest: 'Newest',
    popular: 'Most popular',
    name: 'Name',
};

/** Creator-page card -> catalog-hit shape (it says tokenTotal/warnings where hits say permanentTokens/contentWarnings). */
function adaptCreatorCard(card, username) {
    return adaptSearchHit({
        ...card,
        author: username,
        contentWarnings: card.warnings ?? card.contentWarnings ?? [],
        permanentTokens: card.tokenTotal ?? card.permanentTokens ?? 0,
    });
}

/**
 * A creator's own cards from /author/{username}/__data.json.
 * Paging past the last page makes CT redirect back to page 1, so that (and a page beyond
 * `pages`) reads as an empty page rather than an error.
 * @param {string} username
 * @param {{ sort?: string, page?: number, q?: string }} [opts]
 * @param {Function} [apiRequest]
 * @returns {Promise<{profile: Object, stats: Object, cards: Array, featured: Array, pages: number, matches: number, hiddenCount: number, isFollowing: boolean, isLoggedIn: boolean}>}
 */
export async function fetchCreatorPage(username, { sort = 'newest', page = 1, q = '' } = {}, apiRequest) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    // The site omits its defaults from the URL; mirror that so the request matches a real visit
    const safeSort = Object.hasOwn(CT_CREATOR_SORTS, sort) ? sort : 'newest';
    if (safeSort !== 'newest') params.set('sort', safeSort);
    if (page > 1) params.set('page', String(page));

    let data;
    try {
        data = await fetchCtPageData(`/author/${encodeURIComponent(username)}`, params, apiRequest);
    } catch (err) {
        if (err.redirect && page > 1) {
            return { profile: null, stats: null, cards: [], featured: [], pages: page - 1, matches: 0, hiddenCount: 0, isFollowing: false, isLoggedIn: false, isOwnProfile: false };
        }
        if (err.status === 404) {
            const e = new Error(`CharacterTavern creator "${username}" was not found`);
            e.notFound = true;
            throw e;
        }
        throw err;
    }

    const name = data.profile?.username || username;
    return {
        profile: data.profile || null,
        stats: data.stats || null,
        cards: (data.cards || []).map(c => adaptCreatorCard(c, name)),
        featured: (data.featured || []).map(c => adaptCreatorCard(c, name)),
        pages: data.pages ?? 1,
        matches: data.matches ?? 0,
        hiddenCount: data.hiddenCount ?? 0,
        isFollowing: data.isFollowing === true,
        isLoggedIn: data.isLoggedIn === true,
        isOwnProfile: data.isOwnProfile === true,
    };
}

/**
 * Fetch the catalog's tag list (the search page's streamed `tagCatalogue`).
 * @param {Function} [apiRequest] - CoreAPI.apiRequest for the cl-helper transport
 * @returns {Promise<Array<{tag: string, count: number}>>}
 */
export async function fetchTopTags(apiRequest) {
    const data = await fetchCtPageData('/search/cards', null, apiRequest);
    const tags = data?.tagCatalogue?.tags;
    if (!Array.isArray(tags)) throw new Error('CharacterTavern tag catalogue missing');
    return tags
        .filter(t => t?.value)
        .map(t => ({ tag: t.value, count: t.count ?? 0 }));
}

// ========================================
// URL / PATH HELPERS
// ========================================

/**
 * Card image URL. CT moved cards to the storage host and dropped the /cdn-cgi/image resize (404s there now), so this serves the full image direct; browsers get webp via content negotiation.
 * @param {string} path - "author/slug" format
 * @returns {string}
 */
export function getAvatarUrl(path) {
    return `${CT_CARDS_CDN}/${path}.png`;
}

/**
 * Build full-size card PNG URL (for download / import).
 * @param {string} path - "author/slug" format
 * @returns {string}
 */
export function getCardPngUrl(path) {
    return `${CT_CARDS_CDN}/${path}.png`;
}

/**
 * Build the web page URL for a character.
 * @param {string} path - "author/slug" format
 * @returns {string}
 */
export function getCharacterPageUrl(path) {
    return `${CT_SITE_BASE}/character/${path}`;
}

/**
 * Parse a character-tavern.com URL into author/slug path.
 * Accepts: https://character-tavern.com/character/author/slug
 * @param {string} url
 * @returns {string|null} "author/slug" or null
 */
export function parseCharacterUrl(url) {
    if (!url) return null;
    try {
        const u = new URL(url.startsWith('http') ? url : `https://${url}`);
        if (!/^(www\.)?character-tavern\.com$/i.test(u.hostname)) return null;
        const match = u.pathname.match(/^\/character\/([^/]+)\/([^/]+)/);
        if (match) return `${match[1]}/${match[2]}`;
    } catch { /* ignore */ }
    return null;
}

/**
 * Creator username from a user's typed reference: a bare or @-prefixed username, a creator
 * page URL (/author/name) or a character URL (/character/name/slug).
 * @param {string} input
 * @returns {string|null}
 */
export function parseCreatorRef(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    if (/character-tavern\.com/i.test(raw)) {
        try {
            const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
            const m = u.pathname.match(/^\/(?:author|character)\/([^/]+)/);
            return m ? decodeURIComponent(m[1]) : null;
        } catch {
            return null;
        }
    }
    const name = raw.replace(/^@/, '');
    return /^[^\s/?#]+$/.test(name) ? name : null;
}

// ========================================
// TEXT UTILITIES (shared + local)
// ========================================

export { slugify, stripHtml, formatNumber } from '../provider-utils.js';

/**
 * The clean character name. CT's `name` is the listing title ("Shy Cousin") while `inChatName`
 * carries the plain name ("Elara"), the same split Wyvern and JanitorAI have. Nullable, and real
 * data carries trailing spaces, so trim. Both search hits and the detail card have both fields.
 * @param {Object} apiData - CT card object (detail card or search hit)
 * @returns {string}
 */
export function getCtCharName(apiData) {
    return (apiData?.inChatName || '').trim() || apiData?.name || 'Unknown';
}

/**
 * Normalize tags into an array of strings.
 * CT API returns tags as an array; handles legacy space-separated strings too.
 */
export function parseTags(tags) {
    if (!tags) return [];
    if (Array.isArray(tags)) return tags.filter(Boolean);
    if (typeof tags === 'string') return tags.split(/\s+/).filter(Boolean);
    return [];
}
