// Accept copied Supabase sessions or Janny's native access/refresh cookie pair.
// The helper installs the native cookies; the browser owns subsequent renewal.

const ACCESS_TOKEN_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const JANNY_COOKIE_RE = /^sb-(?:eenzcbluoctduymzksoq-)?auth-token(?:\.(\d+))?$/i;

function b64decode(value) {
    let text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    while (text.length % 4) text += '=';
    return atob(text);
}

function sessionValueFromCookieHeader(raw) {
    const input = String(raw || '').replace(/^cookie\s*:\s*/i, '');
    if (!input.includes('=')) return input.trim();

    const chunks = new Map();
    let chunkSequenceInvalid = false;
    let unchunked = '';
    let legacyAccess = '';
    let legacyRefresh = '';
    let hasNative = false;
    for (const part of input.split(';')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (name.toLowerCase() === 'sb-access-token') { legacyAccess = value; hasNative = true; }
        if (name.toLowerCase() === 'sb-refresh-token') { legacyRefresh = value; hasNative = true; }
        const match = name.match(JANNY_COOKIE_RE);
        if (!match) continue;
        if (match[1] == null) unchunked = value;
        else {
            const index = Number(match[1]);
            if (chunks.has(index)) chunkSequenceInvalid = true;
            chunks.set(index, value);
        }
    }
    if (hasNative) {
        const decode = value => { try { return decodeURIComponent(value); } catch { return value; } };
        return JSON.stringify({ access_token: decode(legacyAccess), refresh_token: decode(legacyRefresh) });
    }
    if (chunks.size > 0) {
        const indices = [...chunks.keys()].sort((a, b) => a - b);
        if (chunkSequenceInvalid || indices.some((index, position) => index !== position)) return '';
        return indices.map(index => chunks.get(index)).join('');
    }
    return unchunked || input.trim();
}

/**
 * Accept JannyAI's full sb-...-auth-token cookie, its base64 value, raw
 * Supabase session JSON, the old sb-access-token cookie, or a bare JWT.
 */
export function parseJannySession(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let value = sessionValueFromCookieHeader(raw);
    try { value = decodeURIComponent(value); } catch { /* already decoded */ }
    if (value.startsWith('base64-')) value = value.slice('base64-'.length);

    let session = null;
    try {
        const decoded = b64decode(value);
        if (decoded.includes('access_token')) session = JSON.parse(decoded);
    } catch { /* not base64 session JSON */ }
    if (!session && value.trimStart().startsWith('{')) {
        try { session = JSON.parse(value); } catch { /* not raw session JSON */ }
    }
    if (session?.access_token) {
        return {
            access_token: String(session.access_token),
            refresh_token: String(session.refresh_token || ''),
        };
    }
    const jwt = value.match(ACCESS_TOKEN_RE)?.[0] || '';
    return jwt ? { access_token: jwt, refresh_token: '' } : null;
}

export function decodeJannyClaims(jwt) {
    try {
        const payload = JSON.parse(b64decode(String(jwt).split('.')[1]));
        return {
            email: payload.email || '',
            expMs: (payload.exp || 0) * 1000,
            subject: payload.sub || '',
            issuer: payload.iss || '',
        };
    } catch {
        return { email: '', expMs: 0, subject: '', issuer: '' };
    }
}
