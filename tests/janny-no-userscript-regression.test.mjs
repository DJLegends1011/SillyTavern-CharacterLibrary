import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const activeFiles = [
    '../README.md',
    '../app/library.html',
    '../app/library.js',
    '../modules/providers/janny/janny-api.js',
    '../modules/providers/janny/janny-browse.js',
    '../modules/providers/janny/janny-provider.js',
];

test('removes the Janny userscript and active references to both bridge transports', () => {
    assert.equal(existsSync(new URL('../extras/cl-janny-bridge.user.js', import.meta.url)), false);
    assert.equal(existsSync(new URL('../modules/providers/janny/janny-bridge.js', import.meta.url)), false);
    for (const file of activeFiles) {
        const text = readFileSync(new URL(file, import.meta.url), 'utf8');
        assert.doesNotMatch(text, /cl-janny-bridge|JannyAI[^\n]{0,120}cl-janitor-bridge|userscript[^\n]{0,120}JannyAI/i, file);
    }
});

test('retains the shared Janitor bridge for DataCat only', () => {
    assert.equal(existsSync(new URL('../extras/cl-janitor-bridge.user.js', import.meta.url)), true);
    const datacat = readFileSync(new URL('../modules/providers/datacat/datacat-provider.js', import.meta.url), 'utf8');
    assert.match(datacat, /janitor-bridge/);
});

test('keeps MeiliSearch independent from the Janny browser helper', () => {
    const api = readFileSync(new URL('../modules/providers/janny/janny-api.js', import.meta.url), 'utf8');
    const start = api.indexOf('export async function meiliMultiSearch');
    const end = api.indexOf('export function resolveTagNames', start);
    const meiliBlock = api.slice(start, end);
    assert.match(api, /const JANNY_SEARCH_URL = 'https:\/\/search\.jannyai\.com\/multi-search'/);
    assert.match(meiliBlock, /fetch\(JANNY_SEARCH_URL/);
    assert.doesNotMatch(meiliBlock, /jannyBrowserFetch|jannyai-browser/);
});
