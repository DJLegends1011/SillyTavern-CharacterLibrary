import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const helper = readFileSync(new URL('../extras/cl-helper/index.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../extras/cl-helper/package.json', import.meta.url), 'utf8'));
const library = readFileSync(new URL('../app/library.js', import.meta.url), 'utf8');
const helperModule = await import('../extras/cl-helper/index.js');

function sourceBlock(start, end) {
    const from = helper.indexOf(start);
    const to = helper.indexOf(end, from + start.length);
    assert.notEqual(from, -1, `missing source block start: ${start}`);
    assert.notEqual(to, -1, `missing source block end: ${end}`);
    return helper.slice(from, to);
}

test('registers isolated Janny routes without renaming Janitor routes', () => {
    for (const route of [
        '/jannyai-managed/start', '/jannyai-managed/stop', '/jannyai-managed/status',
        '/jannyai-browser-test', '/jannyai-browser-fetch',
        '/jannyai-browser-session', '/jannyai-browser-logout',
    ]) assert.ok(helper.includes(route), `missing ${route}`);
    for (const route of [
        '/janitorai-managed/start', '/janitorai-browser-test',
        '/janitorai-browser-fetch', '/janitorai-browser-session',
    ]) assert.ok(helper.includes(route), `Janitor regression: missing ${route}`);
    assert.match(helper, /_jannyWarmPage/);
    assert.match(helper, /closeJannyWarmPage/);
    assert.doesNotMatch(helper, /console\.(?:log|info|warn|error)\([^\n]*(?:req\.body|accessToken|refreshToken|authorization|cookie[^\n]*value)/i);
});

test('bumps and bundles the three-file helper', () => {
    assert.equal(pkg.version, '1.13.0');
    assert.match(helper, /\['package\.json', 'index\.js', 'janny-browser-policy\.js'\]/);
    assert.match(library, /\['package\.json', 'index\.js', 'janny-browser-policy\.js'\]/);
});

test('Janny page-origin guard accepts only the exact Janny origin', async () => {
    const guard = helperModule.assertJannyPageOrigin;
    assert.equal(typeof guard, 'function', 'missing executable Janny page-origin guard');
    assert.equal(await guard({ evaluate: async () => 'https://jannyai.com/collections?page=1' }), 'https://jannyai.com/collections?page=1');
    await assert.rejects(
        guard({ evaluate: async () => 'https://attacker.example/redirected' }),
        error => error?.code === 'JANNY_REQUEST_BLOCKED',
    );
});

test('warm-up validates the live page origin after navigation', () => {
    const block = sourceBlock('async function getJannyWarmPage(', 'async function injectJannySession(');
    const navigation = block.indexOf('await page.goto(');
    const guard = block.indexOf('await assertJannyPageOrigin(page);', navigation);
    const publish = block.indexOf('_jannyWarmPage = { client, page }');
    assert.ok(navigation >= 0 && guard > navigation && publish > guard, 'warm page is published without a post-navigation origin guard');
});

test('hydrated extraction validates the live page origin after navigation', () => {
    const block = sourceBlock('async function extractHydratedJannyCharacter(', '// Managed browser');
    const navigation = block.indexOf('await page.goto(');
    const guard = block.indexOf('await assertJannyPageOrigin(page);', navigation);
    const inspection = block.indexOf('document.readyState');
    assert.ok(navigation >= 0 && guard > navigation && inspection > guard, 'hydrated extraction inspects an unverified redirected page');
});

test('fetch reuse validates the live origin before bearer construction and uses an absolute Janny URL', () => {
    const block = sourceBlock("router.post('/jannyai-browser-fetch'", "router.post('/jannyai-browser-session'");
    const warm = block.indexOf('const warm = await getJannyWarmPage(');
    const guard = block.indexOf('await assertJannyPageOrigin(warm.page);', warm);
    const bearer = block.indexOf('headers.Authorization', warm);
    assert.ok(warm >= 0 && guard > warm && bearer > guard, 'bearer can be constructed before the reused page origin is verified');
    assert.match(block, /fetch\(\$\{JSON\.stringify\(`\$\{JANNY_ORIGIN\}\$\{request\.safePath\}`\)\}/);
});
