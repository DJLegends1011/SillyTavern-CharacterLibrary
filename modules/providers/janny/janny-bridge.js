// JannyAI userscript bridge (transport for account sync + public collection pages).
//
// Character Library supplies a saved Supabase bearer token; the companion userscript
// supplies Cloudflare-capable transport. This mirrors the maintainer's Hampter bridge:
// no JannyAI tab or ambient Janny login session needs to remain open.
//
// Pure postMessage transport, mirroring datacat/janitor-bridge.js but with write support
// (method/body/contentType) and finalUrl surfaced for redirect-answering form POSTs.
// Distinct message tags keep the two userscripts from ever processing each other's traffic.

const PAGE_SRC = 'character-library-janny';
const SCRIPT_SRC = 'cl-janny-bridge';
const REQUEST_TIMEOUT_MS = 30000;
const HANDSHAKE_TIMEOUT_MS = 750;

let bridgeReady = false;
let initialized = false;
const pending = new Map(); // requestId -> { resolve, timer }
const readyWaiters = new Set();

function pingBridge() {
    postBridgeMessage({ source: PAGE_SRC, type: 'ping' });
}

function postBridgeMessage(message) {
    // Direct-tab mode talks to a userscript in this window. Embedded mode also sends
    // to the outer SillyTavern page because Firefox mobile may inject @noframes
    // userscripts there only. The top-page bridge replies to this iframe via e.source.
    window.postMessage(message, window.location.origin);
    if (window.parent && window.parent !== window) {
        window.parent.postMessage(message, window.location.origin);
    }
}

function handleMessage(e) {
    // Origin-guarded, not e.source === window: the userscript runs behind an Xray wrapper
    // (Firefox), so its window is not identity-equal to the page's.
    if (e.origin !== window.location.origin) return;
    const msg = e.data;
    if (!msg || msg.source !== SCRIPT_SRC) return;

    if (msg.type === 'ready') {
        if (!bridgeReady) console.debug('[CL] JannyAI userscript bridge connected');
        bridgeReady = true;
        for (const resolve of readyWaiters) resolve(true);
        readyWaiters.clear();
        return;
    }
    if (msg.type === 'result') {
        const p = pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.resolve({
            ok: !!msg.ok,
            status: msg.status || 0,
            body: typeof msg.body === 'string' ? msg.body : '',
            finalUrl: typeof msg.finalUrl === 'string' ? msg.finalUrl : '',
        });
    }
}

export function initJannyBridge() {
    if (initialized) return;
    initialized = true;
    window.addEventListener('message', handleMessage);
    // Symmetric handshake: the userscript announces 'ready' on load, and this ping
    // re-triggers that announce if the userscript attached first.
    pingBridge();
    // Settings UI (app/library.js) lives outside the module graph; give it a handle.
    window.clJannyBridge = {
        isAvailable: isJannyBridgeAvailable,
        refresh: refreshJannyBridgeAvailability,
        request: jannyBridgeFetch,
    };
}

export function isJannyBridgeAvailable() {
    return bridgeReady;
}

// Re-run the handshake and wait briefly for a fresh ready reply. A timeout resets the
// stale ready flag so Settings reports the userscript's current state.
export function refreshJannyBridgeAvailability() {
    if (!initialized) initJannyBridge();

    return new Promise((resolve) => {
        let timer;
        const finish = (available) => {
            clearTimeout(timer);
            readyWaiters.delete(finish);
            bridgeReady = available;
            resolve(available);
        };
        readyWaiters.add(finish);
        timer = setTimeout(() => finish(false), HANDSHAKE_TIMEOUT_MS);
        pingBridge();
    });
}

// Resolves { ok, status, body, finalUrl }; rejects on transport failure (no bridge /
// timeout) so callers can surface an install-the-userscript state.
export function jannyBridgeFetch(method, url, { body, contentType, authToken } = {}) {
    return new Promise((resolve, reject) => {
        if (!bridgeReady) {
            reject(new Error('JannyAI bridge not available'));
            return;
        }
        const id = `cljy_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('JannyAI bridge request timed out'));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        postBridgeMessage({ source: PAGE_SRC, type: 'fetch', id, method, url, body, contentType, authToken });
    });
}
