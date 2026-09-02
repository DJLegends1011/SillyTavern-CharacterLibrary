import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createJannyHelperHarness, jannyCharacterDocument } from './helpers/janny-helper-harness.mjs';

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

test('hydrated extraction rejects foreign navigation before any document inspection', async () => {
    const reads = [];
    const harness = createJannyHelperHarness([], {
        finalUrl: 'https://other.example/',
        document: new Proxy({}, { get: (_target, key) => { reads.push(key); throw new Error('Unverified document'); } }),
    });
    const response = await harness.apiRequest('/plugins/cl-helper/jannyai-browser-fetch', 'POST', {
        path: characterPath, method: 'GET', inspectCharacterId: characterId,
    });
    assert.equal((await response.json()).error, 'JANNY_REQUEST_BLOCKED');
    assert.deepEqual(reads, []);
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

const characterId = 'aaaaaaaa-1111-4111-8111-111111111111';
const characterPath = `/characters/${characterId}_demo`;
const completeCharacter = { id: characterId, name: 'Demo', firstMessage: 'Hello', personality: 'Definition', scenario: '', exampleDialogs: '' };

async function inspectCharacter(character = completeCharacter, options = {}) {
    const harness = createJannyHelperHarness([{ status: 200, finalUrl: 'https://jannyai.com' + characterPath, body: '' }], {
        document: jannyCharacterDocument(character, options), finalUrl: options.finalUrl,
    });
    const response = await harness.apiRequest('/plugins/cl-helper/jannyai-browser-fetch', 'POST', {
        path: characterPath, method: 'GET', inspectCharacterId: characterId,
    });
    return { harness, response, result: await response.json() };
}

for (const attributes of [{}, { componentExport: 'default', componentUrl: '/_astro/CharacterButtons.hash.js' }]) {
    test('extracts only CharacterButtons props with one navigation: ' + JSON.stringify(attributes), async () => {
        const { harness, response, result } = await inspectCharacter(completeCharacter, attributes);
        assert.equal(response.ok, true);
        assert.deepEqual(result, { ok: true, status: 200, body: '', finalUrl: 'https://jannyai.com' + characterPath,
            hydratedCharacter: { character: completeCharacter, imageUrl: 'https://image.jannyai.com/demo.png' } });
        assert.deepEqual(harness.navigations, ['https://jannyai.com' + characterPath]);
        assert.equal(harness.requests.length, 0, 'definition inspection must not fetch before navigating');
    });
}

for (const [name, character, options] of [
    ['wrong identity', { ...completeCharacter, id: 'bbbbbbbb-2222-4222-8222-222222222222' }, {}],
    ['missing greeting', { ...completeCharacter, firstMessage: ' ' }, {}],
    ['listing only', { ...completeCharacter, personality: '', scenario: '', exampleDialogs: '' }, {}],
    ['nonstring definition', { ...completeCharacter, personality: {} }, {}],
    ['mixed malformed definition', { ...completeCharacter, scenario: {} }, {}],
    ['unrelated island', completeCharacter, { componentExport: 'ListingCard' }],
    ['malformed props', completeCharacter, { rawProps: '{broken' }],
]) {
    test('rejects ' + name + ' without another transport', async () => {
        const { harness, result } = await inspectCharacter(character, options);
        assert.equal(result.ok, false);
        assert.equal(result.error, 'JANNY_PAGE_SHAPE_CHANGED');
        assert.equal(harness.requests.length, 0);
        assert.equal(harness.navigations.length, 1);
        assert.equal('hydratedCharacter' in result, false);
    });
}

for (const [name, options, code] of [
    ['challenge', { title: 'Just a moment...', marker: true }, 'JANNY_CF_BLOCKED'],
    ['forbidden', { title: 'Forbidden' }, 'JANNY_CF_BLOCKED'],
    ['login', { finalUrl: 'https://jannyai.com/auth/login?next=%2Fcharacters' }, 'JANNY_LOGIN_REQUIRED'],
    ['inline login form', { title: 'Sign in', marker: 'login' }, 'JANNY_LOGIN_REQUIRED'],
    ['foreign redirect', { finalUrl: 'https://other.example/characters/demo' }, 'JANNY_REQUEST_BLOCKED'],
    ['unrelated path', { finalUrl: 'https://jannyai.com/collections' }, 'JANNY_REQUEST_BLOCKED'],
    ['different character path', { finalUrl: 'https://jannyai.com/characters/bbbbbbbb-2222-4222-8222-222222222222_demo' }, 'JANNY_REQUEST_BLOCKED'],
]) {
    test('classifies ' + name + ' before reading props', async () => {
        let propsRead = false;
        const { result } = await inspectCharacter(completeCharacter, { ...options, onPropsRead: () => { propsRead = true; } });
        assert.equal(result.ok, false);
        assert.equal(result.error, code);
        assert.equal('hydratedCharacter' in result, false);
        assert.equal(propsRead, false);
    });
}

test('authored challenge words and ambient Cloudflare scripts do not block a complete character', async () => {
    const character = { ...completeCharacter, personality: 'Cloudflare captcha challenge: Just a moment, verify you are human.' };
    const { result } = await inspectCharacter(character, { marker: true });
    assert.deepEqual(result.hydratedCharacter?.character, character);
});

test('a character title matching challenge copy plus an ambient script is not an interstitial', async () => {
    const { result } = await inspectCharacter(completeCharacter, { title: 'Just a moment', marker: 'script' });
    assert.deepEqual(result.hydratedCharacter?.character, completeCharacter);
});

test('a character named Forbidden with normal site title chrome is not a blocked page', async () => {
    const { result } = await inspectCharacter(completeCharacter, { title: 'Forbidden | JannyAI' });
    assert.deepEqual(result.hydratedCharacter?.character, completeCharacter);
});
