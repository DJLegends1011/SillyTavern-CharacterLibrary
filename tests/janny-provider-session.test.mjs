import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const calls = [], settingsWrites = [], bridgeMessages = [];
globalThis.window = {
    getSetting: () => undefined,
    setSetting: (key, value) => settingsWrites.push([key, value]),
    addEventListener() {}, postMessage: message => bridgeMessages.push(message), location: { origin: 'http://localhost' },
    apiRequest: async (path, method, body) => {
        calls.push({ path, method, keys: Object.keys(body) });
        return { ok: true, status: 200, json: async () => ({ ok: true, active: true, email: 'reader@example.test', expMs: 2_000_000_000_000, hasRefresh: true, refreshable: true }) };
    },
};

await import('../modules/core-api.js');
const session = await import('../modules/providers/janny/janny-session.js');
const { default: provider } = await import('../modules/providers/janny/janny-provider.js');
const source = readFileSync(new URL('../modules/providers/janny/janny-session.js', import.meta.url), 'utf8');
const library = readFileSync(new URL('../app/library.js', import.meta.url), 'utf8');

test('session initialization exposes the four browser-owned lifecycle operations', () => {
    session.initJannySession();
    assert.equal(window.jannySetSession, session.jannySetSession);
    assert.equal(window.jannySessionStatus, session.jannySessionStatus);
    assert.equal(window.jannyRecoverSession, session.jannyRecoverSession);
    assert.equal(window.jannyLogout, session.jannyLogout);
});

test('session coordination has no direct Supabase transport or credential persistence path', () => {
    assert.doesNotMatch(source, /\bapikey\b|\/auth\/v1\/user|grant_type=refresh_token/i);
    const legacyWrites = [...source.matchAll(/CoreAPI\.setSetting\(\s*['"]janny(?:Refresh)?Token['"]\s*,\s*([^)\n]+)\)/g)]
        .map(match => match[1].trim());
    assert.deepEqual(legacyWrites, ['null', 'null']);

    const defaults = library.slice(library.indexOf('const DEFAULT_SETTINGS = {'), library.indexOf('// ---- NSFW Toggles ----'));
    assert.match(defaults, /\bjannyToken\s*:\s*null/);
    assert.doesNotMatch(defaults, /\bjannyRefreshToken\s*:/);
});

test('provider initialization wires all browser-owned session operations without bridge startup', async () => {
    await provider.init({});
    // Construct a deliberately unsigned synthetic input; never save or log its value.
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'none' })}.${encode({ iss: 'https://eenzcbluoctduymzksoq.supabase.co/auth/v1', exp: 2_000_000_000 })}.test`;
    assert.equal((await window.jannySetSession(JSON.stringify({ access_token: token }))).ok, true);
    assert.equal((await window.jannySessionStatus()).active, true);
    assert.equal((await window.jannyRecoverSession()).active, true);
    assert.equal((await window.jannyLogout()).ok, true);
    assert.deepEqual(calls.map(call => call.path), [
        '/plugins/cl-helper/jannyai-browser-session',
        '/plugins/cl-helper/jannyai-browser-session-status',
        '/plugins/cl-helper/jannyai-browser-session-status',
        '/plugins/cl-helper/jannyai-browser-refresh-session',
        '/plugins/cl-helper/jannyai-browser-logout',
    ]);
    assert.ok(calls.every(call => call.method === 'POST'));
    assert.deepEqual(settingsWrites, [['jannyToken', null], ['jannyRefreshToken', null], ['jannyToken', null], ['jannyRefreshToken', null]]);
    assert.equal(bridgeMessages.length, 0);
    assert.equal(typeof window.jannyTestBrowserEndpoint, 'function');
    assert.equal(window.getValidJannyToken, undefined);
    assert.equal(provider.minClHelperVersion, '1.13.0');
});
