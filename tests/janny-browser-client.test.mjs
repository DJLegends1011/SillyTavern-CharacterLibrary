import test from 'node:test';
import assert from 'node:assert/strict';

const settings = { janitoraiBrowserMode: 'managed', janitoraiBrowserEndpoint: 'http://browser:9222' };
const calls = [];
let responseData = { ok: true, status: 200, body: '{}', finalUrl: 'https://jannyai.com/api/bookmark' };
let responseOk = true;
let responseStatus = 200;
let requestError = null;
let responseJson = async () => responseData;
globalThis.window = {
    getSetting: key => settings[key],
    apiRequest: async (path, method, body, options) => {
        calls.push({ path, method, body, options });
        if (requestError) throw requestError;
        return { ok: responseOk, status: responseStatus, json: responseJson };
    },
};
await import('../modules/core-api.js');
const browser = await import('../modules/providers/janny/janny-browser.js');

test('reuses Janitor browser configuration', () => {
    assert.equal(browser.getJannyBrowserMode(), 'managed');
    assert.equal(browser.getJannyBrowserEndpoint(), 'http://browser:9222');
    assert.deepEqual(browser.jannyBrowserTarget(), { managed: true });
    settings.janitoraiBrowserMode = 'endpoint';
    assert.deepEqual(browser.jannyBrowserTarget(), { endpoint: 'http://browser:9222' });
});

test('shapes an authenticated helper fetch without putting the token in the URL', async () => {
    settings.janitoraiBrowserMode = 'managed';
    await browser.jannyBrowserFetch('/api/bookmark', { token: 'secret-token' });
    const call = calls.at(-1);
    assert.equal(call.path, '/plugins/cl-helper/jannyai-browser-fetch');
    assert.equal(call.method, 'POST');
    assert.equal(call.body.path, '/api/bookmark');
    assert.equal(call.body.token, 'secret-token');
    assert.doesNotMatch(call.path, /secret-token/);
});

test('forwards browser fetch options and preserves the helper fetch envelope', async () => {
    responseData = {
        ok: true,
        status: 201,
        body: '{"created":true}',
        finalUrl: 'https://jannyai.com/collections/new',
        hydratedCharacter: { id: 'char-1' },
    };

    const result = await browser.jannyBrowserFetch('/collections/form/add-collection', {
        method: 'post',
        jsonBody: { ignored: true },
        formBody: { name: 'New collection' },
        inspectCharacterId: 'char-1',
    });
    const call = calls.at(-1);

    assert.equal(call.body.method, 'POST');
    assert.deepEqual(call.body.jsonBody, { ignored: true });
    assert.deepEqual(call.body.formBody, { name: 'New collection' });
    assert.equal(call.body.inspectCharacterId, 'char-1');
    assert.equal('token' in call.body, false);
    assert.deepEqual(result, {
        status: 201,
        body: '{"created":true}',
        finalUrl: 'https://jannyai.com/collections/new',
        hydratedCharacter: { id: 'char-1' },
    });
});

test('routes browser test, session, and logout calls through the local helper', async () => {
    responseData = { ok: true, checks: [{ key: 'connect', ok: true }] };
    assert.deepEqual(await browser.testJannyBrowserEndpoint('http://override:9222'), responseData);
    assert.deepEqual(calls.at(-1).body, { endpoint: 'http://override:9222' });
    assert.equal(calls.at(-1).path, '/plugins/cl-helper/jannyai-browser-test');

    responseData = { ok: true };
    await browser.jannyBrowserSetSession('a'.repeat(16_385), 'refresh-token');
    const session = calls.at(-1);
    assert.equal(session.path, '/plugins/cl-helper/jannyai-browser-session');
    assert.equal(session.body.token.length, 16_384);
    assert.equal(session.body.refreshToken, 'refresh-token');

    await browser.jannyBrowserLogout('http://logout:9222');
    assert.equal(calls.at(-1).path, '/plugins/cl-helper/jannyai-browser-logout');
    assert.deepEqual(calls.at(-1).body, { endpoint: 'http://logout:9222' });
});

test('classifies helper and browser fetch failures without exposing credential data', async () => {
    const expiredToken = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.signature`;
    const cases = [
        {
            name: 'missing helper',
            response: { ok: false, status: 404, data: { ok: false, error: 'Plugin route not found' } },
            options: {}, code: 'JANNY_HELPER_UNAVAILABLE',
        },
        {
            name: 'browser connection failure',
            response: { ok: false, status: 502, data: { ok: false, error: 'secret-token JannyAI browser transport failed' } },
            options: {}, code: 'JANNY_BROWSER_UNAVAILABLE',
        },
        {
            name: 'local timeout',
            error: new DOMException('Timed out', 'TimeoutError'),
            options: {}, code: 'JANNY_BROWSER_TIMEOUT',
        },
        {
            name: 'cloudflare challenge',
            response: { ok: false, status: 502, data: { ok: false, error: 'Cloudflare clearance failed' } },
            options: {}, code: 'JANNY_CF_BLOCKED',
        },
        {
            name: 'expired JWT before dispatch',
            options: { token: expiredToken }, code: 'JANNY_TOKEN_EXPIRED',
        },
        {
            name: 'account endpoint rejection',
            response: { ok: true, status: 200, data: { ok: true, status: 401, body: '{}' } },
            path: '/user', options: {}, code: 'JANNY_TOKEN_REJECTED',
        },
        {
            name: 'ordinary unauthorized response',
            response: { ok: true, status: 200, data: { ok: true, status: 401, body: '{}' } },
            options: {}, code: 'JANNY_LOGIN_REQUIRED',
        },
        {
            name: 'rate limited response',
            response: { ok: true, status: 200, data: { ok: true, status: 429, body: '{}' } },
            options: {}, code: 'JANNY_RATE_LIMITED',
        },
        {
            name: 'helper policy refusal',
            response: { ok: false, status: 403, data: { ok: false, error: 'JANNY_REQUEST_BLOCKED' } },
            options: {}, code: 'JANNY_REQUEST_BLOCKED',
        },
        {
            name: 'other HTTP failure',
            response: { ok: true, status: 200, data: { ok: true, status: 500, body: '{}' } },
            options: {}, code: 'JANNY_HTTP_ERROR',
        },
        {
            name: 'redirect response',
            response: { ok: true, status: 200, data: { ok: true, status: 302, body: '' } },
            options: {}, code: 'JANNY_HTTP_ERROR',
        },
    ];

    for (const entry of cases) {
        requestError = entry.error || null;
        responseOk = entry.response?.ok ?? true;
        responseStatus = entry.response?.status ?? 200;
        responseData = entry.response?.data ?? { ok: true, status: 200, body: '{}' };
        await assert.rejects(
            browser.jannyBrowserFetch(entry.path || '/api/bookmark', entry.options),
            error => {
                assert.equal(error.code, entry.code, entry.name);
                assert.doesNotMatch(error.message, /secret-token|Cloudflare clearance failed|Plugin route not found/);
                return true;
            },
        );
    }
    requestError = null;
    responseOk = true;
    responseStatus = 200;
});

test('reports a valid character page that cannot be hydrated as a page-shape change', async () => {
    responseData = {
        ok: true,
        status: 200,
        body: '<html><title>Character</title></html>',
        finalUrl: 'https://jannyai.com/characters/char-1_character',
        hydratedCharacter: null,
    };
    await assert.rejects(
        browser.jannyBrowserFetch('/characters/char-1_character', { inspectCharacterId: 'char-1' }),
        error => error.code === 'JANNY_PAGE_SHAPE_CHANGED',
    );
});

test('rejects successful HTTP challenge pages as Cloudflare blocks', async () => {
    responseData = {
        ok: true,
        status: 200,
        body: '<!doctype html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>',
        finalUrl: 'https://jannyai.com/api/bookmark',
    };
    await assert.rejects(
        browser.jannyBrowserFetch('/api/bookmark'),
        error => error.code === 'JANNY_CF_BLOCKED',
    );
});

test('classifies rejected local helper calls as helper unavailability', async () => {
    for (const failure of [
        new TypeError('network request failed'),
        new DOMException('request interrupted before helper response', 'AbortError'),
    ]) {
        requestError = failure;
        try {
            await assert.rejects(
                browser.jannyBrowserFetch('/api/bookmark'),
                error => error.code === 'JANNY_HELPER_UNAVAILABLE',
            );
        } finally {
            requestError = null;
        }
    }
});

test('rethrows caller cancellation that occurs while parsing helper JSON', async () => {
    responseData = { ok: true, status: 200, body: '{}', finalUrl: 'https://jannyai.com/api/bookmark' };
    const controller = new AbortController();
    const reason = new Error('cancel while decoding response');
    responseJson = async () => {
        controller.abort(reason);
        throw new DOMException('The operation was aborted.', 'AbortError');
    };
    try {
        await assert.rejects(
            browser.jannyBrowserFetch('/api/bookmark', { signal: controller.signal }),
            error => error === reason,
        );
    } finally {
        responseJson = async () => responseData;
    }
});

test('returns failed browser probe checks from a reachable helper', async () => {
    responseData = {
        ok: false,
        checks: [{ key: 'cloudflare', label: 'Cloudflare cleared', ok: false, detail: 'Still challenged.' }],
        error: 'Cloudflare check failed',
    };
    assert.deepEqual(await browser.testJannyBrowserEndpoint(), responseData);
});

test('keeps abort signals out of helper bodies and rethrows the caller abort reason', async () => {
    responseData = { ok: true, status: 200, body: '{}', finalUrl: 'https://jannyai.com/api/bookmark' };
    const active = new AbortController();
    await browser.jannyBrowserFetch('/api/bookmark', { signal: active.signal, timeoutMs: 12_345 });
    const activeCall = calls.at(-1);
    assert.equal('signal' in activeCall.body, false);
    assert.equal('timeoutMs' in activeCall.body, false);
    assert.ok(activeCall.options.signal instanceof AbortSignal);

    const reason = new Error('reader cancelled');
    const cancelled = new AbortController();
    cancelled.abort(reason);
    const callsBefore = calls.length;
    await assert.rejects(browser.jannyBrowserFetch('/api/bookmark', { signal: cancelled.signal }), error => error === reason);
    assert.equal(calls.length, callsBefore);
});

test('exposes only the browser client handles needed by the settings script', () => {
    browser.initJannyBrowserClient();
    assert.equal(window.jannyTestBrowserEndpoint, browser.testJannyBrowserEndpoint);
    assert.equal(window.jannyBrowserSetSession, browser.jannyBrowserSetSession);
    assert.equal(window.jannyBrowserLogout, browser.jannyBrowserLogout);
});
