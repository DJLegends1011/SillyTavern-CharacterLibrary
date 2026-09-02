import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildJannySessionCookies,
    jannyAccountCookiesToDelete,
    validateJannyFinalUrl,
    validateJannyBrowserRequest,
} from '../extras/cl-helper/janny-browser-policy.js';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';

test('allows the exact public and account request surface', () => {
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: `/characters/${A}_demo` }).safePath, `/characters/${A}_demo`);
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: '/collections?page=2&sort=latest' }).safePath, '/collections?page=2&sort=latest');
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: '/collections?q=robots&page=1&sort=popular' }).method, 'GET');
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: `/collectors/demo-user` }).safePath, '/collectors/demo-user');
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: `/collections/${A}_set` }).safePath, `/collections/${A}_set`);
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: '/api/bookmark' }).method, 'GET');
    assert.equal(validateJannyBrowserRequest({ method: 'POST', path: '/api/bookmark', jsonBody: { characterIDs: [A, B] } }).contentType, 'application/json');
    assert.equal(validateJannyBrowserRequest({ method: 'DELETE', path: `/api/bookmark?ids=${A},${B}` }).method, 'DELETE');
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: `/api/get-characters?ids=${A},${B}` }).method, 'GET');
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: '/api/collections/mine' }).method, 'GET');
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: `/api/collections/${A}/characters` }).method, 'GET');
    assert.equal(validateJannyBrowserRequest({ method: 'POST', path: `/api/collections/${A}/characters`, jsonBody: { characterId: B } }).method, 'POST');
    assert.equal(validateJannyBrowserRequest({ method: 'DELETE', path: `/api/collections/${A}/characters?characterId=${B}` }).method, 'DELETE');
    assert.equal(validateJannyBrowserRequest({ method: 'POST', path: '/collections/form/add-collection', formBody: { name: 'Set', description: '', isPrivate: 'yes' } }).contentType, 'application/x-www-form-urlencoded');
    assert.equal(validateJannyBrowserRequest({ method: 'POST', path: '/collections/form/edit-collection', formBody: { id: A, name: 'Set', description: 'Updated', isPrivate: 'no' } }).method, 'POST');
    assert.equal(validateJannyBrowserRequest({ method: 'POST', path: '/collections/form/delete-collection', formBody: { id: A } }).method, 'POST');
});

test('rejects origin escape, traversal, extra query keys, invalid UUIDs and body shapes', () => {
    const blocked = [
        { method: 'GET', path: 'https://evil.example/api/bookmark' },
        { method: 'GET', path: 'https://jannyai.com:444/api/bookmark' },
        { method: 'GET', path: '/api/bookmark/../admin' },
        { method: 'GET', path: '/api/bookmark/%2e%2e/admin' },
        { method: 'GET', path: '/collections?page=1&token=secret' },
        { method: 'DELETE', path: '/api/bookmark?ids=not-a-uuid' },
        { method: 'POST', path: '/api/bookmark', jsonBody: { characterIDs: ['not-a-uuid'] } },
        { method: 'PATCH', path: '/api/bookmark' },
        { method: 'POST', path: '/collections/form/add-collection', formBody: { name: 'x'.repeat(5000) } },
    ];
    for (const input of blocked) {
        assert.throws(() => validateJannyBrowserRequest(input), error => error.code === 'JANNY_REQUEST_BLOCKED');
    }
});

test('allows hydrated inspection only when the id matches the character path', () => {
    assert.equal(validateJannyBrowserRequest({ method: 'GET', path: `/characters/${A}_demo`, inspectCharacterId: A }).inspectCharacterId, A);
    assert.throws(
        () => validateJannyBrowserRequest({ method: 'GET', path: `/characters/${A}_demo`, inspectCharacterId: B }),
        error => error.code === 'JANNY_REQUEST_BLOCKED',
    );
});

test('rejects cross-origin redirects and constrains form success locations', () => {
    assert.equal(validateJannyFinalUrl('https://jannyai.com/characters', false), 'https://jannyai.com/characters');
    assert.equal(validateJannyFinalUrl(`https://jannyai.com/collections/${A}_set`, true), `https://jannyai.com/collections/${A}_set`);
    assert.throws(() => validateJannyFinalUrl('https://evil.example/collections', false), error => error.code === 'JANNY_REQUEST_BLOCKED');
    assert.throws(() => validateJannyFinalUrl('https://jannyai.com/admin', true), error => error.code === 'JANNY_REQUEST_BLOCKED');
});

test('complete sessions retain refresh cookies for 400 days without extending access expiry', () => {
    const nowSeconds = 1_900_000_000;
    const accessExp = 2_000_000_000;
    const prefix = `x.${Buffer.from(JSON.stringify({ exp: accessExp })).toString('base64url')}.`;
    const accessToken = prefix + 's'.repeat(16_384 - prefix.length);
    const cookies = buildJannySessionCookies(accessToken, 'r'.repeat(16_384), nowSeconds);
    assert.ok(cookies.length > 8, 'maximum accepted sessions must cover the old fixed cleanup ceiling');
    assert.ok(cookies.every(cookie => cookie.expires === nowSeconds + (400 * 24 * 60 * 60)));

    const serialized = cookies.map(cookie => cookie.value).join('').slice('base64-'.length);
    assert.ok(serialized.length > 40_000, 'maximum accepted sessions must cover the old reader ceiling');
    assert.equal(JSON.parse(Buffer.from(serialized, 'base64').toString('utf8')).expires_at, accessExp);

    const bare = buildJannySessionCookies(accessToken, '', nowSeconds);
    assert.ok(bare.every(cookie => cookie.expires === accessExp));
    assert.throws(() => buildJannySessionCookies(`${accessToken}x`, '', nowSeconds), error => error?.code === 'JANNY_REQUEST_BLOCKED');
});

test('selects only account cookies for logout', () => {
    assert.deepEqual(jannyAccountCookiesToDelete([
        { name: 'cf_clearance' },
        { name: '__cf_bm' },
        { name: 'sb-eenzcbluoctduymzksoq-auth-token.0' },
        { name: 'unrelated' },
    ]), ['sb-eenzcbluoctduymzksoq-auth-token.0']);
});
