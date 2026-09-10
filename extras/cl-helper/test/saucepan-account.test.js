import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The API module's only import is a transport prefix; isolate it from the ST UI.
const source = (await readFile(new URL('../../../modules/providers/saucepan/saucepan-api.js', import.meta.url), 'utf8'))
    .replace(/import \{ CL_HELPER_PLUGIN_BASE \} from '[^']+';/, "const CL_HELPER_PLUGIN_BASE = '/plugins/cl-helper';");
const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('favorites and following search retain pagination and content filters in browser transport', async () => {
    let sent;
    api.setSaucepanBrowserOptionsGetter(() => ({ endpoint: 'http://localhost:9222' }));
    api.setApiRequest(async (url, method, body) => {
        sent = { url, method, body };
        return Response.json({ companions: [{ id: 'one', is_favorited: true }], total_count: 201 });
    });
    for (const accountView of ['favorites', 'following']) {
        const result = await api.searchSaucepan({ accountView, page: 2, limit: 96, nsfw: false, excludedTags: ['gore'] });
        assert.equal(sent.url, '/plugins/cl-helper/saucepan-browser-request');
        assert.equal(sent.body.endpoint, 'http://localhost:9222');
        assert.deepEqual(sent.body.body.special_view, { view: accountView });
        assert.equal(sent.body.body.offset, 96);
        assert.equal(sent.body.body.sus, false);
        assert.deepEqual(sent.body.body.excluded_tags, ['gore']);
        assert.equal(result.totalPages, 3);
        assert.equal(result.characters[0].is_favorited, true);
    }
});

test('favorite/follow removal uses DELETE with exact account identifiers and no retry', async () => {
    const calls = [];
    api.setApiRequest(async (_url, _method, body) => { calls.push(body); return Response.json({}, { status: 403 }); });
    api.setSaucepanTokenGetter(() => 'saved');
    await assert.rejects(api.setSaucepanFavorite('companion', false));
    await assert.rejects(api.setSaucepanFollowing('creator', false));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, { companion_id: 'companion' });
    assert.deepEqual(calls[1].body, { user_id: 'creator' });
    assert.ok(calls.every(call => call.method === 'DELETE'));
});

test('followed creators reject malformed success instead of replacing state with an empty list', async () => {
    api.setApiRequest(async () => Response.json({ changed_schema: [] }));
    await assert.rejects(api.fetchSaucepanFollowedCreators(), /response/);
});
