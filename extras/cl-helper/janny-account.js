export const JANNY_BASE = 'https://jannyai.com';
export const JANNY_ACCOUNT_TIMEOUT_MS = 90_000;
export const JANNY_DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const COOKIE_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHARACTER_PATH_RE = /^\/characters\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:_[^/?#]+)?$/i;
const COLLECTION_CHARACTERS_RE = /^\/api\/collections\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/characters$/i;

export function sanitizeJannyCookieHeader(input) {
    if (!input || typeof input !== 'string') {
        return { ok: false, error: 'cookie string is required' };
    }

    let raw = input.trim();
    raw = raw.replace(/^cookie\s*:\s*/i, '').trim();
    if (!raw) return { ok: false, error: 'cookie string is required' };
    if (raw.length > 8192) return { ok: false, error: 'cookie string is too long' };
    if (/[\0\r\n]/.test(raw)) return { ok: false, error: 'cookie string contains control characters' };

    const cookies = [];
    for (const part of raw.split(';')) {
        const item = part.trim();
        if (!item) continue;
        const eq = item.indexOf('=');
        if (eq <= 0) return { ok: false, error: 'cookie entries must be name=value pairs' };

        const name = item.slice(0, eq).trim();
        const value = item.slice(eq + 1).trim();
        if (!COOKIE_NAME_RE.test(name)) return { ok: false, error: 'cookie name is not valid' };
        if (/[\0\r\n;]/.test(value)) return { ok: false, error: 'cookie value is not valid' };
        cookies.push({ name, value });
    }

    if (!cookies.length) return { ok: false, error: 'no cookie entries found' };
    return {
        ok: true,
        header: cookies.map(c => `${c.name}=${c.value}`).join('; '),
        cookies,
    };
}

export function sanitizeJannyUserAgent(input) {
    if (!input || typeof input !== 'string') return JANNY_DEFAULT_UA;
    const value = input.trim();
    if (!value || value.length > 512 || /[\0\r\n]/.test(value)) return JANNY_DEFAULT_UA;
    return value;
}

export function detectJannyCloudflareChallenge({ status = 0, headers = {}, body = '' } = {}) {
    const getHeader = (name) => {
        if (!headers) return '';
        if (typeof headers.get === 'function') return headers.get(name) || '';
        const direct = headers[name] ?? headers[name.toLowerCase()];
        return direct == null ? '' : String(direct);
    };

    if (String(getHeader('cf-mitigated')).toLowerCase() === 'challenge') return true;
    const server = String(getHeader('server')).toLowerCase();
    const text = String(body || '');
    const lower = text.toLowerCase();

    if (status === 403 && server.includes('cloudflare')) return true;
    return lower.includes('just a moment')
        || lower.includes('/cdn-cgi/challenge-platform/')
        || lower.includes('cf-chl-')
        || lower.includes('cf_chl_')
        || lower.includes('challenge-platform');
}

export function parseJannyBookmarkPage(html) {
    const text = String(html || '');
    const totalMatch = text.match(/Saved\s+Characters\s*\(\s*([0-9,]+)\s*\)/i);
    const totalCount = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ''), 10) : null;
    const seen = new Set();
    const characterIds = [];
    const characterUrls = [];
    const linkRe = /href=["'](https:\/\/jannyai\.com)?(\/characters\/[0-9a-f-]+(?:_[^"'?#\s<>]+)?)/ig;

    let match;
    while ((match = linkRe.exec(text))) {
        const path = match[2].replace(/&amp;/g, '&');
        const idMatch = path.match(CHARACTER_PATH_RE);
        if (!idMatch) continue;
        const id = idMatch[1];
        if (seen.has(id)) continue;
        seen.add(id);
        characterIds.push(id);
        characterUrls.push(`${JANNY_BASE}${path}`);
    }

    return { totalCount, characterIds, characterUrls };
}

function parseAccountPath(path) {
    if (!path || typeof path !== 'string') return null;
    if (/^https?:\/\//i.test(path)) return null;
    if (!path.startsWith('/')) return null;
    if (path.length > 1024 || /[\0\r\n]/.test(path)) return null;
    let parsed;
    try { parsed = new URL(path, JANNY_BASE); } catch { return null; }
    if (parsed.origin !== JANNY_BASE) return null;
    return parsed;
}

function hasOnlyParams(searchParams, allowed) {
    for (const key of searchParams.keys()) {
        if (!allowed.includes(key)) return false;
    }
    return true;
}

function csvIdsAreSafe(value) {
    if (!value || typeof value !== 'string' || value.length > 4096) return false;
    return value.split(',').every(id => UUID_RE.test(id.trim()));
}

export function isAllowedJannyAccountRequest(method, path) {
    const verb = String(method || 'GET').toUpperCase();
    const parsed = parseAccountPath(path);
    if (!parsed) return false;

    const pathname = parsed.pathname;
    const params = parsed.searchParams;

    if (verb === 'GET' && (pathname === '/bookmark' || pathname === '/collections')) {
        return hasOnlyParams(params, ['page', 'sort', 'q']);
    }

    if (verb === 'GET' && CHARACTER_PATH_RE.test(pathname)) {
        return params.size === 0;
    }

    if (pathname === '/api/bookmark') {
        if (verb === 'GET' || verb === 'POST') return params.size === 0;
        if (verb === 'DELETE') return hasOnlyParams(params, ['ids']) && csvIdsAreSafe(params.get('ids'));
        return false;
    }

    if (verb === 'GET' && pathname === '/api/get-characters') {
        return hasOnlyParams(params, ['ids']) && csvIdsAreSafe(params.get('ids'));
    }

    if (verb === 'GET' && pathname === '/api/collections/mine') {
        return params.size === 0;
    }

    const collectionMatch = pathname.match(COLLECTION_CHARACTERS_RE);
    if (collectionMatch) {
        if (verb === 'GET' || verb === 'POST') return params.size === 0;
        if (verb === 'DELETE') return hasOnlyParams(params, ['characterId']) && UUID_RE.test(params.get('characterId') || '');
        return false;
    }

    // Best-effort support for create collection. If Janny changes this endpoint,
    // the helper will still fail closed for every unrelated account API.
    if (pathname === '/api/collections' && verb === 'POST') {
        return params.size === 0;
    }

    return false;
}

export function buildJannyAccountUrl(path) {
    const parsed = parseAccountPath(path);
    if (!parsed) throw new Error('Invalid Janny account path');
    return parsed.toString();
}

export function buildFlareSolverrJannyRequest({ path, sessionId = '', cookie = null, userAgent = '' } = {}) {
    if (!isAllowedJannyAccountRequest('GET', path)) {
        throw new Error('FlareSolverr warmup only supports allowed GET paths');
    }

    const body = {
        cmd: 'request.get',
        url: buildJannyAccountUrl(path),
        maxTimeout: JANNY_ACCOUNT_TIMEOUT_MS,
    };

    if (sessionId && typeof sessionId === 'string' && sessionId.length <= 128) {
        body.session = sessionId;
    }

    if (cookie?.ok && Array.isArray(cookie.cookies) && cookie.cookies.length > 0) {
        body.cookies = cookie.cookies.map(c => ({ name: c.name, value: c.value }));
    }

    const ua = sanitizeJannyUserAgent(userAgent);
    if (ua) body.userAgent = ua;
    return body;
}

export function mergeCookieHeaders(...headers) {
    const merged = new Map();
    for (const header of headers) {
        const parsed = sanitizeJannyCookieHeader(header || '');
        if (!parsed.ok) continue;
        for (const cookie of parsed.cookies) merged.set(cookie.name, cookie.value);
    }
    if (!merged.size) return null;
    return [...merged.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function cookiesFromSetCookieHeader(setCookieHeader) {
    if (!setCookieHeader || typeof setCookieHeader !== 'string') return null;
    const parts = [];
    for (const chunk of setCookieHeader.split(/,(?=\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=)/)) {
        const first = chunk.split(';', 1)[0]?.trim();
        if (first) parts.push(first);
    }
    return parts.length ? parts.join('; ') : null;
}

export function summarizeJannyResponseForClient({ status, contentType, body }) {
    const type = contentType || 'application/octet-stream';
    if (type.includes('application/json')) {
        try { return { json: JSON.parse(body || 'null') }; } catch { /* fall through */ }
    }
    if (type.includes('text/html') && String(body || '').includes('Saved Characters')) {
        return { html: body, bookmarkPage: parseJannyBookmarkPage(body) };
    }
    return { text: body };
}
