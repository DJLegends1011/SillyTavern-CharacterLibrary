export const JANNY_ORIGIN = 'https://jannyai.com';
export const JANNY_AUTH_COOKIE = 'sb-eenzcbluoctduymzksoq-auth-token';
export const JANNY_CF_COOKIE_NAMES = new Set(['cf_clearance', '__cf_bm']);
export const JANNY_COOKIE_CHUNK_LIMIT = 3180;
export const JANNY_SESSION_TOKEN_LIMIT = 16_384;
export const JANNY_SESSION_VALUE_LIMIT = 48 * 1024;

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID_SOURCE}$`, 'i');
const CHARACTER_RE = new RegExp(`^/characters/(${UUID_SOURCE})(?:_[^/?#]{1,256})?$`, 'i');
const COLLECTION_RE = new RegExp(`^/collections/(${UUID_SOURCE})(?:_[^/?#]{1,256})?$`, 'i');
const MEMBERS_RE = new RegExp(`^/api/collections/(${UUID_SOURCE})/characters$`, 'i');
const BODY_LIMIT = 16 * 1024;

function blocked(message) {
    const error = new Error(message);
    error.code = 'JANNY_REQUEST_BLOCKED';
    throw error;
}

function uuidCsv(value) {
    const ids = String(value || '').split(',').filter(Boolean);
    return ids.length > 0 && ids.length <= 100 && ids.every(id => UUID_RE.test(id));
}

function noQuery(url) { return url.searchParams.size === 0; }

function exactQuery(url, keys) {
    const actual = [...url.searchParams.keys()];
    return actual.length === keys.length && keys.every(key => url.searchParams.getAll(key).length === 1);
}

function plainRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactBodyKeys(value, keys) {
    return plainRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function encodedBody(contentType, value) {
    if (value.length > BODY_LIMIT) blocked('JannyAI request body is too large');
    return { contentType, body: value };
}

function validatedCollectionForm(path, formBody) {
    if (path === '/collections/form/delete-collection') {
        if (!exactBodyKeys(formBody, ['id']) || !UUID_RE.test(String(formBody.id))) blocked('Invalid collection delete form');
    } else {
        const keys = path.endsWith('/edit-collection') ? ['id', 'name', 'description', 'isPrivate'] : ['name', 'description', 'isPrivate'];
        if (!exactBodyKeys(formBody, keys)) blocked('Invalid collection form fields');
        if (keys.includes('id') && !UUID_RE.test(String(formBody.id))) blocked('Invalid collection id');
        const name = String(formBody.name); const description = String(formBody.description);
        if (name.length < 1 || name.length > 160) blocked('Invalid collection name');
        if (description.length > 4000) blocked('Invalid collection description');
        if (!['yes', 'no'].includes(formBody.isPrivate)) blocked('Invalid collection visibility');
    }
    return encodedBody('application/x-www-form-urlencoded', new URLSearchParams(formBody).toString());
}

export function buildJannySessionCookies(accessToken, refreshToken = '', nowSeconds = Math.floor(Date.now() / 1000)) {
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > JANNY_SESSION_TOKEN_LIMIT
        || typeof refreshToken !== 'string' || refreshToken.length > JANNY_SESSION_TOKEN_LIMIT) blocked('Invalid JannyAI session');
    let expiresAt = nowSeconds + 3600;
    try {
        const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
        if (Number.isInteger(claims.exp) && claims.exp > 0) expiresAt = claims.exp;
    } catch { /* use the bounded fallback expiry */ }
    const session = { access_token: accessToken, token_type: 'bearer', expires_in: Math.max(60, expiresAt - nowSeconds), expires_at: expiresAt, refresh_token: refreshToken, user: {} };
    const value = `base64-${Buffer.from(JSON.stringify(session), 'utf8').toString('base64')}`;
    if (value.length > JANNY_SESSION_VALUE_LIMIT) blocked('Invalid JannyAI session');
    const values = value.length <= JANNY_COOKIE_CHUNK_LIMIT ? [value] : Array.from({ length: Math.ceil(value.length / JANNY_COOKIE_CHUNK_LIMIT) }, (_, index) => value.slice(index * JANNY_COOKIE_CHUNK_LIMIT, (index + 1) * JANNY_COOKIE_CHUNK_LIMIT));
    const cookieExpiresAt = refreshToken ? nowSeconds + (400 * 24 * 60 * 60) : expiresAt;
    return values.map((chunk, index) => ({ name: values.length === 1 ? JANNY_AUTH_COOKIE : `${JANNY_AUTH_COOKIE}.${index}`, value: chunk, expires: cookieExpiresAt }));
}

export function jannyAccountCookiesToDelete(cookies) {
    return [...new Set((cookies || []).map(cookie => String(cookie?.name || '')).filter(name => name === JANNY_AUTH_COOKIE || name.startsWith(`${JANNY_AUTH_COOKIE}.`)).filter(name => !JANNY_CF_COOKIE_NAMES.has(name)))];
}

export function validateJannyFinalUrl(finalUrl, formPost = false, status = 200) {
    let parsed;
    try { parsed = new URL(String(finalUrl || ''), JANNY_ORIGIN); } catch { blocked('Malformed JannyAI final URL'); }
    if (parsed.origin !== JANNY_ORIGIN) blocked('Cross-origin JannyAI redirect rejected');
    let decodedPath;
    try { decodedPath = decodeURIComponent(parsed.pathname); } catch { blocked('Malformed JannyAI final pathname'); }
    // Failed forms may remain on their action URL. Preserve their HTTP status for
    // client recovery/classification, but never relax the origin check above.
    if (formPost && status >= 200 && status < 300) {
        const login = /^\/(?:auth\/)?(?:login|log-in|signin|sign-in)\/?$/i.test(decodedPath);
        const collection = decodedPath === '/collections' || COLLECTION_RE.test(decodedPath.replace(/\/edit$/, ''));
        if (!login && !collection) blocked('Unexpected JannyAI collection redirect');
    }
    return parsed.href;
}

export function validateJannyBrowserRequest(input = {}) {
    const method = String(input.method || 'GET').toUpperCase(); const raw = String(input.path || '');
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.length > 2048 || /[\0\r\n\\#]/.test(raw)) blocked('Origin-relative JannyAI path required');
    let decodedRawPath; try { decodedRawPath = decodeURIComponent(raw.split('?')[0]); } catch { blocked('Malformed JannyAI path encoding'); }
    if (decodedRawPath.split('/').some(segment => segment === '.' || segment === '..')) blocked('Path traversal rejected');
    let url; try { url = new URL(raw, JANNY_ORIGIN); } catch { blocked('Malformed JannyAI path'); }
    if (url.origin !== JANNY_ORIGIN) blocked('JannyAI origin required');
    let decodedPath; try { decodedPath = decodeURIComponent(url.pathname); } catch { blocked('Malformed JannyAI pathname'); }
    const hasJsonBody = input.jsonBody !== undefined; const hasFormBody = input.formBody !== undefined;
    if (hasJsonBody && hasFormBody) blocked('Only one JannyAI body type is allowed');
    const inspectCharacterId = String(input.inspectCharacterId || '');
    const finish = (payload = null) => { if (!payload && (hasJsonBody || hasFormBody)) blocked('This JannyAI route does not accept a body'); return { method, safePath: url.pathname + url.search, contentType: payload?.contentType || '', body: payload?.body || '', inspectCharacterId }; };
    const character = decodedPath.match(CHARACTER_RE);
    if (character && method === 'GET' && noQuery(url)) { if (inspectCharacterId && (!UUID_RE.test(inspectCharacterId) || inspectCharacterId.toLowerCase() !== character[1].toLowerCase())) blocked('Character inspection id must match the path'); return finish(); }
    if (inspectCharacterId) blocked('Hydrated inspection is limited to character pages');
    if (decodedPath === '/collections' && method === 'GET') { const keys = [...url.searchParams.keys()]; if (keys.some(key => !['sort', 'page', 'q'].includes(key)) || keys.some(key => url.searchParams.getAll(key).length !== 1)) blocked('Invalid public collection query'); if (url.searchParams.has('sort') && !['latest', 'popular'].includes(url.searchParams.get('sort'))) blocked('Invalid collection sort'); if (url.searchParams.has('page') && !/^[1-9][0-9]{0,3}$/.test(url.searchParams.get('page'))) blocked('Invalid collection page'); if (url.searchParams.has('q') && url.searchParams.get('q').length > 256) blocked('Invalid collection search'); return finish(); }
    if (method === 'GET' && noQuery(url) && /^\/collectors\/[^/]{1,384}$/u.test(decodedPath)) { const name = decodedPath.slice('/collectors/'.length); if (name.length > 128 || /[\0-\x1f\\]/.test(name)) blocked('Invalid collector name'); return finish(); }
    if (COLLECTION_RE.test(decodedPath) && method === 'GET' && noQuery(url)) return finish();
    if (decodedPath === '/api/bookmark' && method === 'GET' && noQuery(url)) return finish();
    if (decodedPath === '/api/bookmark' && method === 'POST' && noQuery(url)) { const value = input.jsonBody; if (!exactBodyKeys(value, ['characterIDs']) || !Array.isArray(value.characterIDs) || value.characterIDs.length < 1 || value.characterIDs.length > 100 || !value.characterIDs.every(id => UUID_RE.test(String(id)))) blocked('Invalid bookmark body'); return finish(encodedBody('application/json', JSON.stringify(value))); }
    if (decodedPath === '/api/bookmark' && method === 'DELETE' && exactQuery(url, ['ids']) && uuidCsv(url.searchParams.get('ids'))) return finish();
    if (decodedPath === '/api/get-characters' && method === 'GET' && exactQuery(url, ['ids']) && uuidCsv(url.searchParams.get('ids'))) return finish();
    if (decodedPath === '/api/collections/mine' && method === 'GET' && noQuery(url)) return finish();
    const members = decodedPath.match(MEMBERS_RE);
    if (members && method === 'GET' && noQuery(url)) return finish();
    if (members && method === 'POST' && noQuery(url)) { const value = input.jsonBody; if (!exactBodyKeys(value, ['characterId']) || !UUID_RE.test(String(value.characterId))) blocked('Invalid collection member body'); return finish(encodedBody('application/json', JSON.stringify(value))); }
    if (members && method === 'DELETE' && exactQuery(url, ['characterId']) && UUID_RE.test(url.searchParams.get('characterId'))) return finish();
    if (method === 'POST' && noQuery(url) && ['/collections/form/add-collection', '/collections/form/edit-collection', '/collections/form/delete-collection'].includes(decodedPath)) return finish(validatedCollectionForm(decodedPath, input.formBody));
    blocked('JannyAI request is not allowlisted');
}
