import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJannySession, decodeJannyClaims } from '../modules/providers/janny/janny-auth.js';

function b64url(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

const claims = {
    sub: 'user-1',
    email: 'mobile@example.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iss: 'https://eenzcbluoctduymzksoq.supabase.co/auth/v1',
};
const jwt = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.signature`;
const session = { access_token: jwt, refresh_token: 'refresh-1' };
const encoded = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;

test('parseJannySession accepts a bare access JWT', () => {
    assert.deepEqual(parseJannySession(jwt), { access_token: jwt, refresh_token: '' });
});

test('parseJannySession accepts the full split Supabase cookie header', () => {
    const middle = Math.ceil(encoded.length / 2);
    const cookie = `sb-eenzcbluoctduymzksoq-auth-token.0=${encoded.slice(0, middle)}; sb-eenzcbluoctduymzksoq-auth-token.1=${encoded.slice(middle)}`;
    assert.deepEqual(parseJannySession(cookie), session);
});

test('parseJannySession accepts raw session JSON and the old sb-access-token cookie', () => {
    assert.deepEqual(parseJannySession(JSON.stringify(session)), session);
    assert.deepEqual(parseJannySession(`sb-access-token=${jwt}`), { access_token: jwt, refresh_token: '' });
});

test('decodeJannyClaims exposes account and expiry data', () => {
    const decoded = decodeJannyClaims(jwt);
    assert.equal(decoded.email, claims.email);
    assert.equal(decoded.subject, claims.sub);
    assert.equal(decoded.expMs, claims.exp * 1000);
    assert.equal(decoded.issuer, claims.iss);
});
