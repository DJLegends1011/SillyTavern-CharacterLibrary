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
        'jannySettingsAccountHint',
    ];

    for (const id of requiredIds) {
        assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
    }

    assert.match(html, /JannyAI Account Sync/);
    assert.match(html, /Cookie header/);
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

test('JannyAI settings validation passes the configured FlareSolverr URL', () => {
    assert.match(js, /function buildJannySettingsValidateEndpoint[\s\S]*datacatFlareSolverrUrl[\s\S]*flareUrl/);
    assert.match(js, /apiRequest\(buildJannySettingsValidateEndpoint\(\)\)/);
});