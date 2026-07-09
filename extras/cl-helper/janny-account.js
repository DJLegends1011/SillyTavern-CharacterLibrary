export const JANNY_BASE = 'https://jannyai.com';
export const JANNY_ACCOUNT_TIMEOUT_MS = 90_000;
export const JANNY_DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const COOKIE_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHARACTER_PATH_RE = /^\/characters\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:_[^/?#]+)?$/i;
const COLLECTION_PATH_RE = /^\/collections\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:_[^/?#]+)?$/i;
const CHARACTER_LINK_RE = /href=["'](https:\/\/jannyai\.com)?(\/characters\/[0-9a-f-]+(?:_[^"'?#\s<>]+)?)/ig;
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

    // Markers that only ever appear on an actual challenge page.
    if (lower.includes('<title>just a moment') || lower.includes('cf-chl-') || lower.includes('window._cf_chl_opt')) {
        return true;
    }

    // Cloudflare injects its JS-detection script (/cdn-cgi/challenge-platform/...)
    // into legitimate 2xx pages, so challenge asset paths and looser phrases only
    // count as a challenge on error statuses.
    if (status >= 400) {
        return lower.includes('just a moment')
            || lower.includes('cf_chl_')
            || lower.includes('/cdn-cgi/challenge-platform/')
            || lower.includes('challenge-platform');
    }
    return false;
}

// cf_clearance is bound to the IP that solved the challenge — typically the
// browser's IPv6 on dual-stack networks — while SillyTavern forces
// dns.setDefaultResultOrder('ipv4first') process-wide. Callers probe both
// address families in this order and remember the one Cloudflare accepts.
export function jannyFamilyOrder(preferred = null) {
    if (preferred === 4) return [4, 6];
    if (preferred === 6) return [6, 4];
    return [6, 4];
}

export function parseJannyBookmarkPage(html) {
    const text = String(html || '');
    const totalMatch = text.match(/Saved\s+Characters\s*\(\s*([0-9,]+)\s*\)/i);
    const totalCount = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ''), 10) : null;
    const seen = new Set();
    const characterIds = [];
    const characterUrls = [];
    const linkRe = CHARACTER_LINK_RE;
    linkRe.lastIndex = 0;

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
function decodeJannyHtml(text) {
    return String(text || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x2F;/g, '/');
}

function stripJannyTags(text) {
    return decodeJannyHtml(String(text || '').replace(/<[^>]*>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

function parseJannyCompactNumber(value) {
    const raw = String(value || '').replace(/,/g, '').trim();
    const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)(k|m)?$/i);
    if (!match) return null;
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return null;
    const suffix = (match[2] || '').toLowerCase();
    if (suffix === 'm') return Math.round(base * 1_000_000);
    if (suffix === 'k') return Math.round(base * 1_000);
    return Math.round(base);
}

function jannyAttr(attrs, name) {
    const match = String(attrs || '').match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
    return match ? decodeJannyHtml(match[2]).trim() : '';
}

function normalizeJannyCollectionPath(href) {
    const value = decodeJannyHtml(href || '').trim();
    let path = value;
    if (/^https?:\/\//i.test(value)) {
        let parsed;
        try { parsed = new URL(value); } catch { return null; }
        if (parsed.origin !== JANNY_BASE) return null;
        if (parsed.search || parsed.hash) return null;
        path = parsed.pathname;
    }
    const match = path.match(COLLECTION_PATH_RE);
    return match ? { id: match[1], path } : null;
}

function firstJannyTagText(block, tagName) {
    const match = String(block || '').match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
    return match ? stripJannyTags(match[1]) : '';
}

function extractJannyCollectionName(block, attrs = '') {
    const heading = String(block || '').match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i);
    return (heading ? stripJannyTags(heading[1]) : '')
        || jannyAttr(attrs, 'aria-label')
        || jannyAttr(attrs, 'title');
}

function extractJannyUpdatedAt(block) {
    const match = String(block || '').match(/\bdatetime\s*=\s*(["'])([\s\S]*?)\1/i);
    if (!match) return null;
    return decodeJannyHtml(match[2]).trim().split('T')[0] || null;
}

function extractJannyImages(block) {
    const images = [];
    const seen = new Set();
    const re = /<img\b[^>]*\bsrc\s*=\s*(["'])([\s\S]*?)\1/ig;
    let match;
    while ((match = re.exec(String(block || ''))) && images.length < 4) {
        const src = decodeJannyHtml(match[2]).trim();
        if (!src || seen.has(src)) continue;
        seen.add(src);
        images.push(src);
    }
    return images;
}

function extractJannyOwnerName(text) {
    const match = String(text || '').match(/\bby\s+(.+?)(?=\s+(?:[0-9,.]+[km]?\s+views|[0-9,]+\s*(?:characters|cards)|[A-Z][a-z]{2}\s+\d{1,2}|\d{4}-\d{2}-\d{2})|$)/i);
    return match ? match[1].trim() : '';
}

function extractJannyCollectionMetadata(block, attrs = '') {
    const cleanText = stripJannyTags(block);
    const countMatch = cleanText.match(/([0-9,]+)\s*(?:characters|cards)/i);
    const viewsMatch = cleanText.match(/([0-9,.]+[km]?)\s*views/i);
    return {
        name: extractJannyCollectionName(block, attrs),
        description: firstJannyTagText(block, 'p'),
        characterCount: countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null,
        ownerName: extractJannyOwnerName(cleanText),
        viewCount: viewsMatch ? parseJannyCompactNumber(viewsMatch[1]) : null,
        updatedAt: extractJannyUpdatedAt(block),
        images: extractJannyImages(block),
    };
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
export function validateJannyPublicCollectionPath(path) {
    const parsed = parseAccountPath(path);
    if (!parsed) return { ok: false, error: 'collection path is required' };
    if (parsed.searchParams.size !== 0) return { ok: false, error: 'collection path cannot include query parameters' };
    if (!COLLECTION_PATH_RE.test(parsed.pathname)) return { ok: false, error: 'collection path is not public-readable' };
    return { ok: true, path: parsed.pathname };
}

export function validateJannyPublicCharacterIds(ids) {
    const value = String(ids || '').trim();
    if (!csvIdsAreSafe(value)) return { ok: false, error: 'character ids are invalid' };
    return { ok: true, ids: value.split(',').map(id => id.trim()) };
}

export function parseJannyPublicCollectionsPage(html) {
    const text = String(html || '');
    const collections = [];
    const seen = new Set();
    const anchorRe = /<a\b([^>]*\bhref\s*=\s*(["'])([\s\S]*?)\2[^>]*)>([\s\S]*?)<\/a>/ig;
    let match;
    while ((match = anchorRe.exec(text))) {
        const normalized = normalizeJannyCollectionPath(match[3]);
        if (!normalized || seen.has(normalized.id)) continue;
        seen.add(normalized.id);
        const block = match[4];
        const meta = extractJannyCollectionMetadata(block, match[1]);
        collections.push({
            id: normalized.id,
            name: meta.name,
            path: normalized.path,
            url: `${JANNY_BASE}${normalized.path}`,
            description: meta.description,
            characterCount: meta.characterCount,
            ownerName: meta.ownerName,
            viewCount: meta.viewCount,
            updatedAt: meta.updatedAt,
            images: meta.images,
        });
    }

    const hasMore = /<a\b[^>]*\brel\s*=\s*(["'])[^"']*\bnext\b[^"']*\1[^>]*>/i.test(text)
        || /<a\b[^>]*>[\s\S]*?\bNext\b[\s\S]*?<\/a>/i.test(text);
    return { collections, hasMore };
}

export function parseJannyPublicCollectionDetailPage(html, path = '') {
    const text = String(html || '');
    const validation = path ? validateJannyPublicCollectionPath(path) : { ok: false };
    const pathMatch = validation.ok ? validation.path.match(COLLECTION_PATH_RE) : null;
    const meta = extractJannyCollectionMetadata(text);
    const collection = {
        id: pathMatch ? pathMatch[1] : '',
        name: meta.name,
        path: validation.ok ? validation.path : '',
        url: validation.ok ? `${JANNY_BASE}${validation.path}` : '',
        description: meta.description,
        characterCount: meta.characterCount,
        ownerName: meta.ownerName,
        viewCount: meta.viewCount,
        updatedAt: meta.updatedAt,
        images: meta.images,
    };

    const seen = new Set();
    const characterIds = [];
    const characterUrls = [];
    CHARACTER_LINK_RE.lastIndex = 0;
    let match;
    while ((match = CHARACTER_LINK_RE.exec(text))) {
        const charPath = decodeJannyHtml(match[2]);
        const idMatch = charPath.match(CHARACTER_PATH_RE);
        if (!idMatch) continue;
        const id = idMatch[1];
        if (seen.has(id)) continue;
        seen.add(id);
        characterIds.push(id);
        characterUrls.push(`${JANNY_BASE}${charPath}`);
    }

    return { collection, characterIds, characterUrls };
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

    // Collection create/edit/delete are server-rendered Astro form POSTs
    // (application/x-www-form-urlencoded, 302 redirect on success), not JSON APIs.
    if (verb === 'POST' && JANNY_COLLECTION_FORM_PATHS.includes(pathname)) {
        return params.size === 0;
    }

    return false;
}

export const JANNY_COLLECTION_FORM_PATHS = [
    '/collections/form/add-collection',
    '/collections/form/edit-collection',
    '/collections/form/delete-collection',
];

export function isJannyCollectionFormPath(path) {
    const parsed = parseAccountPath(path);
    return !!parsed && JANNY_COLLECTION_FORM_PATHS.includes(parsed.pathname);
}

export function buildJannyAccountUrl(path) {
    const parsed = parseAccountPath(path);
    if (!parsed) throw new Error('Invalid Janny account path');
    return parsed.toString();
}

export function buildJannyPublicRequestHeaders({ cookieHeader = '', userAgent = '' } = {}) {
    const headers = {
        'User-Agent': sanitizeJannyUserAgent(userAgent || JANNY_DEFAULT_UA),
        'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': `${JANNY_BASE}/`,
    };
    const parsed = sanitizeJannyCookieHeader(cookieHeader || '');
    if (parsed.ok) headers.Cookie = parsed.header;
    return headers;
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

export function summarizeJannyResponseForClient({ status, contentType, body, cloudflare = false } = {}) {
    if (cloudflare || detectJannyCloudflareChallenge({ status, body })) {
        return { error: 'Cloudflare challenge', cloudflare: true };
    }

    const type = contentType || 'application/octet-stream';
    if (type.includes('application/json')) {
        try { return { json: JSON.parse(body || 'null') }; } catch { /* fall through */ }
    }
    if (type.includes('text/html') && String(body || '').includes('Saved Characters')) {
        return { html: body, bookmarkPage: parseJannyBookmarkPage(body) };
    }
    return { text: body };
}
