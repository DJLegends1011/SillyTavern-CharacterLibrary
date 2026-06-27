// Shared DataCat API utilities - used by datacat-provider.js and datacat-browse.js
//
// Sections: Network, Metadata, Browse/Search, Tags, V2 Card Builder, Extraction, MeiliSearch

import { CL_HELPER_PLUGIN_BASE, slugify, stripHtml, fetchWithProxy } from '../provider-utils.js';
import { getSearchToken, JANNY_SEARCH_URL, JANNY_SITE_BASE, TAG_MAP as JANNY_TAG_MAP } from '../janny/janny-api.js';

export { slugify, stripHtml, JANNY_TAG_MAP };

/**
 * Decode common HTML entities. JanitorAI's listing endpoints (Meili + Hampter)
 * return creator-notes HTML escaped (&lt;p&gt;...&lt;/p&gt;) rather than raw,
 * so consumers expecting real HTML must decode first.
 */
function decodeHtmlEntities(s) {
    if (!s || typeof s !== 'string') return s || '';
    if (s.indexOf('&') === -1) return s;
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&amp;/g, '&');
}

// ========================================
// CONSTANTS
// ========================================

export const DATACAT_API_BASE = 'https://datacat.run';

// DataCat aggregates from multiple sources. Each has its own avatar URL convention:
//   - JanitorAI: bare filename, served from ella.janitorai.com
//   - Saucepan: full https URL (cdn.saucepan.ai/...) embedded in the avatar field
// Future sources should be added here. Use resolveDatacatAvatarUrl() to get a usable URL.
export const DATACAT_JANITOR_IMAGE_BASE = 'https://ella.janitorai.com/bot-avatars/';

/**
 * Resolve a character's avatar URL based on its source.
 * Saucepan and other future sources embed full URLs in the avatar field;
 * JanitorAI uses bare filenames that need the ella.janitorai.com prefix.
 * @param {Object} hit - DataCat character object (listing or detail)
 * @returns {string|null} Full URL or null if no avatar
 */
export function resolveDatacatAvatarUrl(hit) {
    const avatar = hit?.avatar;
    if (!avatar || typeof avatar !== 'string') return null;
    const url = /^https?:\/\//i.test(avatar) ? avatar : `${DATACAT_JANITOR_IMAGE_BASE}${avatar}`;
    const safety = window.isUrlSafeForDownload?.(url);
    if (safety && !safety.ok) return null;
    return url;
}

// Minimum token threshold for quality filtering (matches DataCat's own frontend default)
export const MIN_TOTAL_TOKENS = 889;

// ========================================
// NETWORK
// ========================================

const DC_PROXY_BASE = `${CL_HELPER_PLUGIN_BASE}/dc-proxy`;

let _apiRequest = null;
let _getSavedToken = null;
let _getSavedAccountToken = null;
let _getSavedDeviceToken = null;
let _getDatacatClientId = null;
let _bootstrapInFlight = null;

/**
 * Bind the CoreAPI.apiRequest function for use in proxied requests.
 * Called once from the provider's init().
 */
export function setApiRequest(fn) { _apiRequest = fn; }

/**
 * Bind a getter that returns the persisted DataCat session token (or null).
 * Lets dcFetch lazy-bootstrap a session for out-of-browse-view callers
 * (link modal preview, gallery download, gallery-sync) without coupling
 * the api file to CoreAPI/settings directly. Called once from init().
 */
export function setSavedTokenGetter(fn) { _getSavedToken = fn; }

export function setSavedAccountTokenGetter(fn) { _getSavedAccountToken = fn; }

export function setSavedDeviceTokenGetter(fn) { _getSavedDeviceToken = fn; }

export function setDatacatClientIdGetter(fn) { _getDatacatClientId = fn; }

export function getDatacatClientId() {
    const id = _getDatacatClientId?.();
    if (typeof id !== 'string') return null;
    const trimmed = id.trim();
    return trimmed || null;
}

export function getDatacatClientHeaders() {
    const id = getDatacatClientId();
    return id ? { 'X-CL-Datacat-Client': id } : {};
}

export async function dcHelperRequest(path, method = 'GET', data = null) {
    const headers = getDatacatClientHeaders();
    if (_apiRequest) {
        if (Object.keys(headers).length === 0) {
            return _apiRequest(path, method, data);
        }
        const apiHeaders = {
            'Content-Type': 'application/json',
            'X-CSRF-Token': window.getCSRFToken?.() || '',
            ...headers,
        };
        return _apiRequest(path, method, data, { headers: apiHeaders });
    }

    const config = {
        method,
        headers: {
            'X-CSRF-Token': window.getCSRFToken?.() || '',
            ...headers,
        },
    };
    if (data != null) {
        config.headers['Content-Type'] = 'application/json';
        config.body = JSON.stringify(data);
    }
    return fetch(`/api${path}`, config);
}

export async function dcHelperJson(path, method = 'GET', data = null) {
    let resp;
    try {
        resp = await dcHelperRequest(path, method, data);
    } catch (err) {
        return { ok: false, valid: false, error: err?.message || 'network error', reason: 'network error' };
    }

    let payload = null;
    let text = '';
    try {
        text = await resp.clone().text();
        if (text) payload = JSON.parse(text);
    } catch {
        payload = null;
    }

    if (resp.ok) {
        return payload || { ok: true };
    }

    const message = payload?.error || payload?.reason || payload?.message || text || `request failed (${resp.status})`;
    return {
        ...(payload && typeof payload === 'object' ? payload : {}),
        ok: false,
        valid: false,
        status: resp.status,
        error: message,
        reason: payload?.reason || message,
    };
}

/**
 * Push the saved token (or a fresh anonymous one) into cl-helper. Returns
 * true if a usable session is now active. Concurrent callers share the
 * in-flight bootstrap promise so we never run more than one /dc-init at
 * a time. Reset on completion so a future 401 can re-arm.
 */
async function tryBootstrapSession() {
    if (_bootstrapInFlight) return _bootstrapInFlight;
    _bootstrapInFlight = (async () => {
        try {
            const savedToken = _getSavedToken?.() ?? null;
            return !!(await initDcSession(savedToken));
        } catch {
            return false;
        } finally {
            _bootstrapInFlight = null;
        }
    })();
    return _bootstrapInFlight;
}

/**
 * Fetch a DataCat API path through the cl-helper plugin proxy.
 * On 401/403, attempts to bootstrap a session once and retries.
 * @param {string} apiPath - Path relative to datacat.run (e.g. /api/characters/recent-public?...)
 * @returns {Promise<Response>}
 */
async function dcFetch(apiPath) {
    if (!_apiRequest) throw new Error('DataCat: apiRequest not bound (cl-helper required)');
    let resp = await dcHelperRequest(`${DC_PROXY_BASE}${apiPath}`);
    if (resp.status === 401 || resp.status === 403) {
        if (await tryBootstrapSession()) {
            resp = await dcHelperRequest(`${DC_PROXY_BASE}${apiPath}`);
        }
    }
    if (!resp.ok) {
        let body = '';
        try { body = await resp.clone().text(); } catch { /* ignore */ }
        console.warn(`[DataCat] dcFetch ${resp.status} for ${apiPath}`, body.slice(0, 500));
    }
    return resp;
}

/**
 * Check if the cl-helper plugin is available.
 * @returns {Promise<boolean>}
 */
export async function checkDcPluginAvailable() {
    try {
        const resp = _apiRequest
            ? await _apiRequest(`${CL_HELPER_PLUGIN_BASE}/health`)
            : await fetch(`/api${CL_HELPER_PLUGIN_BASE}/health`);
        if (!resp.ok) return false;
        const data = await resp.json();
        return data?.ok === true;
    } catch {
        return false;
    }
}

/**
 * Try to restore a saved DataCat session token via cl-helper.
 * Pushes the saved token to cl-helper and validates it.
 * @param {string} savedToken - Previously saved session token
 * @returns {Promise<boolean>} true if the saved token is still valid
 */
async function restoreSavedToken(savedToken) {
    if (!savedToken || typeof savedToken !== 'string') return false;
    try {
        const deviceToken = _getSavedDeviceToken?.() || null;
        const body = { token: savedToken };
        if (deviceToken) body.deviceToken = deviceToken;
        const setResp = await dcHelperRequest(`${CL_HELPER_PLUGIN_BASE}/dc-set-token`, 'POST', body);
        if (!setResp.ok) return false;

        const valResp = await dcHelperRequest(`${CL_HELPER_PLUGIN_BASE}/dc-validate`);
        if (!valResp.ok) return false;
        const data = await valResp.json();
        return data?.valid === true;
    } catch {
        return false;
    }
}

/**
 * Initialize a DataCat session via cl-helper.
 * If a saved token is provided, tries to restore it first.
 * Otherwise (or if saved token is invalid), requests a fresh session.
 * Returns the active token string on success so the caller can persist it.
 * @param {string} [savedToken] - Previously saved session token to try first
 * @param {boolean} [force] - Force a new token even if one is cached
 * @returns {Promise<string|null>} The active session token, or null on failure
 */
export async function initDcSession(savedToken, force = false) {
    try {
        // Try restoring a saved token first (unless forcing refresh)
        if (savedToken && !force) {
            const restored = await restoreSavedToken(savedToken);
            if (restored) return savedToken;
        }

        const resp = await dcHelperRequest(`${CL_HELPER_PLUGIN_BASE}/dc-init`, 'POST', force ? { force: true } : null);
        if (!resp.ok) return null;
        const data = await resp.json();
        if (data?.ok && data?.token) return data.token;
        return null;
    } catch {
        return null;
    }
}

/**
 * Validate the current DataCat session on cl-helper.
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function validateDcSession() {
    try {
        const resp = await dcHelperRequest(`${CL_HELPER_PLUGIN_BASE}/dc-validate`);
        if (!resp.ok) return { valid: false, reason: 'request failed' };
        return await resp.json();
    } catch {
        return { valid: false, reason: 'network error' };
    }
}

/**
 * Clear the DataCat session token from cl-helper.
 * @returns {Promise<boolean>}
 */
export async function clearDcSession() {
    try {
        const resp = await dcHelperRequest(`${CL_HELPER_PLUGIN_BASE}/dc-clear-token`, 'POST');
        return resp.ok;
    } catch {
        return false;
    }
}

export async function restoreDatacatAccount() {
    const accountToken = _getSavedAccountToken?.() || null;
    if (!accountToken) return { valid: false, reason: 'no saved account token', user: null };
    const deviceToken = _getSavedDeviceToken?.() || null;
    return dcHelperJson(`${CL_HELPER_PLUGIN_BASE}/dc-auth-set`, 'POST', { accountToken, deviceToken });
}

/**
 * Account-scoped cl-helper call with one-shot session recovery.
 *
 * The account session lives in cl-helper's in-memory store and is wiped when
 * the ST server restarts. Account endpoints (yours / follow / following) then
 * 401 with "No DataCat account session configured" even though the saved
 * account token still lives in settings. On that 401 we re-push the saved
 * token via restoreDatacatAccount() once and retry -- mirroring how dcFetch
 * self-heals the anonymous browse session. If no account token is saved, or
 * recovery fails, the original 401 is returned untouched for the caller to
 * surface as an error.
 */
async function dcAccountJson(path, method = 'GET', data = null) {
    const result = await dcHelperJson(path, method, data);
    if (result?.status !== 401 || !_getSavedAccountToken?.()) return result;
    const restore = await restoreDatacatAccount();
    if (!(restore?.ok || restore?.valid)) return result;
    return dcHelperJson(path, method, data);
}

export async function loginDatacatAccount(email, password) {
    return dcHelperJson(`${CL_HELPER_PLUGIN_BASE}/dc-auth-login`, 'POST', { email, password });
}

export async function validateDatacatAccount() {
    return dcHelperJson(`${CL_HELPER_PLUGIN_BASE}/dc-auth-status`);
}

export async function logoutDatacatAccount() {
    return dcHelperJson(`${CL_HELPER_PLUGIN_BASE}/dc-auth-logout`, 'POST');
}

export async function fetchDatacatYoursStatus(characterId) {
    return dcAccountJson(`${CL_HELPER_PLUGIN_BASE}/dc-yours/${encodeURIComponent(characterId)}/status`);
}

export async function setDatacatYoursSaved(characterId, saved) {
    const method = saved ? 'POST' : 'DELETE';
    return dcAccountJson(`${CL_HELPER_PLUGIN_BASE}/dc-yours/${encodeURIComponent(characterId)}`, method);
}

/**
 * Fetch a page of the signed-in account's followed creators for one source.
 * @param {Object} [opts] - see {@link buildDatacatFollowingPath}
 * @returns {Promise<{ok: boolean, total: number, list: Object[], error?: string}>}
 */
export async function fetchDatacatFollowing(opts = {}) {
    const path = buildDatacatFollowingPath(opts).replace('/api/creators/following', '/dc-following');
    return dcAccountJson(`${CL_HELPER_PLUGIN_BASE}${path}`);
}

/**
 * Follow (POST) or unfollow (DELETE) a creator on the account.
 * @param {string} creatorId - UUID
 * @param {boolean} follow
 * @returns {Promise<{ok: boolean, following?: boolean, error?: string}>}
 */
export async function setDatacatFollow(creatorId, follow) {
    const method = follow ? 'POST' : 'DELETE';
    return dcAccountJson(`${CL_HELPER_PLUGIN_BASE}/dc-follow/${encodeURIComponent(creatorId)}`, method);
}

export const DATACAT_MAIN_FOLDER_ID = 'main';

function normalizePositiveInteger(value) {
    if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null;
    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text)) return null;
    const id = Number(text);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeDatacatIdList(values) {
    const list = Array.isArray(values) ? values : String(values ?? '').split(',');
    return list
        .map(value => normalizePositiveInteger(value))
        .filter(id => Number.isInteger(id) && id > 0);
}

function normalizeDatacatCharacterId(value) {
    const id = String(value ?? '').trim();
    return /^[a-f0-9][a-f0-9-]{6,62}[a-f0-9]$/i.test(id) && !id.includes('--') ? id : null;
}

export function normalizeDatacatFolderId(value) {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text || text === 'all') return null;
    if (text === DATACAT_MAIN_FOLDER_ID || text === '-1') return DATACAT_MAIN_FOLDER_ID;
    return normalizePositiveInteger(value);
}

export function normalizeDatacatFolderPayload(payload = {}) {
    if (!payload || typeof payload !== 'object') return null;
    const title = String(payload.title ?? '').trim().replace(/\s+/g, ' ');
    if (!title || title.length > 120) return null;
    const description = String(payload.description ?? '').trim();
    if (description.length > 500) return null;
    return { title, description };
}

export function buildDatacatFoldersPath({ minTotalTokens = null, activeTagIds = [], blockedTagIds = [] } = {}) {
    const params = new URLSearchParams();
    if (Number.isFinite(Number(minTotalTokens))) params.set('minTotalTokens', String(Number(minTotalTokens)));
    const active = normalizeDatacatIdList(activeTagIds);
    const blocked = normalizeDatacatIdList(blockedTagIds);
    if (active.length > 0) params.set('activeTagIds', active.join(','));
    if (blocked.length > 0) params.set('blockedTagIds', blocked.join(','));
    const query = params.toString();
    return `/dc-folders${query ? `?${query}` : ''}`;
}

export function buildDatacatFolderCharactersPath({
    folderId = null,
    limit = 80,
    offset = 0,
    minTotalTokens = MIN_TOTAL_TOKENS,
    tagIds = [],
    blockedTagIds = [],
    search = '',
    sort = 'added',
} = {}) {
    const params = new URLSearchParams();
    params.set('limit', String(Math.max(1, Number(limit) || 80)));
    params.set('offset', String(Math.max(0, Number(offset) || 0)));
    if (Number.isFinite(Number(minTotalTokens))) params.set('minTotalTokens', String(Number(minTotalTokens)));
    const tags = normalizeDatacatIdList(tagIds);
    const blocked = normalizeDatacatIdList(blockedTagIds);
    if (tags.length > 0) params.set('tagIds', tags.join(','));
    if (blocked.length > 0) params.set('blockedTagIds', blocked.join(','));
    const folder = normalizeDatacatFolderId(folderId);
    if (folder === DATACAT_MAIN_FOLDER_ID) params.set('mainOnly', '1');
    else if (Number.isInteger(folder) && folder > 0) params.set('folderId', String(folder));
    const cleanSearch = String(search || '').trim();
    if (cleanSearch) params.set('search', cleanSearch);
    params.set('sort', String(sort || 'added'));
    return `/dc-folder-characters?${params.toString()}`;
}

export function buildDatacatFolderItemPath(folderId, characterId) {
    const folder = normalizeDatacatFolderId(folderId);
    const character = normalizeDatacatCharacterId(characterId);
    if (!Number.isInteger(folder) || folder <= 0 || !character) return null;
    return `/dc-folders/${encodeURIComponent(String(folder))}/items/${encodeURIComponent(character)}`;
}

export async function fetchDatacatFolders(opts = {}) {
    return dcAccountJson(`${CL_HELPER_PLUGIN_BASE}${buildDatacatFoldersPath(opts)}`);
}

export async function createDatacatFolder(payload = {}) {
    const body = normalizeDatacatFolderPayload(payload);
    if (!body) return { ok: false, error: 'Folder title is required' };
    return dcAccountJson(`${CL_HELPER_PLUGIN_BASE}/dc-folders`, 'POST', body);
}

export async function updateDatacatFolder(folderId, payload = {}) {
    const folder = normalizeDatacatFolderId(folderId);
    const body = normalizeDatacatFolderPayload(payload);
    if (!Number.isInteger(folder) || folder <= 0) return { ok: false, error: 'Invalid DataCat folder id' };
    if (!body) return { ok: false, error: 'Folder title is required' };
    return dcAccountJson(`${CL_HELPER_PLUGIN_BASE}/dc-folders/${encodeURIComponent(String(folder))}`, 'PATCH', body);
}

export async function deleteDatacatFolder(folderId) {
    const folder = normalizeDatacatFolderId(folderId);
    if (!Number.isInteger(folder) || folder <= 0) return { ok: false, error: 'Invalid DataCat folder id' };
    return dcAccountJson(`${CL_HELPER_PLUGIN_BASE}/dc-folders/${encodeURIComponent(String(folder))}`, 'DELETE');
}

export async function setDatacatFolderMembership(folderId, characterId, member) {
    const path = buildDatacatFolderItemPath(folderId, characterId);
    if (!path) return { ok: false, error: 'Invalid DataCat folder or character id' };
    return dcAccountJson(`${CL_HELPER_PLUGIN_BASE}${path}`, member ? 'PUT' : 'DELETE');
}

export async function fetchDatacatFolderCharacters(opts = {}) {
    return dcAccountJson(`${CL_HELPER_PLUGIN_BASE}${buildDatacatFolderCharactersPath(opts)}`);
}
export const DATACAT_EXTERNAL_PREINDEX_SOURCES = new Set(['hampter', 'meilisearch', 'saucepan']);

const DATACAT_YOURS_COLLECTABLE_FLAGS = [
    'isCollected',
    'viewer_is_collected',
    'is_collected',
    'collected',
    'isOwnedByViewer',
    'is_owned_by_viewer',
    'isPublicFeedInDb',
    'is_public_feed_in_db',
    'isSystemPublicInDb',
    'is_system_public_in_db',
    'isPublicInDb',
    'is_public_in_db',
    'isFullyExtractedInDb',
    'is_fully_extracted_in_db',
    // Field names actually present on /api/characters/recent-public?summary=1 rows.
    // DataCat surfaces collectability here via the public-feed / extracted flags,
    // not the *_in_db names above, so these must count as positive signals.
    'isPublic',
    'is_public',
    'appearOnPublicFeed',
    'appear_on_public_feed',
    'isExtractedByYou',
    'is_extracted_by_you',
    'hasJannyRecovery',
    'has_janny_recovery',
    'isRecoveryPlaceholder',
    'is_recovery_placeholder',
];

const DATACAT_YOURS_SAVED_FLAGS = [
    'isCollected',
    'viewer_is_collected',
    'is_collected',
    'collected',
];

const DATACAT_YOURS_EXPLICIT_DB_SIGNAL_FLAGS = [
    'isOwnedByViewer',
    'is_owned_by_viewer',
    'isPublicFeedInDb',
    'is_public_feed_in_db',
    'isSystemPublicInDb',
    'is_system_public_in_db',
    'isPublicInDb',
    'is_public_in_db',
    'isFullyExtractedInDb',
    'is_fully_extracted_in_db',
    'hasPartialExtraction',
    'has_partial_extraction',
    'hasJannyRecovery',
    'has_janny_recovery',
    'isRecoveryPlaceholder',
    'is_recovery_placeholder',
];

function hasOwnFlag(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * DataCat can only collect/save records that exist in its character table.
 * Creator-profile and external-search rows may have a source UUID before the
 * DataCat character record has been extracted, so UUID alone is not enough.
 *
 * Unknown DataCat-native public rows are treated as collectable to preserve the
 * existing public feed behavior. Rows with explicit extraction DB flags, or
 * external pre-index sources, must prove collectability first.
 *
 * @param {Object|null} hit
 * @returns {boolean}
 */
export function isDatacatYoursCollectableHit(hit) {
    if (!hit || typeof hit !== 'object') return false;
    if (hit._fullCharacter && typeof hit._fullCharacter === 'object') return true;
    if (hit.character && typeof hit.character === 'object') return true;

    // External pre-index rows (Hampter/Meili/Saucepan) are not DataCat records yet,
    // so exclude them before checking positive flags in case a future search source
    // carries a public/extracted flag of its own.
    const source = String(hit._source || '').trim().toLowerCase();
    if (DATACAT_EXTERNAL_PREINDEX_SOURCES.has(source)) return false;

    if (DATACAT_YOURS_COLLECTABLE_FLAGS.some(key => hit[key] === true)) return true;
    if (hit.hasPartialExtraction === true || hit.has_partial_extraction === true) return false;

    const hasExplicitDbSignal = DATACAT_YOURS_EXPLICIT_DB_SIGNAL_FLAGS.some(key => hasOwnFlag(hit, key));
    if (hasExplicitDbSignal) return false;

    return true;
}

/**
 * Resolve whether a row is currently saved in DataCat Yours.
 *
 * `savedOverride` lets the CL-side live toggle cache supersede stale listing
 * data after the user saves or unsaves without a full DataCat reload.
 *
 * @param {Object|null} hit
 * @param {boolean|null} [savedOverride=null]
 * @returns {boolean}
 */
export function isDatacatYoursSavedHit(hit, savedOverride = null) {
    if (typeof savedOverride === 'boolean') return savedOverride;
    if (!hit || typeof hit !== 'object') return false;
    return DATACAT_YOURS_SAVED_FLAGS.some(key => hit[key] === true);
}

export function buildDatacatYoursCharactersPath({ limit = 80, offset = 0, minTotalTokens = MIN_TOTAL_TOKENS, tagIds = [] } = {}) {
    const params = new URLSearchParams();
    params.set('limit', String(Math.max(1, Number(limit) || 80)));
    params.set('offset', String(Math.max(0, Number(offset) || 0)));
    if (Number.isFinite(Number(minTotalTokens))) params.set('minTotalTokens', String(Number(minTotalTokens)));
    const cleanTagIds = Array.isArray(tagIds)
        ? tagIds.map(id => parseInt(String(id), 10)).filter(id => Number.isFinite(id) && id > 0)
        : [];
    if (cleanTagIds.length > 0) params.set('tagIds', cleanTagIds.join(','));
    params.set('sort', 'added');
    return `/api/characters?${params.toString()}`;
}

/**
 * Build the DataCat "creators I follow" list route.
 * Mirrors the site's own following page: GET /api/creators/following.
 * @param {Object} [opts]
 * @param {'janitor'|'saucepan'} [opts.sourceKind='janitor']
 * @param {number} [opts.limit=50]
 * @param {number} [opts.offset=0]
 * @param {string} [opts.sortBy='total_chats']
 * @param {string} [opts.sortDir='desc']
 * @returns {string}
 */
export function buildDatacatFollowingPath({ sourceKind = 'janitor', limit = 50, offset = 0, sortBy = 'total_chats', sortDir = 'desc' } = {}) {
    const params = new URLSearchParams();
    params.set('sourceKind', sourceKind === 'saucepan' ? 'saucepan' : 'janitor');
    params.set('limit', String(Math.max(1, Number(limit) || 50)));
    params.set('offset', String(Math.max(0, Number(offset) || 0)));
    params.set('sortBy', String(sortBy || 'total_chats'));
    params.set('sortDir', String(sortDir || 'desc'));
    return `/api/creators/following?${params.toString()}`;
}

/**
 * Map a DataCat follow-list row to CL's followed-creator shape.
 * DataCat rows: { creatorId, sourceKind, userName, ... }; CL expects
 * { id, name, source } where janitor follows render as the 'datacat' source.
 * @param {Object|null} row
 * @returns {{id: string, name: string, source: 'datacat'|'saucepan'}|null}
 */
export function mapDatacatFollowRow(row) {
    if (!row || typeof row !== 'object') return null;
    const id = row.creatorId || row.id;
    if (!id) return null;
    return {
        id,
        name: row.userName || row.creatorName || id,
        source: row.sourceKind === 'saucepan' ? 'saucepan' : 'datacat',
    };
}

// ========================================
// METADATA FETCH
// ========================================

/**
 * Fetch full character data from the DataCat REST API.
 * @param {string} characterId - UUID
 * @param {'janitor'|'saucepan'|null} [sourceKind] - upstream source hint; required for freshly-extracted chars
 * @returns {Promise<Object|null>} character object or null
 */
export async function fetchDatacatCharacter(characterId, sourceKind = null) {
    if (!characterId) return null;
    try {
        const qs = sourceKind ? `?sourceKind=${encodeURIComponent(sourceKind)}` : '';
        const response = await dcFetch(`/api/characters/${characterId}${qs}`);
        if (!response.ok) return null;
        const data = await response.json();
        return data?.character || null;
    } catch (e) {
        console.error('[DataCat] fetchDatacatCharacter failed:', characterId, e);
        return null;
    }
}

/**
 * Fetch the V2-like download payload for a character.
 * @param {string} characterId - UUID
 * @param {'janitor'|'saucepan'|null} [sourceKind] - upstream source hint
 * @returns {Promise<Object|null>} { data: { name, tags, avatar, ... } }
 */
export async function fetchDatacatDownload(characterId, sourceKind = null) {
    if (!characterId) return null;
    try {
        const params = new URLSearchParams({ t: String(Date.now()) });
        if (sourceKind) params.set('sourceKind', sourceKind);
        const response = await dcFetch(`/api/characters/${characterId}/download?${params.toString()}`);
        if (!response.ok) return null;
        return response.json();
    } catch (e) {
        console.error('[DataCat] fetchDatacatDownload failed:', characterId, e);
        return null;
    }
}

/**
 * Fetch creator profile.
 * @param {string} creatorId - UUID
 * @returns {Promise<Object|null>}
 */
export async function fetchDatacatCreator(creatorId) {
    if (!creatorId) return null;
    try {
        const response = await dcFetch(`/api/creators/${creatorId}`);
        if (!response.ok) return null;
        const data = await response.json();
        return data?.creator || null;
    } catch (e) {
        console.error('[DataCat] fetchDatacatCreator failed:', creatorId, e);
        return null;
    }
}

/**
 * Fetch a creator's character list (paginated).
 * @param {string} creatorId - UUID
 * @param {Object} [opts]
 * @param {number} [opts.limit=24]
 * @param {number} [opts.offset=0]
 * @param {string} [opts.sortBy='chat_count']
 * @returns {Promise<{total: number, list: Object[]}|null>}
 */
export async function fetchDatacatCreatorCharacters(creatorId, opts = {}) {
    if (!creatorId) return null;
    const { limit = 24, offset = 0, sortBy = 'chat_count' } = opts;
    try {
        const response = await dcFetch(`/api/creators/${creatorId}/characters?limit=${limit}&offset=${offset}&sortBy=${sortBy}`);
        if (!response.ok) return null;
        const data = await response.json();
        return { total: data.total || 0, list: data.list || [] };
    } catch (e) {
        console.error('[DataCat] fetchDatacatCreatorCharacters failed:', creatorId, e);
        return null;
    }
}

/**
 * Fetch the signed-in account's DataCat Yours collection.
 * DataCat's own Yours view uses /api/characters with the account session.
 * @param {Object} [opts]
 * @param {number} [opts.limit=80]
 * @param {number} [opts.offset=0]
 * @param {number[]} [opts.tagIds]
 * @param {number} [opts.minTotalTokens=MIN_TOTAL_TOKENS]
 * @returns {Promise<{totalCount: number, characters: Object[]}|null>}
 */
export async function fetchDatacatYoursCharacters(opts = {}) {
    try {
        const response = await dcFetch(buildDatacatYoursCharactersPath(opts));
        if (!response.ok) return null;
        const data = await response.json();
        if (data?.success === false) return null;
        const characters = Array.isArray(data?.characters) ? data.characters : [];
        return {
            totalCount: data?.count || data?.totalCount || characters.length,
            characters: characters.map(character => ({
                ...character,
                isCollected: true,
                viewer_is_collected: true,
                is_collected: true,
                collected: true,
            })),
        };
    } catch (e) {
        console.error('[DataCat] fetchDatacatYoursCharacters failed:', e);
        return null;
    }
}

// ========================================
// BROWSE / SEARCH
// ========================================

/**
 * Fetch recent public characters (the main browse endpoint).
 * @param {Object} [opts]
 * @param {number} [opts.limit=24]
 * @param {number} [opts.offset=0]
 * @param {number[]} [opts.tagIds] - Active tag ID filters
 * @param {number} [opts.minTotalTokens=MIN_TOTAL_TOKENS]
 * @returns {Promise<{totalCount: number, characters: Object[]}|null>}
 */
export async function fetchRecentPublic(opts = {}) {
    const { limit = 24, offset = 0, tagIds = [], minTotalTokens = MIN_TOTAL_TOKENS } = opts;
    try {
        let path = `/api/characters/recent-public?limit=${limit}&offset=${offset}&summary=1&minTotalTokens=${minTotalTokens}`;
        if (tagIds.length > 0) path += `&tagIds=${tagIds.join(',')}`;
        const response = await dcFetch(path);
        if (!response.ok) return null;
        const data = await response.json();
        return { totalCount: data.totalCount || 0, characters: data.characters || [] };
    } catch (e) {
        console.error('[DataCat] fetchRecentPublic failed:', e);
        return null;
    }
}

/**
 * Fetch fresh/sorted characters from the /fresh endpoint.
 * Returns two time windows: last24h and thisWeek.
 * @param {Object} [opts]
 * @param {string} [opts.sortBy='score'] - 'score' | 'fresh' | 'chat_count'
 * @param {number} [opts.limit24=80] - Max characters for last-24h window
 * @param {number} [opts.limitWeek=20] - Max characters for this-week window
 * @returns {Promise<{sortBy: string, last24h: Object[], thisWeek: Object[]}|null>}
 */
export async function fetchFreshCharacters(opts = {}) {
    const { sortBy = 'score', limit24 = 80, limitWeek = 20 } = opts;
    try {
        const path = `/api/characters/fresh?summary=1&sortBy=${sortBy}&limit24=${limit24}&limitWeek=${limitWeek}`;
        const response = await dcFetch(path);
        if (!response.ok) return null;
        const data = await response.json();
        const w = data.windows || {};
        return {
            sortBy: data.sortBy || sortBy,
            last24h: w.last24h?.characters || [],
            thisWeek: w.thisWeek?.characters || [],
        };
    } catch (e) {
        console.error('[DataCat] fetchFreshCharacters failed:', e);
        return null;
    }
}

/**
 * Fetch faceted tag list with counts (optionally narrowed by active tags).
 * @param {Object} [opts]
 * @param {number[]} [opts.activeTagIds] - Currently selected tag IDs (adjusts counts)
 * @param {number} [opts.minTotalTokens=MIN_TOTAL_TOKENS]
 * @returns {Promise<{groups: Object[], tags: Object[]}|null>}
 */
export async function fetchFacetedTags(opts = {}) {
    const { activeTagIds = [], minTotalTokens = MIN_TOTAL_TOKENS } = opts;
    try {
        let path = `/api/tags/faceted?mode=recent&minTotalTokens=${minTotalTokens}`;
        if (activeTagIds.length > 0) path += `&activeTagIds=${activeTagIds.join(',')}`;
        const response = await dcFetch(path);
        if (!response.ok) return null;
        const data = await response.json();
        return { groups: data.groups || [], tags: data.tags || [] };
    } catch (e) {
        console.error('[DataCat] fetchFacetedTags failed:', e);
        return null;
    }
}

// ========================================
// TAG HELPERS
// ========================================

/**
 * Extract plain tag names from DataCat tags.
 * Tags shape varies by source:
 *   - JanitorAI: array of { id, name, slug } objects with emoji-prefixed names
 *   - Saucepan: array of plain slug strings
 * @param {Array<{name: string, slug: string}|string>} tags
 * @returns {string[]}
 */
export function resolveTagNames(tags) {
    if (!Array.isArray(tags)) return [];
    return tags.map(t => {
        if (typeof t === 'string') return t.trim();
        const name = t?.name || t?.slug || '';
        return name.replace(/^[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]+\s*/u, '').trim() || name;
    }).filter(Boolean);
}

// ========================================
// V2 CARD BUILDER
// ========================================

/**
 * Pick the active server-side recovery variant from a DataCat character row.
 *
 * For Saucepan characters with hidden definitions, DataCat runs a server-side
 * "Character Repair" job and exposes the recovered body via
 * `content_variants[primary].content`. The variant's `description` field is
 * overloaded to carry the repaired body text; the row's top-level fields
 * (`personality`, `description`) remain the empty original / short blurb.
 *
 * @returns {Object|null} The variant content object, or null when no
 *   non-placeholder primary variant is present.
 */
export function pickRecoveryVariant(character) {
    const variants = character?.content_variants;
    if (!Array.isArray(variants) || !variants.length) return null;
    const primary = variants.find(v => v && v.isPrimary && !v.isRecoveryPlaceholder);
    return primary?.content || null;
}

// Extract V2 character_book from character.scripts[]. DataCat stores lorebook
// entries JSON-encoded in script.script; private scripts are metadata stubs.
// Multi-script merge: first script's title/settings win, entries concatenate.
export function extractCharacterBookFromScripts(character) {
    const scripts = character?.scripts;
    if (!Array.isArray(scripts) || !scripts.length) return null;
    const usable = scripts.filter(s => s && s.type === 'lorebook' && s.is_public && s.script);
    if (!usable.length) return null;

    const allEntries = [];
    for (const s of usable) {
        let parsed;
        try { parsed = JSON.parse(s.script); } catch { continue; }
        if (!Array.isArray(parsed)) continue;
        for (const e of parsed) {
            if (!e || typeof e !== 'object') continue;
            const keys = Array.isArray(e.key)
                ? e.key
                : (e.keysRaw ? String(e.keysRaw).split(/,\s*/).filter(Boolean) : []);
            allEntries.push({
                keys,
                secondary_keys: [],
                content: e.content || '',
                extensions: {},
                enabled: e.enabled !== false,
                insertion_order: typeof e.insertion_order === 'number' ? e.insertion_order : (e.priority || 100),
                case_sensitive: false,
                name: e.name || '',
                priority: typeof e.priority === 'number' ? e.priority : 10,
                id: e.id ?? allEntries.length,
                comment: '',
                selective: false,
                constant: e.constant === true,
                position: 'before_char',
            });
        }
    }
    if (!allEntries.length) return null;

    const first = usable[0];
    let scanDepth = 4;
    try {
        const settings = first.settings ? JSON.parse(first.settings) : null;
        if (settings && typeof settings.depth === 'number') scanDepth = settings.depth;
    } catch { /* default */ }

    return {
        name: first.title || 'Lorebook',
        description: first.description || '',
        scan_depth: scanDepth,
        token_budget: 0,
        recursive_scanning: false,
        extensions: {},
        entries: allEntries,
    };
}

/**
 * Build a V2 character card from the character endpoint payload.
 *
 * Field mapping is source-dependent. DataCat aggregates multiple sources, each
 * with different conventions for which field carries the character's body:
 *
 *   JanitorAI (default):
 *     character.personality   -> data.description (main character definition)
 *     character.description   -> data.creator_notes (website blurb)
 *
 *   Saucepan (open definition):
 *     character.description   -> data.description (main character definition)
 *     character.personality   -> usually null
 *     companion_snapshot.full_description
 *       (or chara_card_v2_json.data.creator_notes)
 *                             -> data.creator_notes (formatted blurb/notes)
 *
 *   Saucepan (hidden definition):
 *     `content_variants[primary].content` carries the repaired body via
 *     the `description` field. /download returns empty in this case.
 *     The blurb still lives in `companion_snapshot.full_description`.
 *
 *   Common across sources:
 *     character.scenario      -> data.scenario
 *     character.first_message -> data.first_mes
 *     character.tags          -> data.tags (array of tag name strings)
 *     character.creator_name  -> data.creator
 *
 * @param {Object} character - Character object from /api/characters/:id
 * @returns {Object} V2-spec character card { spec, spec_version, data }
 */
export function buildV2FromDatacat(character) {
    if (!character) return null;

    const tagNames = resolveTagNames(character.tags);
    const recovered = pickRecoveryVariant(character);
    const isSaucepan = character?.primary_content_source_kind === 'saucepan';
    const v2Data = character?.chara_card_v2_json?.data || null;

    // Recovery variant takes precedence: for Saucepan-with-repair items, this
    // is the only source of the body text. Otherwise body source differs by
    // row kind: JanitorAI puts the body in `personality`; Saucepan puts it
    // in `description` (open definition) and exposes a correctly-mapped V2
    // in `chara_card_v2_json.data`.
    const description = recovered?.description
        || recovered?.personality
        || (isSaucepan ? (v2Data?.description || character.description || '') : (character.personality || ''));
    const scenario = recovered?.scenario || character.scenario || (isSaucepan ? (v2Data?.scenario || '') : '');
    const firstMessage = recovered?.first_message || character.first_message || (isSaucepan ? (v2Data?.first_mes || '') : '');
    const creatorNotes = isSaucepan
        ? (character?.companion_snapshot?.full_description
            || character?.intercepted_chat_data?.companion_snapshot?.full_description
            || v2Data?.creator_notes
            || '')
        : (character.description || '');

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: character.chat_name || character.name || 'Unknown',
            description,
            personality: '',
            scenario,
            first_mes: firstMessage,
            mes_example: '',
            system_prompt: '',
            post_history_instructions: '',
            creator_notes: creatorNotes,
            creator: character.creator_name || '',
            character_version: '1.0',
            tags: tagNames,
            alternate_greetings: [],
            extensions: {
                datacat: {
                    id: character.character_id,
                    sourceKind: character.primary_content_source_kind || null,
                    creatorId: character.creator_id || null,
                    creatorName: character.creator_name || null
                }
            },
            character_book: extractCharacterBookFromScripts(character) || undefined
        }
    };
}

/**
 * Build a V2 character card from the /download endpoint response.
 * The download format is already close to V2 but needs wrapping.
 *
 * For Saucepan-with-hidden-definition cards, /download returns empty body
 * fields. When a `character` object is supplied and contains an active
 * recovery variant (`content_variants[primary].content`), we fall back to it
 * for description, scenario, and first_mes. This keeps imports and update
 * checks working for repaired Saucepan cards.
 *
 * @param {Object} downloadData - Response from /api/characters/:id/download
 * @param {Object} [character] - Optional character metadata for enrichment
 * @returns {Object|null}
 */
export function buildV2FromDownload(downloadData, character) {
    const d = downloadData?.data;
    if (!d) return null;

    const recovered = character ? pickRecoveryVariant(character) : null;
    const isSaucepan = character?.primary_content_source_kind === 'saucepan';
    const v2Data = character?.chara_card_v2_json?.data || null;
    const description = d.personality || d.description
        || recovered?.description || recovered?.personality
        || (isSaucepan ? (v2Data?.description || character?.description || '') : '');
    const scenario = d.scenario || recovered?.scenario || '';
    const firstMes = d.first_mes || recovered?.first_message || '';
    const creatorNotes = isSaucepan
        ? (character?.companion_snapshot?.full_description
            || character?.intercepted_chat_data?.companion_snapshot?.full_description
            || v2Data?.creator_notes
            || d.creator_notes
            || '')
        : (character?.description || d.creator_notes || '');

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: d.name || character?.chat_name || 'Unknown',
            description,
            personality: '',
            scenario,
            first_mes: firstMes,
            mes_example: d.mes_example || '',
            system_prompt: d.system_prompt || '',
            post_history_instructions: d.post_history_instructions || '',
            creator_notes: creatorNotes,
            creator: character?.creator_name || d.creator || '',
            character_version: d.character_version || '1.0',
            tags: d.tags || [],
            alternate_greetings: d.alternate_greetings || [],
            extensions: {
                ...(d.extensions || {}),
                datacat: {
                    id: character?.character_id || null,
                    sourceKind: character?.primary_content_source_kind || null,
                    creatorId: character?.creator_id || null,
                    creatorName: character?.creator_name || null
                }
            },
            // Download's character_book is often present-but-empty; fall through to scripts.
            character_book: (d.character_book?.entries?.length ? d.character_book : null)
                || extractCharacterBookFromScripts(character)
                || undefined
        }
    };
}

// ========================================
// EXTRACTION
// ========================================

/**
 * Submit a JanitorAI character URL for extraction via DataCat's cloud browser.
 * @param {string} janitorUrl - Full JanitorAI character URL
 * @param {Object} [opts]
 * @param {boolean} [opts.publicFeed=true]
 * @param {boolean} [opts.alwaysReextract=false] - force re-extraction even if DataCat already has the character
 * @param {boolean} [opts.useAccount=true] - use the restored DataCat account session when available
 * @returns {Promise<{success: boolean, queued?: boolean, started?: boolean, queuePosition?: number, requestId?: string, error?: string, errorCode?: string}>}
 */
export async function submitExtraction(janitorUrl, { publicFeed = true, alwaysReextract = false, useAccount = true } = {}) {
    if (!_apiRequest) throw new Error('DataCat: apiRequest not bound');
    try {
        const resp = await dcHelperRequest(`${CL_HELPER_PLUGIN_BASE}/dc-extract`, 'POST', { url: janitorUrl, publicFeed, alwaysReextract, useAccount });
        if (!resp.ok) {
            const errText = await resp.text();
            console.error('[DataCat] dc-extract error:', resp.status, errText.substring(0, 200));
            return { success: false, error: `Server returned ${resp.status}: ${errText.substring(0, 100)}` };
        }
        try {
            return await resp.json();
        } catch {
            return { success: false, error: 'Invalid JSON response from cl-helper' };
        }
    } catch (e) {
        console.error('[DataCat] submitExtraction failed:', e);
        return { success: false, error: e.message };
    }
}

/**
 * Poll extraction status from DataCat.
 * @returns {Promise<{inProgress: Object|null, queueLength: number, queue: Array, history: Array}|null>}
 */
export async function fetchExtractionStatus() {
    try {
        const resp = await dcFetch('/api/extraction/status-projection');
        if (!resp.ok) return null;
        return await resp.json();
    } catch (e) {
        console.error('[DataCat] fetchExtractionStatus failed:', e);
        return null;
    }
}

// ========================================
// MEILISEARCH (JanitorAI index)
// ========================================

const MEILI_SORT_MAP = {
    janny_newest: ['createdAtStamp:desc'],
    janny_oldest: ['createdAtStamp:asc'],
    janny_tokens_desc: ['totalToken:desc'],
    janny_tokens_asc: ['totalToken:asc'],
    janny_relevant: [],
};

/**
 * Search JanitorAI characters via MeiliSearch.
 * Returns results normalized to DataCat-compatible shape.
 * @param {Object} opts
 * @param {string} [opts.search='']
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=80]
 * @param {string} [opts.sort='janny_newest']
 * @param {boolean} [opts.nsfw=true]
 * @param {Set<number>} [opts.includeTags] - JanitorAI tag IDs to require
 * @returns {Promise<{characters: Object[], totalHits: number, totalPages: number}>}
 */
export async function searchMeiliJanny(opts = {}) {
    const { search = '', page = 1, limit = 80, sort = 'janny_newest', nsfw = true, includeTags = new Set() } = opts;

    const filters = [];
    if (!nsfw) filters.push('isNsfw = false');
    if (includeTags.size > 0) {
        const tagClauses = [...includeTags].map(id => `tagIds = ${id}`);
        filters.push(tagClauses.join(' AND '));
    }

    const sortArr = MEILI_SORT_MAP[sort] || MEILI_SORT_MAP.janny_newest;

    const body = {
        queries: [{
            indexUid: 'janny-characters',
            q: search,
            facets: ['isNsfw', 'tagIds'],
            filter: filters,
            hitsPerPage: limit,
            page,
        }]
    };

    if (sortArr.length > 0) body.queries[0].sort = sortArr;

    const token = await getSearchToken();
    const headers = {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': JANNY_SITE_BASE,
        'Referer': `${JANNY_SITE_BASE}/`,
        'x-meilisearch-client': 'Meilisearch instant-meilisearch (v0.19.0) ; Meilisearch JavaScript (v0.41.0)',
    };

    let response;
    try {
        response = await fetch(JANNY_SEARCH_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (_) {
        response = await fetchWithProxy(JANNY_SEARCH_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`MeiliSearch error ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = await response.json();
    const result = data?.results?.[0] || {};
    const hits = result.hits || [];

    const characters = hits.map(normalizeMeiliHit);

    return {
        characters,
        totalHits: result.totalHits || 0,
        totalPages: result.totalPages || 0,
    };
}

// ========================================
// HAMPTER (JanitorAI internal API)
// ========================================

const HAMPTER_API_BASE = 'https://janitorai.com/hampter/characters';
const FLARESOLVERR_FETCH_PATH = `${CL_HELPER_PLUGIN_BASE}/flaresolverr-fetch`;
const FLARESOLVERR_SESSION_CREATE_PATH = `${CL_HELPER_PLUGIN_BASE}/flaresolverr-session-create`;
const FLARESOLVERR_SESSION_DESTROY_PATH = `${CL_HELPER_PLUGIN_BASE}/flaresolverr-session-destroy`;

/**
 * Create a FlareSolverr session. Sessions keep a Chromium instance hot, so
 * subsequent fetches reuse the cached cf_clearance cookie and skip the
 * challenge - dropping each request from ~5-15s to ~1-3s.
 * @param {string} flareUrl
 * @returns {Promise<string>} the created session ID
 */
export async function createFlareSolverrSession(flareUrl) {
    if (!_apiRequest) throw new Error('cl-helper plugin not available');
    const resp = await _apiRequest(FLARESOLVERR_SESSION_CREATE_PATH, 'POST', { flareUrl });
    let payload = null;
    try { payload = await resp.clone().json(); } catch { /* ignore */ }
    if (!resp.ok || payload?.status !== 'ok' || !payload?.session) {
        throw new Error(payload?.error || payload?.message || 'Failed to create FlareSolverr session');
    }
    return payload.session;
}

/**
 * Destroy a FlareSolverr session. Best-effort; does not throw on failure.
 * @param {string} flareUrl
 * @param {string} sessionId
 */
export async function destroyFlareSolverrSession(flareUrl, sessionId) {
    if (!_apiRequest || !sessionId) return;
    try {
        await _apiRequest(FLARESOLVERR_SESSION_DESTROY_PATH, 'POST', { flareUrl, sessionId });
    } catch (err) {
        console.warn('[DatacatAPI] FlareSolverr session destroy failed:', err.message);
    }
}

/**
 * Fetch a URL via the user's configured FlareSolverr instance through cl-helper.
 * Returns the response body as text on success, or throws on failure.
 * @param {string} flareUrl - User-configured FlareSolverr endpoint (e.g. http://localhost:8191/v1)
 * @param {string} targetUrl - Target URL to fetch through FlareSolverr
 * @param {string} [sessionId] - Optional session ID to reuse a hot Chromium instance
 * @returns {Promise<string>}
 */
async function fetchViaFlareSolverr(flareUrl, targetUrl, sessionId = '') {
    if (!_apiRequest) throw new Error('cl-helper plugin not available');
    const body = { flareUrl, targetUrl };
    if (sessionId) body.sessionId = sessionId;
    const resp = await _apiRequest(FLARESOLVERR_FETCH_PATH, 'POST', body);
    let payload = null;
    try { payload = await resp.clone().json(); } catch { /* ignore */ }
    if (!resp.ok) {
        const msg = payload?.error || `FlareSolverr request failed (HTTP ${resp.status})`;
        const err = new Error(msg);
        if (payload?.message && /session/i.test(payload.message)) err.sessionInvalid = true;
        throw err;
    }
    if (payload?.status !== 'ok' || !payload?.solution) {
        const msg = payload?.message || 'FlareSolverr did not return a solution';
        const err = new Error(msg);
        if (msg && /session/i.test(msg)) err.sessionInvalid = true;
        throw err;
    }
    const upstreamStatus = payload.solution.status;
    if (typeof upstreamStatus === 'number' && upstreamStatus >= 400) {
        const err = new Error(`Upstream HTTP ${upstreamStatus}`);
        err.status = upstreamStatus;
        throw err;
    }
    return payload.solution.response || '';
}

/**
 * Fetch characters from JanitorAI's Hampter API (trending/popular sort).
 * @param {Object} opts
 * @param {string} [opts.sort='trending'] - 'trending' or 'popular'
 * @param {number} [opts.page=1]
 * @param {string} [opts.search='']
 * @param {boolean} [opts.nsfw=true] - false adds mode=sfw
 * @param {string} [opts.flareSolverrUrl] - When set, route the request through this FlareSolverr instance
 * @param {string} [opts.flareSessionId] - Reuse this FlareSolverr session for hot-Chromium speedup
 * @returns {Promise<{characters: Object[], total: number, page: number, pageSize: number}>}
 */
export async function fetchHampterCharacters(opts = {}) {
    const { sort = 'trending', page = 1, search = '', nsfw = true, flareSolverrUrl = '', flareSessionId = '' } = opts;
    const params = new URLSearchParams({ sort, page: String(page) });
    if (search) params.set('search', search);
    if (!nsfw) params.set('mode', 'sfw');

    const url = `${HAMPTER_API_BASE}?${params}`;
    let data;

    if (flareSolverrUrl) {
        try {
            const text = await fetchViaFlareSolverr(flareSolverrUrl, url, flareSessionId);
            // FlareSolverr wraps JSON responses in HTML <pre> tags. Strip them.
            const cleaned = text.replace(/^[\s\S]*?<pre[^>]*>/i, '').replace(/<\/pre>[\s\S]*$/i, '').trim();
            try {
                data = JSON.parse(cleaned || text);
            } catch {
                throw new Error('FlareSolverr returned non-JSON body');
            }
        } catch (err) {
            if (err.status === 401 || err.status === 403) {
                const blocked = new Error(`Hampter HTTP ${err.status}`);
                blocked.code = 'HAMPTER_BLOCKED';
                blocked.status = err.status;
                throw blocked;
            }
            const wrapped = new Error(`FlareSolverr: ${err.message}`);
            wrapped.code = 'FLARESOLVERR_ERROR';
            if (err.sessionInvalid) wrapped.sessionInvalid = true;
            throw wrapped;
        }
    } else {
        let response;
        try {
            response = await fetchWithProxy(url);
        } catch (err) {
            const m = /HTTP (\d+)/.exec(err?.message || '');
            const status = m ? parseInt(m[1], 10) : 0;
            if (status === 401 || status === 403) {
                const blocked = new Error(`Hampter HTTP ${status}`);
                blocked.code = 'HAMPTER_BLOCKED';
                blocked.status = status;
                throw blocked;
            }
            throw err;
        }
        data = await response.json();
    }

    return {
        characters: (data.data || []).map(normalizeHampterHit),
        total: data.total || 0,
        page: data.page || page,
        pageSize: data.size || 34,
    };
}

function normalizeHampterHit(hit) {
    const tagNames = [
        ...(hit.tags || []).map(t => ({ name: t.name, slug: t.slug || t.name?.toLowerCase() })),
        ...(hit.custom_tags || []).map(t => typeof t === 'string' ? { name: t, slug: t.toLowerCase() } : { name: t.name || '', slug: t.slug || '' }),
    ];

    return {
        character_id: hit.id,
        name: decodeHtmlEntities(hit.name || 'Unknown'),
        avatar: hit.avatar || '',
        description: decodeHtmlEntities(hit.description || ''),
        tags: tagNames,
        creator_name: decodeHtmlEntities(hit.creator_name || ''),
        creator_id: hit.creator_id || '',
        created_at: hit.created_at || hit.first_published_at || '',
        is_nsfw: hit.is_nsfw || false,
        chat_count: hit.stats?.chat || 0,
        message_count: hit.stats?.message || 0,
        total_tokens: hit.total_tokens || 0,
        _source: 'hampter',
    };
}

/**
 * Normalize a MeiliSearch hit to match the shape expected by DataCat card rendering.
 */
function normalizeMeiliHit(hit) {
    const tagNames = (hit.tagIds || []).map(id => {
        const name = JANNY_TAG_MAP[id];
        return name ? { name, slug: name.toLowerCase() } : { name: `Tag ${id}`, slug: `tag-${id}` };
    });

    return {
        character_id: hit.id,
        name: decodeHtmlEntities(hit.name || 'Unknown'),
        avatar: hit.avatar || '',
        description: decodeHtmlEntities(hit.description || ''),
        tags: tagNames,
        creator_name: decodeHtmlEntities(hit.creatorUsername || ''),
        creator_id: hit.creatorId || '',
        createdAt: hit.createdAt || (hit.createdAtStamp ? new Date(hit.createdAtStamp * 1000).toISOString() : ''),
        isNsfw: hit.isNsfw || false,
        totalTokens: hit.totalToken || 0,
        _source: 'meilisearch',
    };
}

// ========================================
// SAUCEPAN (saucepan.ai search API)
// ========================================

// Saucepan calls go through cl-helper (/saucepan-proxy/*), not ST's /proxy/.
// Reason: Saucepan responds with zstd-compressed bodies; ST's /proxy/ forwards
// them without the Content-Encoding header, leaving the browser unable to
// decode them. cl-helper negotiates gzip/br/deflate (and falls back to native
// zstd decompress) before returning plain JSON to the client.
const SAUCEPAN_PROXY_BASE = `${CL_HELPER_PLUGIN_BASE}/saucepan-proxy`;
const SAUCEPAN_CDN_BASE = 'https://cdn.saucepan.ai/images';

const SAUCEPAN_ORDER_MAP = {
    saucepan_new: 'created',
    saucepan_trending: 'trending',
    saucepan_popular: 'popularity',
};

async function saucepanFetch(method, apiPath, body) {
    if (!_apiRequest) throw new Error('Saucepan: apiRequest not bound (cl-helper required)');
    const url = `${SAUCEPAN_PROXY_BASE}${apiPath}`;
    return method === 'POST'
        ? _apiRequest(url, 'POST', body)
        : _apiRequest(url);
}

/**
 * Search Saucepan companions via the Saucepan API (proxied through cl-helper).
 * Returns results normalized to DataCat-compatible shape.
 * @param {Object} opts
 * @param {string} [opts.search='']
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=96]
 * @param {string} [opts.sort='saucepan_new']
 * @param {boolean} [opts.openDefinitionOnly=true]
 * @param {string[]} [opts.tags=[]] - Tag slugs to include (AND match)
 * @param {string[]} [opts.excludedTags=[]] - Tag slugs to exclude
 * @returns {Promise<{characters: Object[], totalCount: number, totalPages: number}>}
 */
export async function searchSaucepan(opts = {}) {
    const {
        search = '',
        page = 1,
        limit = 96,
        sort = 'saucepan_new',
        openDefinitionOnly = true,
        tags = [],
        excludedTags = [],
    } = opts;
    const orderBy = SAUCEPAN_ORDER_MAP[sort] || 'created';
    const offset = Math.max(0, (page - 1) * limit);

    const body = {
        text_search: search || null,
        tags: Array.isArray(tags) ? tags : [],
        excluded_tags: Array.isArray(excludedTags) ? excludedTags : [],
        fandom_tags: [],
        excluded_fandom_tags: [],
        match_all_fandom_tags: false,
        limit,
        offset,
        sus: true,
        extra_spicy: null,
        order_by: orderBy,
        asc: false,
        posted_at_from: null,
        posted_at_to: null,
        match_all_tags: true,
        hide_hidden_content: false,
        open_definition_only: openDefinitionOnly,
    };

    let response;
    try {
        response = await saucepanFetch('POST', '/api/v1/search', body);
    } catch (err) {
        throw new Error(`Saucepan search failed: ${err.message}`);
    }
    if (!response.ok) throw new Error(`Saucepan HTTP ${response.status}`);

    const data = await response.json();
    const companions = data?.companions || [];
    const totalCount = data?.total_count || 0;
    const totalPages = limit > 0 ? Math.ceil(totalCount / limit) : 0;

    return {
        characters: companions.map(normalizeSaucepanHit),
        totalCount,
        totalPages,
    };
}

function normalizeSaucepanHit(hit) {
    const imageId = hit?.image?.id || '';
    const avatar = imageId ? `${SAUCEPAN_CDN_BASE}/${imageId}/card` : '';
    const tags = Array.isArray(hit.tags) ? hit.tags : [];

    return {
        character_id: hit.id,
        name: hit.display_name || hit.name || 'Unknown',
        avatar,
        description: hit.short_description || '',
        tags,
        creator_name: hit.author_handle || '',
        creator_id: hit.author_id || '',
        createdAt: hit.posted_at || '',
        isNsfw: !!hit.sus,
        totalTokens: hit.card_token_count || 0,
        chat_count: hit.chat_count || 0,
        message_count: hit.interaction_count || 0,
        favorite_count: hit.favorite_count || 0,
        portrait_count: hit.portrait_count || 0,
        scenario_count: hit.scenario_count || 0,
        lorebook_count: hit.lorebook_count || 0,
        locked_starting_message: !!hit.locked_starting_message,
        primary_content_source_kind: 'saucepan',
        _source: 'saucepan',
    };
}

/**
 * Fetch all companions authored by a Saucepan handle.
 * The endpoint returns the full list in one response (no real pagination
 * support: limit/offset are ignored server-side, total_count == count).
 * @param {string} handle - Saucepan author handle
 * @returns {Promise<{characters: Object[], totalCount: number}>}
 */
export async function fetchSaucepanCompanionsOfUser(handle) {
    if (!handle) return { characters: [], totalCount: 0 };
    let response;
    try {
        response = await saucepanFetch('GET', `/api/v1/companions-of-user?handle=${encodeURIComponent(handle)}`);
    } catch (err) {
        throw new Error(`Saucepan creator fetch failed: ${err.message}`);
    }
    if (!response.ok) throw new Error(`Saucepan HTTP ${response.status}`);
    const data = await response.json();
    const companions = data?.companions || [];
    return {
        characters: companions.map(normalizeSaucepanHit),
        totalCount: data?.total_count ?? companions.length,
    };
}

/**
 * Fetch a single Saucepan companion's detail by id.
 * Returns the raw `companion` object, or null on failure.
 * The detail endpoint exposes `open_definition` (boolean), which the
 * search/listing endpoint does not include.
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function fetchSaucepanCompanion(id) {
    if (!id) return null;
    try {
        const response = await saucepanFetch('GET', `/api/v1/companion?id=${encodeURIComponent(id)}`);
        if (!response.ok) return null;
        const data = await response.json();
        return data?.companion || null;
    } catch {
        return null;
    }
}
