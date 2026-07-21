import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../app/library.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../app/library.js', import.meta.url), 'utf8');

test('JannyAI settings mirror the maintainer token-login controls', () => {
    for (const id of [
        'jannySettingsBridgeStatus',
        'jannySettingsAccountStatus',
        'jannySettingsRefreshBtn',
        'jannySettingsAccountHint',
        'jannySettingsOpenJannyLink',
        'jannyRandomizeCollectionCards',
        'settingsJannyToken',
        'toggleJannyTokenVisibility',
        'saveJannyTokenBtn',
        'clearJannyTokenBtn',
    ]) {
        assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    assert.match(html, /No JannyAI tab needs to stay open/);
    assert.match(html, /sb-eenzcbluoctduymzksoq-auth-token/);
    assert.match(html, /cl-janny-bridge\.user\.js/);
});

test('library.js saves, clears, and verifies the pasted Janny login', () => {
    assert.match(js, /jannyToken: null/);
    assert.match(js, /window\.jannySetSession/);
    assert.match(js, /window\.jannyLogout/);
    assert.match(js, /getValidJannyToken/);
    assert.match(js, /await bridge\.refresh\(\)/);
    assert.doesNotMatch(js, /Log into jannyai\.com in this same browser/);
});

test('Janny collection randomization is saved and defaults to latest order', () => {
    assert.match(js, /jannyRandomizeCollectionCards: false/);
    assert.match(js, /jannyRandomizeCollectionCardsCheckbox\.checked = getSetting\('jannyRandomizeCollectionCards'\) === true/);
    assert.match(js, /jannyRandomizeCollectionCards: jannyRandomizeCollectionCardsCheckbox/);
    assert.match(html, /Off by default: collection cards are sorted by newest character first/);
});
