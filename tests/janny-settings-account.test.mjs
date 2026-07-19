import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../app/library.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../app/library.js', import.meta.url), 'utf8');

test('JannyAI settings are status-only (bridge + account), no paste fields', () => {
    for (const id of [
        'jannySettingsBridgeStatus',
        'jannySettingsAccountStatus',
        'jannySettingsRefreshBtn',
        'jannySettingsAccountHint',
        'jannySettingsOpenJannyLink',
    ]) {
        assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    // The cookie-era controls are gone.
    for (const id of [
        'jannySettingsCookieInput',
        'jannySettingsUserAgentInput',
        'jannySettingsValidateBtn',
        'jannySettingsClearSessionBtn',
    ]) {
        assert.doesNotMatch(html, new RegExp(`id="${id}"`), `stale #${id}`);
    }
    assert.match(html, /cl-janny-bridge\.user\.js/);
});

test('library.js drops the cookie plumbing and refreshes via the bridge', () => {
    assert.ok(js.includes('function refreshJannySettingsAccountStatus'), 'missing status refresh');
    assert.ok(js.includes('window.clJannyBridge'), 'must read the bridge handle');
    assert.ok(js.includes('await bridge.refresh()'), 'Refresh must re-run bridge discovery');
    for (const stale of [
        'mergeJannyClearanceIntoCookie',
        'saveJannySettingsAccountCookie',
        'janny-set-cookie',
        'janny-clear-session',
        'janny-session',
        "getSetting('jannyCookie')",
        "setSetting('jannyCookie'",
    ]) {
        assert.ok(!js.includes(stale), `stale reference: ${stale}`);
    }
});
