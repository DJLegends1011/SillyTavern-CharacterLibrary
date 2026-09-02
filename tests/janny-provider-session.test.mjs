import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = {};

const session = await import('../modules/providers/janny/janny-session.js');
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
