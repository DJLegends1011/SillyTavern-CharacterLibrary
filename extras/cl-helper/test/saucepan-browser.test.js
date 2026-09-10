import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { validateSaucepanBrowserRequest, saucepanBrowserFetch } from '../saucepan-browser.js';

const id = '5b120a10-d0cd-4960-b5af-5354da7c5f9b';
test('account routes allow exact favorite and follow writes only', () => {
    for (const method of ['POST', 'DELETE']) {
        assert.deepEqual(validateSaucepanBrowserRequest({ method, path: '/api/v1/companions/favorite', body: { companion_id: id, injected: true } }).body, { companion_id: id });
        assert.deepEqual(validateSaucepanBrowserRequest({ method, path: '/api/v1/users/follow', body: { user_id: id } }).body, { user_id: id });
    }
    for (const path of ['https://evil.test/api/v1/search', '//evil.test/api/v1/search', '/api/v1/users/follow/../delete', '/api/v1/users/follow?x=1']) {
        assert.throws(() => validateSaucepanBrowserRequest({ method: 'DELETE', path, body: { user_id: id } }));
    }
    assert.throws(() => validateSaucepanBrowserRequest({ method: 'DELETE', path: '/api/v1/users/follow', body: { user_id: 'bad' } }));
    assert.throws(() => validateSaucepanBrowserRequest({ method: 'POST', path: '/api/v1/users/followed' }));
});

test('browser fetch uses the Saucepan origin and explicit session, preserves HTTP failures', async () => {
    let sent;
    const page = { evaluate: expression => vm.runInNewContext(expression, {
        location: { origin: 'https://saucepan.ai' }, AbortSignal,
        fetch: async (path, init) => { sent = { path, init }; return new Response('{"error":"expired"}', { status: 401 }); },
    }) };
    const out = await saucepanBrowserFetch(page, { method: 'GET', path: '/api/v1/users/followed' }, 'secret');
    assert.equal(out.status, 401);
    assert.equal(sent.init.headers.Authorization, 'Bearer secret');
    assert.equal(sent.init.credentials, 'same-origin');
    assert.equal(sent.init.redirect, 'error');
    assert.equal(sent.path, '/api/v1/users/followed');
});

test('a navigated browser page cannot receive the Saucepan token', async () => {
    const page = { evaluate: expression => vm.runInNewContext(expression, { location: { origin: 'https://evil.test' } }) };
    await assert.rejects(saucepanBrowserFetch(page, { method: 'GET', path: '/api/v1/users/followed' }, 'secret'), /origin/);
});
