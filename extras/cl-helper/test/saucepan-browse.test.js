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

test('account controls and followed creator panel are present in rendered surfaces', () => {
    const run = setup();
    assert.match(run('saucepanBrowseView.renderFilterBar()'), /data-saucepan-view="following"/);
    assert.match(run('saucepanBrowseView.renderFilterBar()'), /id="saucepanFilterFavorites"/);
    assert.match(run('saucepanBrowseView.renderView()'), /id="saucepanFollowMgr"/);
    assert.equal(run('saucepanBrowseView.supportsFollowingManager'), true);
    assert.doesNotMatch(run('saucepanBrowseView.renderModals()'), /Follow creator|saucepanFollowBtn/);
    assert.match(run('saucepanBrowseView.renderModals()'), /id="saucepanHiddenNotice"/);
    assert.match(run('saucepanBrowseView.renderView()'), /id="saucepanTimelineSection"/);
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

function element() {
    const classes = new Set();
    return { innerHTML: '', disabled: false, dataset: {}, style: {},
        classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)),
            toggle: (x, enabled) => enabled ? classes.add(x) : classes.delete(x), contains: x => classes.has(x) },
        querySelector: () => null };
}

test('Browse and Following show separate sections, and a creator opens Browse', () => {
    const elements = Object.fromEntries(['saucepanBrowseSection', 'saucepanTimelineSection', 'saucepanModeBrowse', 'saucepanModeFollowing'].map(id => [id, element()]));
    const run = setup({ document: { getElementById: id => elements[id] } });
    run("saucepanAccountView = 'recent'; syncSaucepanModeControls();");
    assert.equal(elements.saucepanTimelineSection.classList.contains('hidden'), true);
    run("saucepanAccountView = 'following'; syncSaucepanModeControls();");
    assert.equal(elements.saucepanBrowseSection.classList.contains('hidden'), true);
    assert.equal(elements.saucepanTimelineSection.classList.contains('hidden'), false);
    run("saucepanBrowseMode = 'creator'; syncSaucepanModeControls();");
    assert.equal(elements.saucepanBrowseSection.classList.contains('hidden'), false);
    assert.equal(elements.saucepanTimelineSection.classList.contains('hidden'), true);
});

test('eligible hidden cards keep Import available and use the compact extraction notice', () => {
    const elements = Object.fromEntries(['saucepanHiddenNotice', 'saucepanImportBtn', 'saucepanCharDescriptionSection'].map(id => [id, element()]));
    const run = setup({ document: { getElementById: id => elements[id] }, formatNumber: String });
    run("saucepanBrowseView.isCharPossibleMatch = () => false; renderHiddenCaptureCTA({name: 'Card', totalTokens: 1000}, 'Card');");
    assert.equal(elements.saucepanImportBtn.disabled, false);
    assert.match(elements.saucepanImportBtn.innerHTML, /Import/);
    assert.match(elements.saucepanHiddenNotice.innerHTML, /Importing extracts it first/);
    assert.match(elements.saucepanHiddenNotice.innerHTML, /Extract now/);
    assert.doesNotMatch(elements.saucepanHiddenNotice.innerHTML, /Cloudflare|temporary|published/);
    assert.equal(elements.saucepanCharDescriptionSection.style.display, 'none');
});

function extractionSetup(fetchCard) {
    const elements = Object.fromEntries(['saucepanHiddenNotice', 'saucepanImportBtn', 'saucepanHiddenCaptureBtn', 'saucepanCharDescriptionSection'].map(id => [id, element()]));
    const imports = [], notices = [];
    const run = setup({
        document: { getElementById: id => elements[id] }, formatNumber: String,
        fetchSaucepanV2Card: fetchCard, finishBrowseImport: async () => {},
        CoreAPI: { getSetting: () => '', escapeHtml: String, showToast: message => notices.push(message),
            checkCharacterForDuplicatesAsync: async () => [],
            getProvider: () => ({ importCharacter: async (id, hit, options) => {
                imports.push({ id, options }); return { success: true };
            } }),
        },
    });
    run("saucepanBrowseView.isCharPossibleMatch = () => false; saucepanSelectedChar = {character_id: 'card', name: 'Card', _needsHiddenCapture: true}; paintSaucepanV2Card = (hit, card) => { hit._v2Card = card; };");
    return { run, elements, imports, notices };
}

test('Import waits for an in-flight preview extraction and reuses that card exactly once', async () => {
    let resolve, calls = 0;
    const { run, imports } = extractionSetup((_hit, options) => {
        calls++;
        assert.equal(options.allowHiddenCapture, true);
        return new Promise(done => { resolve = done; });
    });
    const preview = run('recoverSaucepanDefinition(saucepanSelectedChar);');
    const importing = run('importSaucepanCharacter(saucepanSelectedChar);');
    assert.equal(imports.length, 0);
    const card = { data: { name: 'Card', description: 'Recovered definition' } };
    resolve(card);
    await Promise.all([preview, importing]);
    assert.equal(calls, 1);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].options.prebuiltCard, card);
});

test('failed extraction restores Import and Extract now instead of an incomplete import', async () => {
    const { run, elements, imports, notices } = extractionSetup(async () => { throw new Error('Connection failed'); });
    await run('importSaucepanCharacter(saucepanSelectedChar);');
    assert.equal(imports.length, 0);
    assert.equal(elements.saucepanImportBtn.disabled, false);
    assert.match(elements.saucepanImportBtn.innerHTML, /Import/);
    assert.match(elements.saucepanHiddenNotice.innerHTML, /Extract now/);
    assert.match(notices[0], /Connection failed/);
    assert.equal(run('saucepanSelectedChar._hiddenCapturePromise'), undefined);
});

test('switching accounts during extraction prevents import and stale preview updates', async () => {
    let resolve;
    const { run, imports } = extractionSetup(() => new Promise(done => { resolve = done; }));
    const pending = run('importSaucepanCharacter(saucepanSelectedChar);');
    run('saucepanAccountRevision++;');
    resolve({ data: { description: 'Old account result' } });
    await pending;
    assert.equal(imports.length, 0);
    assert.equal(run('saucepanSelectedChar._v2Card'), undefined);
});
