import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSaucepanRequest, fetchSaucepanRequest } from '../saucepan-request.js';

const id = '5b120a10-d0cd-4960-b5af-5354da7c5f9b';
test('account routes allow exact favorite and follow writes only', () => {
    for (const method of ['POST', 'DELETE']) {
        assert.deepEqual(validateSaucepanRequest({ method, path: '/api/v1/companions/favorite', body: { companion_id: id, injected: true } }).body, { companion_id: id });
        assert.deepEqual(validateSaucepanRequest({ method, path: '/api/v1/users/follow', body: { user_id: id } }).body, { user_id: id });
    }
    for (const path of ['https://evil.test/api/v1/search', '//evil.test/api/v1/search', '/api/v1/users/follow/../delete', '/api/v1/users/follow?x=1']) {
        assert.throws(() => validateSaucepanRequest({ method: 'DELETE', path, body: { user_id: id } }));
    }
    assert.throws(() => validateSaucepanRequest({ method: 'DELETE', path: '/api/v1/users/follow', body: { user_id: 'bad' } }));
    assert.throws(() => validateSaucepanRequest({ method: 'POST', path: '/api/v1/users/followed' }));
});

test('direct fetch preserves HTTP failures and uses only the Saucepan token', async () => {
    let sent;
    const out = await fetchSaucepanRequest({ method: 'GET', path: '/api/v1/users/followed' }, 'secret', {
        fetchImpl: async (path, init) => { sent = { path, init }; return new Response('{"error":"expired"}', { status: 401 }); },
    });
    assert.equal(out.status, 401);
    assert.equal(sent.init.headers.Authorization, 'Bearer secret');
    assert.ok(sent.init.signal instanceof AbortSignal);
    assert.equal(sent.init.redirect, 'error');
    assert.equal(sent.path, 'https://saucepan.ai/api/v1/users/followed');
});
