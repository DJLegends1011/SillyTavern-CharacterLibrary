// JanitorAI userscript bridge: postMessage transport for Cloudflare-gated fetches.

import { isCloudflareBlockPage } from './provider-utils.js';

const PAGE_SRC = 'character-library';
const SCRIPT_SRC = 'cl-janitor-bridge';
const REQUEST_TIMEOUT_MS = 25000;

let bridgeReady = false;
let bridgeCaps = {};
let initialized = false;
const pending = new Map();

// Cooldown-gated so a burst of concurrent requests can't each trigger a tab cycle.
const CLEARANCE_COOLDOWN_MS = 90000;
// Must exceed the userscript's clearance poll budget or this side gives up mid-refresh.
const CLEARANCE_TIMEOUT_MS = 40000;
const lastClearance = new Map();
let clearanceInFlight = null;
let clearanceInFlightHost = '';

function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function requestClearance(host) {
    if (!bridgeReady || !bridgeCaps.clearance || !host) return Promise.resolve(false);
    // Join a refresh already running for this host BEFORE the cooldown check: the warm-up stamps
    // the cooldown on its way in, so a caller racing it would otherwise be bounced and give up
    // while the clearance tab is still solving.
    if (clearanceInFlight && clearanceInFlightHost === host) return clearanceInFlight;
    const last = lastClearance.get(host) || 0;
    if (Date.now() - last < CLEARANCE_COOLDOWN_MS) return Promise.resolve(false);
    if (clearanceInFlight) return clearanceInFlight;

    lastClearance.set(host, Date.now());
    clearanceInFlightHost = host;
    console.info(`[CL] Cloudflare challenged ${host}; asking the userscript to refresh clearance`);
    clearanceInFlight = new Promise((resolve) => {
        const id = `clc_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const timer = setTimeout(() => { pending.delete(id); resolve(false); }, CLEARANCE_TIMEOUT_MS);
        pending.set(id, { resolve: (r) => resolve(!!r?.ok), timer });
        window.postMessage({ source: PAGE_SRC, type: 'clearance', id, host }, window.location.origin);
    }).finally(() => { clearanceInFlight = null; clearanceInFlightHost = ''; });
    return clearanceInFlight;
}

function handleMessage(e) {
    // Origin-guarded, not e.source===window: Firefox Xray-wraps the userscript so the windows aren't identity-equal.
    if (e.origin !== window.location.origin) return;
    const msg = e.data;
    if (!msg || msg.source !== SCRIPT_SRC) return;

    if (msg.type === 'ready') {
        if (!bridgeReady) console.debug(`[CL] JanitorAI userscript bridge connected${msg.version ? ` (v${msg.version})` : ''}`);
        bridgeReady = true;
        bridgeCaps = msg.caps && typeof msg.caps === 'object' ? msg.caps : {};
        return;
    }
    if (msg.type === 'result') {
        const p = pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.resolve({ ok: !!msg.ok, status: msg.status || 0, body: typeof msg.body === 'string' ? msg.body : '' });
    }
}

export function initJanitorBridge() {
    if (initialized) return;
    initialized = true;
    window.addEventListener('message', handleMessage);
    // Re-triggers the userscript's ready announce in case it loaded before this handler attached.
    window.postMessage({ source: PAGE_SRC, type: 'ping' }, window.location.origin);
}

export function isJanitorBridgeAvailable() {
    return bridgeReady;
}

/**
 * Pre-warm Cloudflare clearance for a host. Fire-and-forget, never throws.
 * @param {string} url - an allowlisted URL on the host to warm
 */
export async function warmJanitorClearance(url) {
    if (!bridgeReady || !bridgeCaps.clearance) return false;
    const host = hostOf(url);
    if (!host) return false;
    if (Date.now() - (lastClearance.get(host) || 0) < CLEARANCE_COOLDOWN_MS) return false;
    try {
        const res = await bridgeFetchOnce(url, '');
        if (res.ok || !isCloudflareBlockPage(res.body)) return false;
        return await requestClearance(host);
    } catch {
        return false;
    }
}

// Rejects on transport failure (no bridge / timeout) so callers can fall back to a direct fetch.
function bridgeFetchOnce(url, authToken) {
    return new Promise((resolve, reject) => {
        if (!bridgeReady) {
            reject(new Error('JanitorAI bridge not available'));
            return;
        }
        const id = `clj_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('JanitorAI bridge request timed out'));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        window.postMessage({ source: PAGE_SRC, type: 'fetch', id, url, authToken }, window.location.origin);
    });
}

/**
 * @param {string} url
 * @param {string} [authToken]
 * @param {{ allowClearance?: boolean }} [opts] - opts into the background-tab clearance refresh; leave off for batch/background work.
 */
export async function janitorBridgeFetch(url, authToken = '', opts = {}) {
    const res = await bridgeFetchOnce(url, authToken);
    // A 401 is an auth failure, not a clearance one: let it fall through so the coded errors still classify it.
    if (res.ok || res.status === 401 || !isCloudflareBlockPage(res.body)) return res;
    if (!opts.allowClearance) return res;
    if (!(await requestClearance(hostOf(url)))) return res;
    try {
        return await bridgeFetchOnce(url, authToken);
    } catch {
        return res;
    }
}
