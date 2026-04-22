// Shared CharaVault API utilities — used by charavault-provider.js and charavault-browse.js
//
// charavault.net has a strict rate limit (60/min unauth, 120/min with app
// password, 240/min hard-ban threshold) with escalating CF bans. Every
// /api/* call flows through a single token-bucket queue (cvFetch); static
// /cards/... PNG downloads bypass throttling (unthrottled, uncounted).

import { CL_HELPER_PLUGIN_BASE as CL_HELPER_CV_BASE, fetchWithProxy } from '../provider-utils.js';
export { CL_HELPER_CV_BASE, fetchWithProxy };

// ========================================
// CONSTANTS
// ========================================

export const CV_API_BASE = 'https://charavault.net';
export const CV_SITE_BASE = 'https://charavault.net';

// Sort options accepted by /api/cards
export const CV_SORT_OPTIONS = {
    most_downloaded: 'Most Downloaded',
    top_rated: 'Top Rated',
    newest: 'Newest',
    oldest: 'Oldest',
    name_asc: 'Name (A → Z)',
    name_desc: 'Name (Z → A)',
    token_count_asc: 'Tokens (Low → High)',
    token_count_desc: 'Tokens (High → Low)',
};

// ========================================
// DEPENDENCIES (injected via initCvApi)
// ========================================

let _getSetting = null;
let _debugLog = null;

export function initCvApi(deps = {}) {
    _getSetting = deps.getSetting || null;
    _debugLog = deps.debugLog || null;
}

function debugLog(...args) {
    _debugLog?.(...args);
}

// ========================================
// AUTH STATE
// ========================================

let cvSessionActive = false;
let cvSessionEmail = null;
let cvPluginAvailable = false;

export function isCvSessionActive() {
    return cvSessionActive;
}

export function getCvSessionEmail() {
    return cvSessionEmail;
}

export function isCvPluginAvailable() {
    return cvPluginAvailable;
}

/** @param {Function} apiRequest */
export async function checkCvPluginAvailable(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CV_BASE}/health`);
        if (!resp.ok) { cvPluginAvailable = false; return false; }
        const data = await resp.json();
        cvPluginAvailable = data?.ok === true;
        return cvPluginAvailable;
    } catch {
        cvPluginAvailable = false;
        return false;
    }
}

/** @param {Function} apiRequest */
export async function checkCvSession(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CV_BASE}/cv-session`);
        if (!resp.ok) { cvSessionActive = false; cvSessionEmail = null; return false; }
        const data = await resp.json();
        cvSessionActive = data?.active === true;
        cvSessionEmail = data?.email || null;
        retuneThrottle();
        return cvSessionActive;
    } catch {
        cvSessionActive = false;
        cvSessionEmail = null;
        return false;
    }
}

/**
 * Log in to CharaVault via cl-helper.
 * @param {Function} apiRequest
 * @param {string} email
 * @param {string} appPassword - An App Password (cv_...) or account password
 * @returns {Promise<{ok: boolean, email?: string, warning?: string, error?: string}>}
 */
export async function cvLogin(apiRequest, email, appPassword) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CV_BASE}/cv-login`, 'POST', {
            email, password: appPassword,
        });
        const text = await resp.text();
        let data = null;
        try { data = JSON.parse(text); } catch { /* ignore */ }

        if (!resp.ok || !data?.ok) {
            return { ok: false, error: data?.error || `HTTP ${resp.status}` };
        }
        cvSessionActive = true;
        cvSessionEmail = data.email || email;
        retuneThrottle();
        return { ok: true, email: cvSessionEmail, warning: data.warning || null };
    } catch (err) {
        return { ok: false, error: err.message || 'Network error' };
    }
}

/** Validate stored session with cl-helper; clears session state on failure. */
export async function cvValidateSession(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CV_BASE}/cv-validate`);
        if (!resp.ok) return { valid: false, reason: 'validation request failed' };
        const data = await resp.json();
        if (!data?.valid) {
            cvSessionActive = false;
            cvSessionEmail = null;
            retuneThrottle();
        } else if (data?.email) {
            cvSessionEmail = data.email;
        }
        return data;
    } catch {
        cvSessionActive = false;
        cvSessionEmail = null;
        return { valid: false, reason: 'network error' };
    }
}

export async function cvLogout(apiRequest) {
    try {
        await apiRequest(`${CL_HELPER_CV_BASE}/cv-logout`, 'POST');
    } catch { /* ignore */ }
    cvSessionActive = false;
    cvSessionEmail = null;
    retuneThrottle();
}

// ========================================
// RATE-LIMIT THROTTLE (token bucket)
// ========================================

// Config retuned on login/logout; capacity/refill sized well below the
// 60/120 per-minute soft limit to leave headroom for concurrent tabs
// sharing the same IP.
const THROTTLE_UNAUTH = {
    capacity: 50,
    refillPerMs: 50 / 60000, // tokens/ms → 50 per minute
    minDelayMs: 1200,
};
const THROTTLE_AUTHED = {
    capacity: 100,
    refillPerMs: 100 / 60000, // 100 per minute
    minDelayMs: 600,
};

const bucket = {
    tokens: THROTTLE_UNAUTH.capacity,
    lastRefill: Date.now(),
    ...THROTTLE_UNAUTH,
};

// FIFO queue: array of { run: () => Promise<any>, resolve, reject }
const queue = [];
let running = false;
let lastRequestAt = 0;
let lastKnownRemaining = null;     // last X-RateLimit-Remaining seen
let globalPauseUntil = 0;           // hard pause timestamp (on 429 Retry-After)

function retuneThrottle() {
    const next = cvSessionActive ? THROTTLE_AUTHED : THROTTLE_UNAUTH;
    bucket.capacity = next.capacity;
    bucket.refillPerMs = next.refillPerMs;
    bucket.minDelayMs = next.minDelayMs;
    if (bucket.tokens > bucket.capacity) bucket.tokens = bucket.capacity;
    debugLog('[CharaVault] Throttle retuned:', cvSessionActive ? 'authed' : 'unauth',
        `cap=${bucket.capacity} minDelay=${bucket.minDelayMs}ms`);
}

function refillTokens() {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    if (elapsed <= 0) return;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
    bucket.lastRefill = now;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function nextSlot() {
    // Respect any global pause (set by 429 Retry-After)
    const now = Date.now();
    if (globalPauseUntil > now) {
        await sleep(globalPauseUntil - now);
    }

    // Space requests by minDelayMs
    const since = Date.now() - lastRequestAt;
    if (since < bucket.minDelayMs) {
        await sleep(bucket.minDelayMs - since);
    }

    // Adaptive slowdown based on remaining quota
    if (lastKnownRemaining != null) {
        if (lastKnownRemaining <= 5) {
            await sleep(2000);
        } else if (lastKnownRemaining <= 15) {
            await sleep(bucket.minDelayMs);
        }
    }

    // Wait for a token
    refillTokens();
    while (bucket.tokens < 1) {
        const missing = 1 - bucket.tokens;
        const waitMs = Math.ceil(missing / bucket.refillPerMs) + 5;
        await sleep(waitMs);
        refillTokens();
    }
    bucket.tokens -= 1;
}

async function drainQueue() {
    if (running) return;
    running = true;
    try {
        while (queue.length > 0) {
            const item = queue.shift();
            try {
                await nextSlot();
                lastRequestAt = Date.now();
                const result = await item.run();
                item.resolve(result);
            } catch (err) {
                item.reject(err);
            }
        }
    } finally {
        running = false;
    }
}

function enqueue(fn) {
    return new Promise((resolve, reject) => {
        queue.push({ run: fn, resolve, reject });
        drainQueue();
    });
}

/**
 * cvFetch — the only path through which /api/* calls go.
 * Handles: throttling, proxy routing, 429 Retry-After, adaptive slowdown.
 *
 * @param {string} apiPath - Path starting with /api/... (no origin)
 * @param {Function} [apiRequest] - CoreAPI.apiRequest (required when plugin available)
 * @param {{ method?: string, body?: any }} [opts]
 * @returns {Promise<Response>}
 */
export async function cvFetch(apiPath, apiRequest, opts = {}) {
    if (!apiPath.startsWith('/api/')) {
        throw new Error(`cvFetch only accepts /api/ paths (got ${apiPath})`);
    }

    const exec = async () => {
        let resp;

        // Route through cl-helper when available (adds session cookies)
        if (cvPluginAvailable && apiRequest) {
            resp = await apiRequest(`${CL_HELPER_CV_BASE}/cv-proxy${apiPath}`, opts.method || 'GET', opts.body);
        } else {
            const url = `${CV_API_BASE}${apiPath}`;
            const init = {};
            if (opts.method) init.method = opts.method;
            if (opts.body) {
                init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
                init.headers = { 'Content-Type': 'application/json' };
            }
            resp = await fetchWithProxy(url, init);
        }

        // Update remaining-quota tracker
        const remainingHeader = resp.headers?.get?.('x-ratelimit-remaining');
        if (remainingHeader != null) {
            const n = parseInt(remainingHeader, 10);
            if (Number.isFinite(n)) lastKnownRemaining = n;
        }

        // Handle 429 — set a global pause and retry once
        if (resp.status === 429) {
            const retryAfterStr = resp.headers?.get?.('retry-after');
            let retryAfterSec = parseInt(retryAfterStr, 10);
            if (!Number.isFinite(retryAfterSec) || retryAfterSec <= 0) {
                retryAfterSec = 8; // default backoff
            }
            if (retryAfterSec > 300) {
                throw new Error(`CharaVault rate-limited for ${retryAfterSec}s — aborting. Try again later.`);
            }
            globalPauseUntil = Date.now() + retryAfterSec * 1000 + 250;
            debugLog(`[CharaVault] 429 received — pausing ${retryAfterSec}s`);
            await sleep(retryAfterSec * 1000 + 100);
            // Retry once
            return exec();
        }

        return resp;
    };

    return enqueue(exec);
}

// ========================================
// ENDPOINTS
// ========================================

/**
 * Search CharaVault cards via /api/cards (offset-based pagination).
 * @param {Object} opts
 * @param {Function} [apiRequest]
 */
export async function searchCards(opts = {}, apiRequest) {
    const {
        q = '',
        tags = '',
        creator = '',
        folder = '',
        nsfw = false,
        hasBook = false,
        sort = 'most_downloaded',
        limit = 30,
        offset = 0,
    } = opts;

    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tags) params.set('tags', tags);
    if (creator) params.set('creator', creator);
    if (folder) params.set('folder', folder);
    if (nsfw) params.set('nsfw', 'true');
    if (hasBook) params.set('has_book', 'true');
    params.set('sort', sort);
    params.set('limit', String(limit));
    params.set('offset', String(offset));

    const resp = await cvFetch(`/api/cards?${params}`, apiRequest);
    if (!resp.ok) throw new Error(`CharaVault search failed (HTTP ${resp.status})`);
    return resp.json();
}

/**
 * Fetch full card details via /api/cards/{folder}/{file}
 */
export async function fetchCardDetail(folder, file, apiRequest) {
    const path = `/api/cards/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
    const resp = await cvFetch(path, apiRequest);
    if (!resp.ok) throw new Error(`CharaVault detail failed (HTTP ${resp.status})`);
    const data = await resp.json();
    
    if (data && data.entry) {
        const flat = { ...data.entry };
        if (data.full_metadata) {
            // Support V2 format (metadata inside .data) and V1 format (flat metadata)
            if (data.full_metadata.data) {
                Object.assign(flat, data.full_metadata.data);
            } else {
                Object.assign(flat, data.full_metadata);
            }
        }
        return flat;
    }
    return data;
}

/**
 * List lorebooks attached to a card.
 * @returns {Promise<Array>}
 */
export async function fetchCardLorebooks(folder, file, apiRequest) {
    const path = `/api/cards/${encodeURIComponent(folder)}/${encodeURIComponent(file)}/lorebooks`;
    const resp = await cvFetch(path, apiRequest);
    if (!resp.ok) throw new Error(`Lorebook list failed (HTTP ${resp.status})`);
    const data = await resp.json();
    // API may return {lorebooks: [...]} or an array
    return Array.isArray(data) ? data : (data?.lorebooks || []);
}

/**
 * Download a single lorebook by id.
 */
export async function fetchLorebook(lorebookId, apiRequest) {
    const path = `/api/lorebooks/download/${encodeURIComponent(lorebookId)}`;
    const resp = await cvFetch(path, apiRequest);
    if (!resp.ok) throw new Error(`Lorebook download failed (HTTP ${resp.status})`);
    return resp.json();
}

/**
 * Fetch top tags list (if exposed by the API).
 */
export async function fetchTopTags(apiRequest) {
    const resp = await cvFetch('/api/tags', apiRequest);
    if (!resp.ok) throw new Error(`Tags fetch failed (HTTP ${resp.status})`);
    const data = await resp.json();
    // Accept either [{tag, count}, ...] or { tags: [...] }
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.tags)) return data.tags;
    if (Array.isArray(data?.data)) return data.data;
    return [];
}

// ========================================
// URL / PATH HELPERS
// ========================================

/**
 * Build static card PNG URL. This is NOT rate-limited (not under /api/*).
 * Use this for thumbnails and for the authoritative PNG download on import.
 */
export function getCardPngUrl(folder, file) {
    const fileName = file.toLowerCase().endsWith('.png') ? file : `${file}.png`;
    return `${CV_SITE_BASE}/cards/${encodeURIComponent(folder)}/${encodeURIComponent(fileName)}`;
}

/**
 * Cloudflare-resized thumbnail. Falls back to raw card PNG on error in the UI.
 */
export function getAvatarUrl(folder, file, width = 320) {
    const fileName = file.toLowerCase().endsWith('.png') ? file : `${file}.png`;
    return `${CV_SITE_BASE}/cards/thumb/${encodeURIComponent(folder)}/${encodeURIComponent(fileName)}`;
}

/**
 * The CharaVault showcase page for a card.
 */
export function getCharacterPageUrl(folder, file) {
    return `${CV_SITE_BASE}/cards/${folder}/${file}`;
}

/**
 * Parse a charavault.net URL into {folder, file, fullPath} or null.
 * Accepts:
 *   /cards/{folder}/{file}.card.png
 *   /cards/{folder}/{file}
 *   /api/cards/download/{folder}/{file}.png
 *   /api/cards/{folder}/{file}
 *   /c/{folder}/{file}
 */
export function parseCharacterUrl(url) {
    if (!url) return null;
    try {
        const u = new URL(url.startsWith('http') ? url : `https://${url}`);
        if (!/^(www\.)?charavault\.net$/i.test(u.hostname)) return null;

        const path = u.pathname;
        const patterns = [
            /^\/cards\/([^/]+)\/([^/]+?)\.card\.png$/i,
            /^\/api\/cards\/download\/([^/]+)\/([^/]+?)\.png$/i,
            /^\/api\/cards\/download\/([^/]+)\/([^/]+)$/i,
            /^\/api\/cards\/([^/]+)\/([^/]+)$/i,
            /^\/cards\/([^/]+)\/([^/]+?)(?:\.[a-z]+)?$/i,
            /^\/c\/([^/]+)\/([^/]+)$/i,
        ];
        for (const re of patterns) {
            const m = path.match(re);
            if (m) {
                const folder = decodeURIComponent(m[1]);
                const file = decodeURIComponent(m[2]);
                return { folder, file, fullPath: `${folder}/${file}` };
            }
        }
    } catch { /* ignore */ }
    return null;
}

/**
 * Split a "folder/file" string back into parts.
 */
export function splitFullPath(fullPath) {
    if (!fullPath || typeof fullPath !== 'string') return null;
    const idx = fullPath.indexOf('/');
    if (idx <= 0) return null;
    return {
        folder: fullPath.slice(0, idx),
        file: fullPath.slice(idx + 1),
    };
}

// ========================================
// TEXT UTILITIES (shared)
// ========================================

export { slugify, stripHtml, formatNumber } from '../provider-utils.js';

/**
 * Normalize tags into an array of strings.
 */
export function parseTags(tags) {
    if (!tags) return [];
    if (Array.isArray(tags)) return tags.filter(Boolean).map(String);
    if (typeof tags === 'string') return tags.split(/[,\s]+/).filter(Boolean);
    return [];
}

// ========================================
// V2 CARD BUILDER
// ========================================

/**
 * Build a V2 character card from CharaVault metadata.
 * The PNG is authoritative; this is only used when the PNG isn't available
 * or as a supplementary backfill.
 */
export function buildCharacterCardFromCv(meta) {
    const tags = parseTags(meta?.tags);
    const folder = meta?.folder || '';
    const file = meta?.file || '';
    const fullPath = meta?.full_path || meta?.fullPath || (folder && file ? `${folder}/${file}` : '');
    const creator = meta?.creator || meta?.author || folder || '';

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: meta?.name || file || 'Unnamed',
            description: meta?.description || '',
            personality: meta?.personality || '',
            scenario: meta?.scenario || '',
            first_mes: meta?.first_mes || meta?.first_message || '',
            mes_example: meta?.mes_example || meta?.example_messages || '',
            creator_notes: meta?.creator_notes || meta?.tagline || '',
            system_prompt: meta?.system_prompt || '',
            post_history_instructions: meta?.post_history_instructions || '',
            alternate_greetings: Array.isArray(meta?.alternate_greetings) ? meta.alternate_greetings : [],
            tags,
            creator,
            character_version: meta?.character_version || '',
            extensions: {
                charavault: {
                    folder,
                    file,
                    fullPath,
                    tagline: meta?.tagline || '',
                    updatedAt: meta?.updated_at || meta?.updatedAt || null,
                    tokenCount: meta?.token_count || meta?.tokenCount || 0,
                    linkedAt: new Date().toISOString(),
                    _v: 1,
                },
            },
            character_book: undefined,
        },
    };
}

// ========================================
// LOREBOOK NORMALIZER
// ========================================

/**
 * Normalize a CharaVault lorebook payload to V2 character_book shape.
 * Handles both V2-array and ST-dict entry shapes.
 */
export function normalizeLorebookToV2(raw) {
    if (!raw) return undefined;
    const lb = raw?.lorebook || raw;

    const entriesSource = lb?.entries;
    const entriesArray = Array.isArray(entriesSource)
        ? entriesSource
        : (entriesSource && typeof entriesSource === 'object')
            ? Object.values(entriesSource)
            : [];

    if (entriesArray.length === 0) return undefined;

    return {
        name: lb.name || '',
        description: lb.description || '',
        scan_depth: Number(lb.scan_depth) || 2,
        token_budget: Number(lb.token_budget) || 500,
        recursive_scanning: !!lb.recursive_scanning,
        extensions: lb.extensions || {},
        entries: entriesArray.map((e, i) => ({
            id: Number(e.entry_id ?? e.id) || i,
            keys: Array.isArray(e.keys) ? e.keys : (Array.isArray(e.key) ? e.key : []),
            secondary_keys: Array.isArray(e.secondary_keys) ? e.secondary_keys : [],
            content: e.content || '',
            comment: e.comment || e.name || '',
            enabled: e.enabled !== false,
            selective: !!e.selective,
            constant: !!e.constant,
            case_sensitive: !!e.case_sensitive,
            insertion_order: Number(e.insertion_order) || 100,
            priority: Number(e.priority) || 10,
            position: e.position === 'after_char' ? 'after_char' : 'before_char',
            extensions: e.extensions || {},
        })),
    };
}

// ========================================
// CONTENT HASH (for update tiebreakers)
// ========================================

/**
 * SHA-256 hex digest of an ArrayBuffer. Uses Web Crypto.
 */
export async function sha256Hex(buffer) {
    try {
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        return Array.from(new Uint8Array(digest))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    } catch {
        return null;
    }
}
