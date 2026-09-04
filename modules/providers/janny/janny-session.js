import CoreAPI from '../../core-api.js';
import { decodeJannyClaims, parseJannySession } from './janny-auth.js';

const JANNY_ISSUER = 'https://eenzcbluoctduymzksoq.supabase.co/auth/v1';

let browserHooks = {
    setSession: async () => ({ ok: false, error: 'Browser client not initialized' }),
    status: async () => ({ active: false, hasRefresh: false, refreshable: false }),
    refresh: async () => ({ active: false, hasRefresh: false, refreshable: false }),
    logout: async () => ({ ok: false, error: 'Browser client not initialized' }),
};
let recoveryInFlight = null;

export function setJannySessionBrowserHooks(hooks) {
    browserHooks = { ...browserHooks, ...hooks };
}

function redactedStatus(value) {
    const expMs = Number(value?.expMs);
    return {
        active: Boolean(value?.active),
        email: typeof value?.email === 'string' ? value.email : '',
        expMs: Number.isFinite(expMs) ? expMs : 0,
        hasRefresh: Boolean(value?.hasRefresh),
        refreshable: Boolean(value?.refreshable),
    };
}

function clearLegacySettings() {
    CoreAPI.setSetting('jannyToken', null);
    CoreAPI.setSetting('jannyRefreshToken', null);
}

export async function jannySessionStatus() {
    return redactedStatus(await browserHooks.status());
}

export function jannyRecoverSession() {
    if (!recoveryInFlight) {
        recoveryInFlight = Promise.resolve()
            .then(() => browserHooks.refresh())
            .then(redactedStatus)
            .finally(() => { recoveryInFlight = null; });
    }
    return recoveryInFlight;
}

export async function jannySetSession(raw) {
    const pair = parseJannySession(raw);
    if (!pair) return { ok: false, error: 'Could not find a JannyAI login session in that value.' };

    const claims = decodeJannyClaims(pair.access_token);
    if (claims.issuer !== JANNY_ISSUER) {
        return { ok: false, error: 'That token belongs to a different site, not JannyAI.' };
    }
    if (!pair.refresh_token && claims.expMs && claims.expMs <= Date.now()) {
        return { ok: false, error: 'That JannyAI login token has expired. Copy a fresh complete session.' };
    }

    const installed = await browserHooks.setSession(pair.access_token, pair.refresh_token);
    if (installed?.ok === false) {
        return { ok: false, error: 'Could not install the JannyAI session in the browser.' };
    }

    let status = await jannySessionStatus();
    if (!status.active && status.hasRefresh) status = await jannyRecoverSession();
    if (!status.active) {
        return { ok: false, error: 'JannyAI browser session is not active.', ...status };
    }

    clearLegacySettings();
    return { ok: true, ...status };
}

export async function jannyLogout() {
    clearLegacySettings();
    const result = await browserHooks.logout();
    const output = { ok: result?.ok !== false };
    if (Array.isArray(result?.cleared)) output.cleared = result.cleared.map(String);
    if (!output.ok) output.error = 'JannyAI browser logout failed.';
    return output;
}

export function initJannySession() {
    window.jannySetSession = jannySetSession;
    window.jannySessionStatus = jannySessionStatus;
    window.jannyRecoverSession = jannyRecoverSession;
    window.jannyLogout = jannyLogout;
}
