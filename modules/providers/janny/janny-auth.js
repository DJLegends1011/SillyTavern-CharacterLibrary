// JannyAI Supabase session parsing. The account API accepts the access JWT as
// `Authorization: Bearer ...`; the userscript only has to carry that request
// past Cloudflare. This deliberately mirrors the JanitorAI Hampter login flow.

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

    const chunks = [];
    let unchunked = '';
    let legacyAccess = '';
    for (const part of input.split(';')) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (name.toLowerCase() === 'sb-access-token') legacyAccess = value;
        const match = name.match(JANNY_COOKIE_RE);
        if (!match) continue;
        if (match[1] == null) unchunked = value;
        else chunks[Number(match[1])] = value;
    }
    return chunks.filter(value => value != null).join('') || unchunked || legacyAccess || input.trim();
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
