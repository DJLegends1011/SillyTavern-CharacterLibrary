import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../extras/cl-janny-bridge.user.js', import.meta.url), 'utf8');

test('janny bridge userscript is scoped to jannyai.com only', () => {
    assert.match(src, /@connect\s+jannyai\.com/);
    assert.doesNotMatch(src, /janitorai\.com/);
    assert.match(src, /https:\/\/jannyai\.com/);
});

test('janny bridge uses its own message tags (no cross-talk with the janitor bridge)', () => {
    assert.match(src, /'character-library-janny'/);
    assert.match(src, /'cl-janny-bridge'/);
    assert.doesNotMatch(src, /'cl-janitor-bridge'/);
});

test('janny bridge allowlists the account + public collection surface', () => {
    for (const marker of [
        '/api/bookmark',
        '/api/get-characters',
        '/api/collections/mine',
        '/collections/form/add-collection',
        '/collections/form/edit-collection',
        '/collections/form/delete-collection',
        'collectors',
    ]) {
        assert.ok(src.includes(marker), `missing allowlist marker: ${marker}`);
    }
});

test('janny bridge keeps the security guards', () => {
    assert.match(src, /e\.origin !== location\.origin/);
    assert.match(src, /@noframes/);
    assert.match(src, /finalUrl/);
});
