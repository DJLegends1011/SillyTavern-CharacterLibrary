import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildFlareSolverrJannyRequest,
    detectJannyCloudflareChallenge,
    isAllowedJannyAccountRequest,
    parseJannyBookmarkPage,
    sanitizeJannyCookieHeader,
} from '../extras/cl-helper/janny-account.js';

test('sanitizeJannyCookieHeader accepts a full Cookie header without leaking shape', () => {
    const result = sanitizeJannyCookieHeader('Cookie: session=abc123 ; cf_clearance=clear.value ; __Host-next-auth.csrf-token=token%7Cmore ');

    assert.equal(result.ok, true);
    assert.equal(result.header, 'session=abc123; cf_clearance=clear.value; __Host-next-auth.csrf-token=token%7Cmore');
    assert.deepEqual(result.cookies, [
        { name: 'session', value: 'abc123' },
        { name: 'cf_clearance', value: 'clear.value' },
        { name: '__Host-next-auth.csrf-token', value: 'token%7Cmore' },
    ]);
});

test('sanitizeJannyCookieHeader rejects empty, control-character, and malformed cookies', () => {
    assert.equal(sanitizeJannyCookieHeader('').ok, false);
    assert.equal(sanitizeJannyCookieHeader('session=abc\r\nx-owned: yes').ok, false);
    assert.equal(sanitizeJannyCookieHeader('not-a-cookie').ok, false);
    assert.equal(sanitizeJannyCookieHeader('bad name=value').ok, false);
});

test('detectJannyCloudflareChallenge catches status, headers, and challenge body markers', () => {
    assert.equal(detectJannyCloudflareChallenge({
        status: 403,
        headers: { 'cf-mitigated': 'challenge' },
        body: '<html></html>',
    }), true);

    assert.equal(detectJannyCloudflareChallenge({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g"></script>',
    }), true);

    assert.equal(detectJannyCloudflareChallenge({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"bookmarks":[]}',
    }), false);
});

test('isAllowedJannyAccountRequest allows only account sync endpoints', () => {
    assert.equal(isAllowedJannyAccountRequest('GET', '/bookmark'), true);
    assert.equal(isAllowedJannyAccountRequest('GET', '/api/bookmark'), true);
    assert.equal(isAllowedJannyAccountRequest('POST', '/api/bookmark'), true);
    assert.equal(isAllowedJannyAccountRequest('DELETE', '/api/bookmark?ids=11111111-1111-4111-8111-111111111111'), true);
    assert.equal(isAllowedJannyAccountRequest('GET', '/api/get-characters?ids=11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222'), true);
    assert.equal(isAllowedJannyAccountRequest('GET', '/api/collections/mine'), true);
    assert.equal(isAllowedJannyAccountRequest('GET', '/api/collections/11111111-1111-4111-8111-111111111111/characters'), true);
    assert.equal(isAllowedJannyAccountRequest('POST', '/api/collections/11111111-1111-4111-8111-111111111111/characters'), true);
    assert.equal(isAllowedJannyAccountRequest('DELETE', '/api/collections/11111111-1111-4111-8111-111111111111/characters?characterId=22222222-2222-4222-8222-222222222222'), true);

    assert.equal(isAllowedJannyAccountRequest('GET', '/api/users/me'), false);
    assert.equal(isAllowedJannyAccountRequest('POST', '/api/collections/../../../characters'), false);
    assert.equal(isAllowedJannyAccountRequest('PUT', '/api/bookmark'), false);
    assert.equal(isAllowedJannyAccountRequest('GET', 'https://evil.example/api/bookmark'), false);
});

test('parseJannyBookmarkPage extracts count and unique character links', () => {
    const html = `
        <main>
            <h1>Saved Characters (220)</h1>
            <a href="/characters/11111111-1111-4111-8111-111111111111_character-alice">Alice</a>
            <a href="https://jannyai.com/characters/22222222-2222-4222-8222-222222222222_character-bob">Bob</a>
            <a href="/characters/11111111-1111-4111-8111-111111111111_character-alice">Duplicate</a>
        </main>
    `;

    const parsed = parseJannyBookmarkPage(html);
    assert.equal(parsed.totalCount, 220);
    assert.deepEqual(parsed.characterIds, [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
    ]);
    assert.deepEqual(parsed.characterUrls, [
        'https://jannyai.com/characters/11111111-1111-4111-8111-111111111111_character-alice',
        'https://jannyai.com/characters/22222222-2222-4222-8222-222222222222_character-bob',
    ]);
});

test('buildFlareSolverrJannyRequest pins target, cookies, user agent, and session', () => {
    const cookie = sanitizeJannyCookieHeader('session=abc; cf_clearance=clear');
    const body = buildFlareSolverrJannyRequest({
        path: '/api/collections/mine',
        sessionId: 'janny-session',
        cookie,
    });

    assert.equal(body.cmd, 'request.get');
    assert.equal(body.url, 'https://jannyai.com/api/collections/mine');
    assert.equal(body.session, 'janny-session');
    assert.equal(body.maxTimeout > 1000, true);
    assert.deepEqual(body.cookies, [
        { name: 'session', value: 'abc' },
        { name: 'cf_clearance', value: 'clear' },
    ]);
});
