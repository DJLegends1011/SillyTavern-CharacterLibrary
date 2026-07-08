import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../app/library.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../app/library.js', import.meta.url), 'utf8');

test('JannyAI settings expose account sync controls', () => {
    const requiredIds = [
        'jannySettingsAccountStatus',
        'jannySettingsCookieInput',
        'jannySettingsUserAgentInput',
        'jannySettingsSaveCookieBtn',
        'jannySettingsValidateBtn',
        'jannySettingsClearSessionBtn',
        'jannySettingsOpenJannyLink',
        'jannySettingsAccountHint',
    ];

    for (const id of requiredIds) {
        assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
    }

    assert.match(html, /JannyAI Account Sync/);
    assert.match(html, /Cookie header/);
    assert.match(html, /id="jannySettingsOpenJannyLink"[^>]+href="https:\/\/jannyai\.com\/collections"/);
});

test('JannyAI settings account controls are wired to cl-helper routes', () => {
    const requiredSnippets = [
        'updateJannySettingsAccountStatus',
        'saveJannySettingsAccountCookie',
        'clearJannySettingsAccountCookie',
        'validateJannySettingsAccount',
        "apiRequest('/plugins/cl-helper/janny-set-cookie'",
        'buildJannySettingsValidateEndpoint',
        'apiRequest(buildJannySettingsValidateEndpoint())',
        "apiRequest('/plugins/cl-helper/janny-clear-session'",
    ];

    for (const snippet of requiredSnippets) {
        assert.ok(js.includes(snippet), `missing ${snippet}`);
    }
});

test('JannyAI settings validation does not depend on DataCat FlareSolverr', () => {
    const validateFn = js.match(/function buildJannySettingsValidateEndpoint\(\) \{[\s\S]*?\n    \}/)?.[0] || '';
    assert.match(validateFn, /janny-validate/);
    assert.doesNotMatch(validateFn, /datacatFlareSolverrUrl/);
    assert.match(js, /apiRequest\(buildJannySettingsValidateEndpoint\(\)\)/);
});
test('JannyAI settings do not use the experimental local browser helper routes', () => {
    assert.doesNotMatch(js, /janny-browser-(start|status|stop)/);
    assert.doesNotMatch(html, /Open Browser Login|Check Browser/);
});
