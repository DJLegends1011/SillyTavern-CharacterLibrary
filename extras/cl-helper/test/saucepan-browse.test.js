import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../../../modules/providers/saucepan/saucepan-browse.js', import.meta.url), 'utf8'))
    .replace(/^import [\s\S]*? from '[^']+';\r?\n/gm, '')
    .replace('export default saucepanBrowseView;', '');
function setup(extra = {}) {
    const context = vm.createContext({
        BrowseView: class {
            deactivate() {} disconnectImageObserver() {} closeFollowingManager() {}
            renderFollowingManagerPanel() { return '<div id="saucepanFollowMgr"></div>'; }
        },
        CoreAPI: { getSetting: () => '', escapeHtml: x => String(x) },
        window: { addEventListener() {} }, document: { getElementById: () => null },
        ...extra,
    });
    vm.runInContext(source, context);
    return expression => vm.runInContext(expression, context);
}

test('leaving mid-pagination permits a fresh load when returning', () => {
    const run = setup();
    run("saucepanCharacters = [{id: 'old'}]; saucepanIsLoading = true; saucepanCurrentPage = 3; saucepanBrowseView.deactivate();");
    assert.equal(run('saucepanIsLoading'), false);
    assert.equal(run('saucepanCharacters.length'), 0);
    assert.equal(run('saucepanCurrentPage'), 1);
});

test('an older followed-creator request cannot update a newly selected preview', async () => {
    let resolve;
    const favorite = { classList: { toggle() {} }, setAttribute() {} }, follow = { classList: { toggle() {} }, setAttribute() {} };
    const run = setup({
        hasSaucepanToken: () => true,
        fetchSaucepanFollowedCreators: () => new Promise(done => { resolve = done; }),
        document: { getElementById: id => id === 'saucepanFavoriteBtn' ? favorite : follow },
    });
    const pending = run("saucepanSelectedChar = {creator_id: 'old', is_favorited: false}; updateSaucepanAccountControls(saucepanSelectedChar, null);");
    run("saucepanSelectedChar = {creator_id: 'new'};");
    resolve([{ id: 'old' }]);
    await pending;
    assert.equal(follow.disabled, true);
    assert.equal(run('saucepanFollowedCreators'), null);
});

test('account controls and followed creator panel are present in rendered surfaces', () => {
    const run = setup();
    assert.match(run('saucepanBrowseView.renderFilterBar()'), /data-saucepan-view="following"/);
    assert.match(run('saucepanBrowseView.renderFilterBar()'), /id="saucepanFilterFavorites"/);
    assert.match(run('saucepanBrowseView.renderView()'), /id="saucepanFollowMgr"/);
    assert.equal(run('saucepanBrowseView.supportsFollowingManager'), true);
    assert.match(run('saucepanBrowseView.renderModals()'), /id="saucepanFollowBtn"/);
});

test('manager results from a previous account are discarded', async () => {
    let resolve;
    const run = setup({ fetchSaucepanFollowedCreators: () => new Promise(done => { resolve = done; }) });
    const pending = run('saucepanBrowseView._mgrCreators = []; saucepanBrowseView._loadManagerCreators();');
    run('saucepanAccountRevision++;');
    resolve([{ id: 'old-account', handle: 'old' }]);
    await pending;
    assert.equal(run('saucepanBrowseView._mgrCreators.length'), 0);
});

test('a delayed manager refresh cannot overwrite a newer refresh', async () => {
    const resolves = [];
    const run = setup({ fetchSaucepanFollowedCreators: () => new Promise(done => resolves.push(done)) });
    const old = run('saucepanBrowseView._loadManagerCreators();');
    const current = run('saucepanBrowseView._loadManagerCreators();');
    resolves[1]([{ id: 'current', handle: 'Current' }]);
    await current;
    resolves[0]([{ id: 'old', handle: 'Old' }]);
    await old;
    assert.equal(run('saucepanBrowseView._mgrCreators[0].id'), 'current');
});

test('an account change during creator lookup prevents a follow on the new account', async () => {
    let resolve;
    let writes = 0;
    const run = setup({
        resolveSaucepanCreator: () => new Promise(done => { resolve = done; }),
        setSaucepanFollowing: () => { writes++; },
    });
    const pending = run("saucepanBrowseView.followCreator('Creator');");
    run('saucepanAccountRevision++;');
    resolve({ id: 'creator', name: 'Creator' });
    assert.equal(await pending, null);
    assert.equal(writes, 0);
});

test('old creator requests cannot repopulate the account cache after invalidation', async () => {
    let resolve;
    const run = setup({
        fetchSaucepanCompanionsOfUser: () => new Promise(done => { resolve = done; }),
        console,
    });
    const pending = run("delegatesInitialized = true; saucepanBrowseMode = 'creator'; saucepanCreatorHandle = 'creator'; loadCharacters(false);");
    run('saucepanLoadToken++; _saucepanCreatorFullList = [];');
    resolve({ characters: [{ id: 'stale', is_favorited: true }] });
    await pending;
    assert.equal(run('_saucepanCreatorFullList.length'), 0);
});
