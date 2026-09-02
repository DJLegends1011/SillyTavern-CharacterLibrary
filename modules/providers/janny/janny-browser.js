import CoreAPI from '../../core-api.js';
import { CL_HELPER_PLUGIN_BASE } from '../provider-utils.js';

const MAX_TOKEN_LENGTH = 16_384;
const DEFAULT_FETCH_TIMEOUT_MS = 90_000;

const JANNY_ERROR_MESSAGES = {
    JANNY_HELPER_UNAVAILABLE: 'JannyAI browser helper is unavailable.',
    JANNY_BROWSER_UNAVAILABLE: 'JannyAI browser endpoint is unavailable.',
    JANNY_BROWSER_TIMEOUT: 'JannyAI browser request timed out.',
    JANNY_CF_BLOCKED: 'JannyAI is blocked by a Cloudflare challenge.',
    JANNY_LOGIN_REQUIRED: 'JannyAI login is required.',
    JANNY_TOKEN_EXPIRED: 'JannyAI login token has expired.',
    JANNY_TOKEN_REJECTED: 'JannyAI login token was rejected.',
    JANNY_RATE_LIMITED: 'JannyAI rate limit reached.',
    JANNY_PAGE_SHAPE_CHANGED: 'JannyAI returned an unrecognized character page.',
    JANNY_REQUEST_BLOCKED: 'JannyAI browser request was blocked by policy.',
    JANNY_HTTP_ERROR: 'JannyAI browser request failed.',
};

export function getJannyBrowserMode() {
    return CoreAPI.getSetting('janitoraiBrowserMode') || 'managed';
}

export function getJannyBrowserEndpoint() {
    return String(CoreAPI.getSetting('janitoraiBrowserEndpoint') || '').trim();
}

export function jannyBrowserTarget(endpoint = '') {
    if (endpoint) return { endpoint };
    return getJannyBrowserMode() === 'managed'
        ? { managed: true }
        : { endpoint: getJannyBrowserEndpoint() };
}

function createJannyError(code, status = 0) {
    const error = new Error(JANNY_ERROR_MESSAGES[code] || JANNY_ERROR_MESSAGES.JANNY_HTTP_ERROR);
    error.code = code;
    error.status = status;
    return error;
}

function classifyJannyFailure({ error = '', body = '', status = 0, helperStatus = 0, path = '' } = {}) {
    const detail = `${error} ${body}`.toLowerCase();
    if (detail.includes('janny_request_blocked') || /policy|not permitted|not allowed/.test(detail)) return 'JANNY_REQUEST_BLOCKED';
    if (/cloudflare|cf[_ -]?clearance|captcha|just a moment|attention required|challenge/.test(detail)) return 'JANNY_CF_BLOCKED';
    if (/timeout|timed out/.test(detail)) return 'JANNY_BROWSER_TIMEOUT';
    if (helperStatus === 404 || /helper|plugin|health|version/.test(detail)) return 'JANNY_HELPER_UNAVAILABLE';
    if (/connect|endpoint|process|browser transport|session update|logout failed|cdp|econn|managed browser/.test(detail)) return 'JANNY_BROWSER_UNAVAILABLE';
    if (status === 401) {
        return /(?:^|\/)(?:user|auth\/v1\/token|refresh)(?:[/?]|$)/i.test(path)
            ? 'JANNY_TOKEN_REJECTED'
            : 'JANNY_LOGIN_REQUIRED';
    }
    if (status === 429) return 'JANNY_RATE_LIMITED';
    if (/unknown character schema|page shape/.test(detail)) return 'JANNY_PAGE_SHAPE_CHANGED';
    return 'JANNY_HTTP_ERROR';
}

function throwAbort(signal) {
    if (signal?.reason !== undefined) throw signal.reason;
    throw new DOMException('The operation was aborted.', 'AbortError');
}

function isExpiredJannyToken(token) {
    if (typeof token !== 'string' || !token) return false;
    try {
        const part = token.split('.')[1];
        if (!part) return false;
        const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
        const claims = JSON.parse(atob(base64));
        return Number.isFinite(claims?.exp) && claims.exp <= Math.floor(Date.now() / 1000);
    } catch {
        return false;
    }
}

async function callHelper(route, body, { timeoutMs = 180_000, signal = null } = {}) {
    if (signal?.aborted) throwAbort(signal);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const helperSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
    let response;
    try {
        response = await CoreAPI.apiRequest(`${CL_HELPER_PLUGIN_BASE}${route}`, 'POST', body, { signal: helperSignal });
    } catch (error) {
        if (signal?.aborted) throwAbort(signal);
        const code = timeoutSignal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError'
            ? 'JANNY_BROWSER_TIMEOUT'
            : classifyJannyFailure({ error: error?.message || '' });
        throw createJannyError(code);
    }
    if (!response) throw createJannyError('JANNY_HELPER_UNAVAILABLE');

    let data = null;
    try {
        data = await response.json();
    } catch {
        throw createJannyError(classifyJannyFailure({ helperStatus: response.status, error: 'non-JSON helper response' }), response.status);
    }
    if (!response.ok || data?.ok === false) {
        throw createJannyError(classifyJannyFailure({
            helperStatus: response.status,
            error: data?.error || '',
        }), response.status);
    }
    return data;
}

export async function testJannyBrowserEndpoint(endpoint) {
    return callHelper('/jannyai-browser-test', jannyBrowserTarget(endpoint), { timeoutMs: 120_000 });
}

export async function jannyBrowserFetch(path, {
    method = 'GET', token = '', jsonBody, formBody, inspectCharacterId, endpoint, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal = null,
} = {}) {
    if (isExpiredJannyToken(token)) throw createJannyError('JANNY_TOKEN_EXPIRED');
    const data = await callHelper('/jannyai-browser-fetch', {
        ...jannyBrowserTarget(endpoint),
        path,
        method: String(method || 'GET').toUpperCase(),
        ...(token ? { token } : {}),
        jsonBody,
        formBody,
        inspectCharacterId,
    }, { timeoutMs, signal });
    const status = Number(data.status) || 0;
    if (status < 200 || status >= 300) throw createJannyError(classifyJannyFailure({ status, body: data.body || '', path }), status);
    if (inspectCharacterId && status >= 200 && status < 300 && data.hydratedCharacter === null) {
        throw createJannyError('JANNY_PAGE_SHAPE_CHANGED', status);
    }
    return {
        status,
        body: data.body,
        finalUrl: data.finalUrl,
        hydratedCharacter: data.hydratedCharacter,
    };
}

export async function jannyBrowserSetSession(token, refreshToken, endpoint) {
    return callHelper('/jannyai-browser-session', {
        ...jannyBrowserTarget(endpoint),
        token: String(token || '').slice(0, MAX_TOKEN_LENGTH),
        refreshToken: String(refreshToken || '').slice(0, MAX_TOKEN_LENGTH),
    }, { timeoutMs: 90_000 });
}

export async function jannyBrowserLogout(endpoint) {
    return callHelper('/jannyai-browser-logout', jannyBrowserTarget(endpoint), { timeoutMs: 60_000 });
}

export function initJannyBrowserClient() {
    window.jannyTestBrowserEndpoint = testJannyBrowserEndpoint;
    window.jannyBrowserSetSession = jannyBrowserSetSession;
    window.jannyBrowserLogout = jannyBrowserLogout;
}
