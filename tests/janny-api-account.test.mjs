import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJannyHelperHarness } from './helpers/janny-helper-harness.mjs';

const seenFetchBodies = [];
const helperReplies = [];
let recoveryCalls, statusCalls, directFetchCount, refreshStatus, sessionStatus;
let helperFailure, recoveryFailure, statusFailure;
const collectionId = 'cccccccc-3333-4333-8333-333333333333';
const characterId = 'aaaaaaaa-1111-4111-8111-111111111111';
const publicHtml = '<a href="/collections/dddddddd-4444-4444-8444-444444444444_cool"><h3>Cool (12 characters)</h3></a>';

globalThis.window = {
    getSetting: () => undefined,
    apiRequest: async (path, method, body) => {
        assert.equal(path, '/plugins/cl-helper/jannyai-browser-fetch');
        assert.equal(method, 'POST');
        seenFetchBodies.push(body);
        if (helperFailure) return helperFailure;
        const result = helperReplies.shift() || { ok: true, status: 200, body: publicHtml };
        return { ok: true, status: 200, json: async () => ({ finalUrl: 'https://jannyai.com' + body.path, ...result }) };
    },
};
globalThis.fetch = async url => {
    directFetchCount++;
    return { ok: true, status: 200, text: async () => String(url).startsWith('https://search.jannyai.com/') ? '{"results":[]}' : publicHtml };
};
// Enter the existing circular provider graph through its real core entry point.
await import('../modules/core-api.js');
const { setJannySessionBrowserHooks } = await import('../modules/providers/janny/janny-session.js');
const api = await import('../modules/providers/janny/janny-api.js');
setJannySessionBrowserHooks({
    status: async () => {
        statusCalls++;
        if (statusFailure) throw statusFailure;
        return sessionStatus;
    },
    refresh: async () => {
        recoveryCalls++;
        if (recoveryFailure) throw recoveryFailure;
        return refreshStatus;
    },
});

beforeEach(() => {
    seenFetchBodies.length = helperReplies.length = 0;
    recoveryCalls = statusCalls = directFetchCount = 0;
    helperFailure = recoveryFailure = statusFailure = null;
    sessionStatus = { active: true, hasRefresh: true, refreshable: true };
    refreshStatus = { active: true, hasRefresh: true, refreshable: true };
});

test('fetchJannyBookmarks normalizes object and string bookmark entries', async () => {
    helperReplies.push({ ok: true, status: 200, body: '{"bookmarks":[{"characterId":"one"},{"character_id":"two"},{"id":"three"},"four",{},null]}' });
    assert.deepEqual(await api.fetchJannyBookmarks(), ['one', 'two', 'three', 'four']);
    assert.equal(seenFetchBodies[0].path, '/api/bookmark');
});

test('addJannyBookmarks POSTs deduplicated JSON without account credentials', async () => {
    helperReplies.push({ ok: true, status: 200, body: '{"bookmarks":["saved"]}' });
    assert.deepEqual(await api.addJannyBookmarks([characterId, characterId]), ['saved']);
    assert.deepEqual(seenFetchBodies[0], {
        managed: true, path: '/api/bookmark', method: 'POST',
        jsonBody: { characterIDs: [characterId] }, formBody: undefined, inspectCharacterId: undefined,
    });
});

test('removeJannyBookmarks DELETEs an encoded ids query', async () => {
    helperReplies.push({ ok: true, status: 200, body: '{"bookmarks":[]}' });
    assert.deepEqual(await api.removeJannyBookmarks(['one', 'two']), []);
    assert.equal(seenFetchBodies[0].method, 'DELETE');
    assert.equal(seenFetchBodies[0].path, '/api/bookmark?ids=one%2Ctwo');
});

test('empty bookmark and character inputs dispatch no requests', async () => {
    assert.deepEqual(await api.addJannyBookmarks([]), []);
    assert.deepEqual(await api.removeJannyBookmarks([]), []);
    assert.deepEqual(await api.fetchJannyCharactersByIds([]), []);
    assert.deepEqual(await api.fetchJannyCollectionCharacters(''), []);
    assert.equal(seenFetchBodies.length, 0);
});

test('character lookups chunk at twenty ids and combine results without anonymous flags', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => 'id-' + (i + 1));
    helperReplies.push(
        { ok: true, status: 200, body: '{"characters":[{"id":"first"}]}' },
        { ok: true, status: 200, body: '{"characters":[{"id":"last"}]}' },
    );
    assert.deepEqual(await api.fetchJannyPublicCharactersByIds([...ids, 'id-1']), [{ id: 'first' }, { id: 'last' }]);
    assert.equal(seenFetchBodies.length, 2);
    assert.equal(seenFetchBodies[0].path, '/api/get-characters?ids=id-1%2Cid-2%2Cid-3%2Cid-4%2Cid-5%2Cid-6%2Cid-7%2Cid-8%2Cid-9%2Cid-10%2Cid-11%2Cid-12%2Cid-13%2Cid-14%2Cid-15%2Cid-16%2Cid-17%2Cid-18%2Cid-19%2Cid-20');
    assert.equal(seenFetchBodies[1].path, '/api/get-characters?ids=id-21');
    for (const body of seenFetchBodies) {
        assert.equal('token' in body, false);
        assert.equal('anonymous' in body, false);
    }
});

test('fetches owned collections and collection characters', async () => {
    helperReplies.push(
        { ok: true, status: 200, body: '{"collections":[{"id":"mine"}]}' },
        { ok: true, status: 200, body: '{"characters":[{"id":"member"}]}' },
    );
    assert.deepEqual(await api.fetchJannyCollections(), [{ id: 'mine' }]);
    assert.deepEqual(await api.fetchJannyCollectionCharacters(collectionId), [{ id: 'member' }]);
    assert.equal(seenFetchBodies[0].path, '/api/collections/mine');
    assert.equal(seenFetchBodies[1].path, '/api/collections/' + collectionId + '/characters');
});

test('adds and removes collection characters with JSON and encoded queries', async () => {
    helperReplies.push(
        { ok: true, status: 200, body: '{"added":true}' },
        { ok: true, status: 200, body: '{"removed":true}' },
    );
    assert.deepEqual(await api.addJannyCharacterToCollection(collectionId, characterId), { added: true });
    assert.deepEqual(await api.removeJannyCharacterFromCollection(collectionId, 'id & two'), { removed: true });
    assert.equal(seenFetchBodies[0].method, 'POST');
    assert.equal(seenFetchBodies[0].path, '/api/collections/' + collectionId + '/characters');
    assert.deepEqual(seenFetchBodies[0].jsonBody, { characterId });
    assert.equal(seenFetchBodies[1].method, 'DELETE');
    assert.equal(seenFetchBodies[1].path, '/api/collections/' + collectionId + '/characters?characterId=id%20%26%20two');
});

test('createJannyCollection form-POSTs and extracts the new id from finalUrl', async () => {
    const location = 'https://jannyai.com/collections/' + collectionId + '_my-set/edit';
    helperReplies.push({ ok: true, status: 200, body: '<html>edit page</html>', finalUrl: location });
    assert.deepEqual(await api.createJannyCollection({ name: 'My Set', description: 'd', isPrivate: true }), {
        success: true, id: collectionId, location,
    });
    assert.equal(seenFetchBodies[0].path, '/collections/form/add-collection');
    assert.equal(seenFetchBodies[0].method, 'POST');
    assert.deepEqual(seenFetchBodies[0].formBody, { name: 'My Set', description: 'd', isPrivate: 'yes' });
});

test('updates and deletes collections with form posts and accepts empty successful bodies', async () => {
    helperReplies.push(
        { ok: true, status: 200, body: '', finalUrl: 'https://jannyai.com/collections' },
        { ok: true, status: 204, body: '', finalUrl: 'https://jannyai.com/collections' },
    );
    assert.deepEqual(await api.updateJannyCollection({ id: collectionId, name: 'Public & new', isPrivate: false }), {
        success: true, location: 'https://jannyai.com/collections',
    });
    assert.deepEqual(await api.deleteJannyCollection(collectionId), { success: true, location: 'https://jannyai.com/collections' });
    assert.equal(seenFetchBodies[0].path, '/collections/form/edit-collection');
    assert.deepEqual(seenFetchBodies[0].formBody, { id: collectionId, name: 'Public & new', description: '', isPrivate: 'no' });
    assert.equal(seenFetchBodies[1].path, '/collections/form/delete-collection');
    assert.deepEqual(seenFetchBodies[1].formBody, { id: collectionId });
    assert.ok(seenFetchBodies.every(body => body.method === 'POST'));
});

test('retries one 401 after one browser-owned recovery', async () => {
    helperReplies.push({ ok: true, status: 401, body: '{}' });
    helperReplies.push({ ok: true, status: 200, body: '{"bookmarks":[]}' });
    refreshStatus = { active: true, hasRefresh: true, refreshable: true };
    assert.deepEqual(await api.fetchJannyBookmarks(), []);
    assert.equal(recoveryCalls, 1);
    assert.equal(seenFetchBodies.length, 2);
    assert.equal('token' in seenFetchBodies[0], false);
    assert.equal('token' in seenFetchBodies[1], false);
});

test('stops after a second 401', async () => {
    helperReplies.push({ ok: true, status: 401, body: '{}' });
    helperReplies.push({ ok: true, status: 401, body: '{}' });
    await assert.rejects(api.fetchJannyBookmarks(), error => error.code === 'JANNY_LOGIN_REQUIRED' && error.status === 401);
    assert.equal(recoveryCalls, 1);
    assert.equal(seenFetchBodies.length, 2);
});

test('inactive recovery does not retry the failed request', async () => {
    helperReplies.push({ ok: true, status: 401, body: '{}' });
    refreshStatus = { active: false, hasRefresh: false, refreshable: false };
    await assert.rejects(api.fetchJannyCollections(), error => error.code === 'JANNY_LOGIN_REQUIRED');
    assert.equal(recoveryCalls, 1);
    assert.equal(seenFetchBodies.length, 1);
});

test('retries a rejected mutation with the same JSON body only once', async () => {
    helperReplies.push({ ok: true, status: 401, body: '{}' }, { ok: true, status: 200, body: '{"bookmarks":["saved"]}' });
    assert.deepEqual(await api.addJannyBookmarks([characterId]), ['saved']);
    assert.deepEqual(seenFetchBodies[1], seenFetchBodies[0]);
    assert.equal(recoveryCalls, 1);
});

test('preserves classified recovery failures without retrying', async () => {
    helperReplies.push({ ok: true, status: 401, body: '{}' });
    recoveryFailure = Object.assign(new Error('Browser unavailable.'), { code: 'JANNY_BROWSER_UNAVAILABLE' });
    await assert.rejects(api.fetchJannyBookmarks(), error => error === recoveryFailure);
    assert.equal(recoveryCalls, 1);
    assert.equal(seenFetchBodies.length, 1);
});

test('public collection pages require browser transport and have no direct fetch fallback', async () => {
    const data = await api.fetchJannyPublicCollections({ sort: 'latest', page: 2 });
    assert.equal(seenFetchBodies.length, 1);
    assert.equal(seenFetchBodies.at(-1).path, '/collections?sort=latest&page=2');
    assert.equal(directFetchCount, 0);
    assert.equal(data.ok, true);
    assert.equal(data.status, 200);
    assert.equal(data.collections.length, 1);
    assert.equal(data.collections[0].id, 'dddddddd-4444-4444-8444-444444444444');
});

test('public page helper failure does not trigger direct fetch', async () => {
    helperFailure = { ok: false, status: 404, json: async () => ({ ok: false, error: 'Plugin route not found' }) };
    await assert.rejects(api.fetchJannyPublicCollections(), error => error.code === 'JANNY_HELPER_UNAVAILABLE');
    assert.equal(directFetchCount, 0);
    assert.equal(recoveryCalls, 0);
});

test('collector pages and collection details use browser transport and existing parsers', async () => {
    const collector = await api.fetchJannyCollectorCollections(' Reader Name ');
    assert.equal(collector.collections[0].name, 'Cool');
    assert.equal(seenFetchBodies.length, 1);
    assert.equal(seenFetchBodies[0].path, '/collectors/Reader%20Name');
    helperReplies.push({ ok: true, status: 200, body: '<h1>My Set</h1><a href="/characters/' + characterId + '_one">One</a>' });
    const detail = await api.fetchJannyPublicCollection('/collections/' + collectionId + '_my-set');
    assert.equal(detail.collection.name, 'My Set');
    assert.equal(detail.collection.id, collectionId);
    assert.deepEqual(detail.characterIds, [characterId]);
    assert.equal(seenFetchBodies[1].path, '/collections/' + collectionId + '_my-set');
    assert.equal(directFetchCount, 0);
});

test('public page input validation rejects unsafe paths before helper dispatch', async () => {
    await assert.rejects(api.fetchJannyCollectorCollections('a/b'));
    await assert.rejects(api.fetchJannyPublicCollection('https://other.example/collections/x'));
    assert.equal(seenFetchBodies.length, 0);
});

test('rejects 200 Cloudflare interstitials and login pages instead of accepting empty results', async () => {
    for (const fixture of [
        { body: '<title>Just a moment</title>', code: 'JANNY_CF_BLOCKED' },
        { body: '<html><title>Sign in | JannyAI</title><form><input type="password"></form></html>', code: 'JANNY_LOGIN_REQUIRED' },
        { body: '<html>Sign in</html>', finalUrl: 'https://jannyai.com/auth/login?next=%2Fcollections', code: 'JANNY_LOGIN_REQUIRED' },
    ]) {
        helperReplies.push({ ok: true, status: 200, ...fixture });
        await assert.rejects(api.fetchJannyPublicCollections(), error => error.code === fixture.code);
    }
    assert.equal(recoveryCalls, 0);
});

test('legitimate collection content mentioning login or Cloudflare remains usable', async () => {
    helperReplies.push({ ok: true, status: 200, body: publicHtml + '<a href="/auth/login">Login</a><p>Cloudflare challenge story</p><script src="/cdn-cgi/challenge-platform/h/g"></script>' });
    assert.equal((await api.fetchJannyPublicCollections()).collections[0].name, 'Cool');
});

test('successful character JSON containing challenge markup is treated as data', async () => {
    helperReplies.push({ ok: true, status: 200, body: '{"characters":[{"id":"one","description":"<title>Sign in</title> cf-chl-example"}]}' });
    assert.deepEqual(await api.fetchJannyCharactersByIds(['one']), [
        { id: 'one', description: '<title>Sign in</title> cf-chl-example' },
    ]);
});

test('preserves rate-limit, Cloudflare, policy and HTTP failures without recovery', async () => {
    for (const [status, body, code] of [
        [429, '{}', 'JANNY_RATE_LIMITED'],
        [403, '<title>Just a moment</title>', 'JANNY_CF_BLOCKED'],
        [403, 'JANNY_REQUEST_BLOCKED', 'JANNY_REQUEST_BLOCKED'],
        [500, '{}', 'JANNY_HTTP_ERROR'],
    ]) {
        helperReplies.push({ ok: true, status, body });
        await assert.rejects(api.fetchJannyBookmarks(), error => error.code === code && error.status === status);
    }
    assert.equal(recoveryCalls, 0);
});

test('probe reads redacted status then verifies active accounts with a read-only bookmark request', async () => {
    helperReplies.push({ ok: true, status: 200, body: '{"bookmarks":[]}' });
    assert.deepEqual(await api.probeJannyAccount(), { browser: true, active: true, cloudflare: false, reason: '', code: '' });
    assert.equal(statusCalls, 1);
    assert.equal(seenFetchBodies.length, 1);
    assert.equal(seenFetchBodies[0].method, 'GET');
    assert.equal(seenFetchBodies[0].path, '/api/bookmark');
});

test('probe returns login required for inactive status without account requests or recovery', async () => {
    sessionStatus = { active: false, hasRefresh: true, refreshable: true };
    const result = await api.probeJannyAccount();
    assert.equal(result.browser, true);
    assert.equal(result.active, false);
    assert.equal(result.cloudflare, false);
    assert.equal(result.code, 'JANNY_LOGIN_REQUIRED');
    assert.ok(result.reason);
    assert.equal(statusCalls, 1);
    assert.equal(seenFetchBodies.length, 0);
    assert.equal(recoveryCalls, 0);
});

test('probe reports browser failures and account challenge failures without throwing', async () => {
    statusFailure = Object.assign(new Error('Helper unavailable.'), { code: 'JANNY_HELPER_UNAVAILABLE' });
    assert.deepEqual(await api.probeJannyAccount(), {
        browser: false, active: false, cloudflare: false, reason: 'Helper unavailable.', code: 'JANNY_HELPER_UNAVAILABLE',
    });
    statusFailure = null;
    helperReplies.push({ ok: true, status: 403, body: '<title>Just a moment</title>' });
    const result = await api.probeJannyAccount();
    assert.equal(result.browser, true);
    assert.equal(result.active, false);
    assert.equal(result.cloudflare, true);
    assert.equal(result.code, 'JANNY_CF_BLOCKED');
});

test('MeiliSearch still uses its direct search transport', async () => {
    assert.deepEqual(await api.meiliMultiSearch({ search: 'story' }), { results: [] });
    assert.equal(directFetchCount, 1);
    assert.equal(seenFetchBodies.length, 0);
});

test('form mutation recovers once through the real helper boundary and preserves its form body', async () => {
    const harness = createJannyHelperHarness([
        { status: 401, finalUrl: 'https://jannyai.com/collections/form/add-collection', body: '{}' },
        { status: 200, finalUrl: 'https://jannyai.com/collections/' + collectionId + '_set/edit', body: '' },
    ]);
    const previous = window.apiRequest;
    window.apiRequest = harness.apiRequest;
    try {
        assert.deepEqual(await api.createJannyCollection({ name: 'Set & more' }), {
            success: true, id: collectionId, location: 'https://jannyai.com/collections/' + collectionId + '_set/edit',
        });
        assert.equal(recoveryCalls, 1);
        assert.equal(harness.requests.length, 2);
        assert.deepEqual(harness.requests[1], harness.requests[0]);
        assert.equal(harness.requests[0].init.body, 'name=Set+%26+more&description=&isPrivate=yes');
    } finally { window.apiRequest = previous; }
});

test('form mutation stops after a second helper-boundary 401', async () => {
    const harness = createJannyHelperHarness([
        { status: 401, finalUrl: 'https://jannyai.com/collections/form/delete-collection', body: '{}' },
        { status: 401, finalUrl: 'https://jannyai.com/collections/form/delete-collection', body: '{}' },
    ]);
    const previous = window.apiRequest;
    window.apiRequest = harness.apiRequest;
    try {
        await assert.rejects(api.deleteJannyCollection(collectionId), error => error.code === 'JANNY_LOGIN_REQUIRED' && error.status === 401);
        assert.equal(recoveryCalls, 1);
        assert.equal(harness.requests.length, 2);
    } finally { window.apiRequest = previous; }
});

test('form login redirects and rate limits retain stable errors through the helper boundary', async () => {
    const harness = createJannyHelperHarness([
        { status: 200, finalUrl: 'https://jannyai.com/auth/login?next=%2Fcollections', body: '<html>Sign in</html>' },
        { status: 429, finalUrl: 'https://jannyai.com/collections/form/edit-collection', body: '{}' },
    ]);
    const previous = window.apiRequest;
    window.apiRequest = harness.apiRequest;
    try {
        await assert.rejects(api.updateJannyCollection({ id: collectionId, name: 'Set' }), error => error.code === 'JANNY_LOGIN_REQUIRED');
        await assert.rejects(api.updateJannyCollection({ id: collectionId, name: 'Set' }), error => error.code === 'JANNY_RATE_LIMITED');
        assert.equal(recoveryCalls, 0);
        assert.equal(harness.requests.length, 2);
    } finally { window.apiRequest = previous; }
});
