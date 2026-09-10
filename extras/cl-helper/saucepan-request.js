// Narrow direct-server transport for Saucepan account and browse requests.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_PATHS = [
    /^\/api\/v1\/users\/followed$/,
    /^\/api\/v1\/user-page$/,
    /^\/api\/v1\/fandoms$/,
    /^\/api\/v2\/companions\/[a-f0-9-]{36}$/i,
    /^\/api\/v2\/users\/[A-Za-z0-9_.-]+\/companions$/,
    /^\/api\/v1\/companion\/definition$/,
];

export function validateSaucepanRequest(input = {}) {
    const { path, body } = input;
    const method = String(input.method || 'GET').toUpperCase();
    if (typeof path !== 'string' || path.length > 2048 || !path.startsWith('/api/') || path.includes('\\')) throw new Error('Invalid Saucepan path');
    const url = new URL(path, 'https://saucepan.ai');
    if (url.origin !== 'https://saucepan.ai' || url.pathname !== path.split('?')[0] || url.hash) throw new Error('Invalid Saucepan path');
    if (method === 'GET' && READ_PATHS.some(re => re.test(url.pathname))) return { method, path };
    if (method === 'POST' && path === '/api/v1/search') {
        if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 32768) throw new Error('Invalid Saucepan search body');
        return { method, path, body };
    }
    const key = path === '/api/v1/companions/favorite' ? 'companion_id' : path === '/api/v1/users/follow' ? 'user_id' : null;
    if (key && ['POST', 'DELETE'].includes(method) && typeof body?.[key] === 'string' && UUID.test(body[key])) {
        return { method, path, body: { [key]: body[key] } };
    }
    throw new Error('Saucepan method or path not allowed');
}

export async function fetchSaucepanRequest(request, token, { fetchImpl = fetch } = {}) {
    const headers = {
        Accept: 'application/json', Authorization: `Bearer ${token}`, 'x-saucepan-client-version': '1',
        'Accept-Encoding': 'gzip, deflate, br', Origin: 'https://saucepan.ai', Referer: 'https://saucepan.ai/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';
    const init = { method: request.method, redirect: 'error', headers, signal: AbortSignal.timeout(20000),
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) };
    return fetchImpl(`https://saucepan.ai${request.path}`, init);
}
