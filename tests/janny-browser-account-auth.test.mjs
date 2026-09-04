import test from 'node:test';
import assert from 'node:assert/strict';
import { createJannyHelperHarness } from './helpers/janny-helper-harness.mjs';
import { readJannyBrowserSession } from '../extras/cl-helper/index.js';

const cookieName = 'sb-eenzcbluoctduymzksoq-auth-token';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = `${encode({ alg: 'none' })}.${encode({ exp: 2_000_000_000, email: 'reader@example.test' })}.synthetic`;
const refresh = 'synthetic-refresh-credential';
const sessionValue = accessToken => 'base64-' + Buffer.from(JSON.stringify({ access_token: accessToken, refresh_token: refresh })).toString('base64');
const collection = 'cccccccc-3333-4333-8333-333333333333';
const character = 'aaaaaaaa-1111-4111-8111-111111111111';

function accountReply(expectedToken, body = '{}') {
    return (url, init, cookies) => ({
        status: cookies.some(cookie => cookie.name === 'sb-access-token' && decodeURIComponent(cookie.value) === expectedToken)
            && cookies.some(cookie => cookie.name === 'sb-refresh-token' && cookie.value === refresh) ? 200 : 401,
        finalUrl: url,
        body,
    });
}

for (const request of [
    { path: '/api/bookmark', method: 'GET' },
    { path: '/api/collections/mine', method: 'GET' },
    { path: `/api/collections/${collection}/characters`, method: 'POST', jsonBody: { characterId: character } },
    { path: `/api/collections/${collection}/characters?characterId=${character}`, method: 'DELETE' },
]) {
    test(`an installed session authenticates ${request.method} ${request.path}`, async () => {
        const value = sessionValue(token);
        // This is the same redacted status Settings uses to display "Logged in".
        assert.equal(readJannyBrowserSession([{ name: cookieName, value }]).active, true);
        const harness = createJannyHelperHarness([accountReply(token)], {
            cookies: [{ name: cookieName, value: encodeURIComponent(value) }],
        });
        const response = await harness.apiRequest('/plugins/cl-helper/jannyai-browser-fetch', 'POST', {
            ...request, token: 'obsolete-caller-token',
        });
        const result = await response.json();
        assert.equal(result.status, 200, 'a logged-in browser must authenticate account API calls');
        assert.equal(harness.requests[0].init.credentials, 'include');
        assert.equal(harness.requests[0].init.headers.Authorization, undefined);
        assert.ok(!harness.cookies().some(cookie => cookie.name.startsWith(cookieName)));
        if (request.jsonBody) assert.deepEqual(JSON.parse(harness.requests[0].init.body), request.jsonBody);
        assert.ok(!JSON.stringify(result).includes(token));
        assert.ok(!JSON.stringify(result).includes(refresh));
    });
}

test('account requests use native credentials rotated by the site, without reviving copied chunks', async () => {
    const rotated = token.replace('.synthetic', '.rotated');
    const harness = createJannyHelperHarness([accountReply(rotated)], {
        cookies: [
            { name: cookieName, value: sessionValue(token) },
            { name: 'sb-access-token', value: rotated },
            { name: 'sb-refresh-token', value: refresh },
        ],
    });
    const response = await harness.apiRequest('/plugins/cl-helper/jannyai-browser-fetch', 'POST', { path: '/api/bookmark', method: 'GET' });
    assert.equal((await response.json()).status, 200);
    assert.ok(!harness.cookies().some(cookie => cookie.name.startsWith(cookieName)));
});

test('public requests do not read the account session', async () => {
    const harness = createJannyHelperHarness([{
        status: 200, finalUrl: 'https://jannyai.com/collections', body: '<html>Public collections</html>',
    }], { document: { get cookie() { throw new Error('Public request read account credentials'); } } });
    const response = await harness.apiRequest('/plugins/cl-helper/jannyai-browser-fetch', 'POST', { path: '/collections', method: 'GET' });
    assert.equal((await response.json()).status, 200);
    assert.equal(harness.requests[0].init.headers.Authorization, undefined);
});

for (const cookie of ['', `${cookieName}=base64-invalid`, `${cookieName}.0=base64-head; ${cookieName}.2=tail`]) {
    test('missing or malformed sessions preserve the unauthorized response: ' + cookie, async () => {
        const harness = createJannyHelperHarness([accountReply(token)], { cookies: cookie ? cookie.split('; ').map(part => { const eq = part.indexOf('='); return { name: part.slice(0, eq), value: part.slice(eq + 1) }; }) : [] });
        const response = await harness.apiRequest('/plugins/cl-helper/jannyai-browser-fetch', 'POST', { path: '/api/bookmark', method: 'GET' });
        assert.equal((await response.json()).status, 401);
        assert.equal(harness.requests[0].init.headers.Authorization, undefined);
    });
}
