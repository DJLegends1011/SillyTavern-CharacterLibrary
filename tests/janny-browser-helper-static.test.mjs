import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createJannyHelperHarness } from './helpers/janny-helper-harness.mjs';

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

test('fetch reuse validates the live origin before request construction and uses an absolute Janny URL', () => {
    const block = sourceBlock("router.post('/jannyai-browser-fetch'", "router.post('/jannyai-browser-session'");
    const warm = block.indexOf('const warm = await getJannyWarmPage(');
    const guard = block.indexOf('await assertJannyPageOrigin(warm.page);', warm);
    const headers = block.indexOf('const headers =', warm);
    assert.ok(warm >= 0 && guard > warm && headers > guard, 'request can be constructed before the reused page origin is verified');
    assert.match(block, /fetch\(\$\{JSON\.stringify\(`\$\{JANNY_ORIGIN\}\$\{request\.safePath\}`\)\}/);
});

test('ordinary Janny helper fetches use browser cookies and never forward legacy tokens', async () => {
    const harness = createJannyHelperHarness(Array.from({ length: 3 }, () => ({
        status: 200, finalUrl: 'https://jannyai.com/collections', body: '',
    })));
    for (const token of ['synthetic-legacy-token', 123, 'x'.repeat(16_385)]) {
        const response = await harness.apiRequest('/plugins/cl-helper/jannyai-browser-fetch', 'POST', {
            path: '/collections/form/add-collection', method: 'POST',
            formBody: { name: 'A & B', description: '', isPrivate: 'yes' }, token,
        });
        assert.equal(response.status, 200);
        const reply = await response.json();
        assert.equal(reply.ok, true);
        assert.equal(reply.body, '');
    }
    assert.equal(harness.requests.length, 3);
    for (const request of harness.requests) {
        assert.equal(request.url, 'https://jannyai.com/collections/form/add-collection');
        assert.deepEqual(request.init, {
            credentials: 'include', method: 'POST',
            headers: { Accept: 'application/x-www-form-urlencoded', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'name=A+%26+B&description=&isPrivate=yes',
        });
    }
});

for (const fixture of [
    { name: 'unauthorized form response', status: 401, finalUrl: 'https://jannyai.com/collections/form/add-collection', body: '{}' },
    { name: 'rate-limited form response', status: 429, finalUrl: 'https://jannyai.com/collections/form/add-collection', body: '{"error":"slow down"}' },
    { name: 'server-error form response', status: 500, finalUrl: 'https://jannyai.com/collections/form/add-collection', body: '{}' },
    { name: 'same-origin login redirect', status: 200, finalUrl: 'https://jannyai.com/auth/login?next=%2Fcollections', body: '<html>Sign in</html>' },
    { name: 'successful collection redirect', status: 200, finalUrl: 'https://jannyai.com/collections/aaaaaaaa-1111-4111-8111-111111111111_set', body: '' },
    { name: 'successful collection edit redirect', status: 200, finalUrl: 'https://jannyai.com/collections/aaaaaaaa-1111-4111-8111-111111111111_set/edit', body: '' },
]) {
    test('helper preserves ' + fixture.name + ' for client completion', async () => {
        const harness = createJannyHelperHarness([fixture]);
        const response = await harness.apiRequest('/plugins/cl-helper/jannyai-browser-fetch', 'POST', {
            path: '/collections/form/add-collection', method: 'POST',
            formBody: { name: 'Set', description: '', isPrivate: 'yes' },
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            ok: true, status: fixture.status, finalUrl: fixture.finalUrl, body: fixture.body, hydratedCharacter: null,
        });
    });
}

test('helper rejects cross-origin form redirects at successful and failed statuses', async () => {
    for (const status of [200, 302, 401, 429, 500]) {
        const harness = createJannyHelperHarness([{ status, finalUrl: 'https://other.example/collections', body: 'untrusted' }]);
        const response = await harness.apiRequest('/plugins/cl-helper/jannyai-browser-fetch', 'POST', {
            path: '/collections/form/add-collection', method: 'POST',
            formBody: { name: 'Set', description: '', isPrivate: 'yes' },
        });
        assert.equal(response.ok, false);
        const result = await response.json();
        assert.equal(result.ok, false);
        assert.equal('body' in result, false);
    }
});

test('helper still rejects unexpected successful form destinations', async () => {
    for (const path of ['/admin', '/collections/form/add-collection', '/auth/login-unrelated',
        '/collections/aaaaaaaa-1111-4111-8111-111111111111_set/edit/admin']) {
        const harness = createJannyHelperHarness([{ status: 200, finalUrl: 'https://jannyai.com' + path, body: 'unexpected' }]);
        const response = await harness.apiRequest('/plugins/cl-helper/jannyai-browser-fetch', 'POST', {
            path: '/collections/form/add-collection', method: 'POST',
            formBody: { name: 'Set', description: '', isPrivate: 'yes' },
        });
        assert.equal(response.ok, false);
        assert.equal((await response.json()).ok, false);
    }
});
