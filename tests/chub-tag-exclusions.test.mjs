import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import test from 'node:test';

// Only tag metadata from the reported card; no character definition or images.
const fullTopics = ['Smut', 'NSFW', 'Comedy', 'Cute', 'Magic', 'thick thighs',
    'Multiple Greetings', 'sexy', 'Breeding Kink', 'Tomboy', 'coomgems', 'English',
    'Romance', 'Dickgirl', 'Pregnant', 'Submissive', 'OC', 'Female', 'Human',
    'Incest', 'Roleplay', 'Impregnation', 'Original Character', 'Pregnancy',
    'Futanari', 'childhood friend', 'Any POV'];
const truncatedCard = { id: 7684262, fullPath: 'RelicGuy/your-best-friend-becomes-a-futa-bd6241f18e49', topics: fullTopics.slice(0, 15) };
const allowedCard = { id: 42, fullPath: 'author/allowed', topics: ['Adventure'] };

// Run the actual browse loader with browser/network boundaries replaced. The loader's
// filtering, pagination, cache and cancellation remain production code.
async function browseHarness({ excludes = ['futanari'], pages = [[truncatedCard, allowedCard]], metadata,
    favorites = false, failDirectMetadata = false, sessionExcludes = [] } = {}) {
    const requests = [];
    const notices = [];
    const loadMore = [];
    const context = createContext({
        URL, URLSearchParams, AbortController, AbortSignal, DOMException, setTimeout, clearTimeout,
        console, window: {}, document: {
            getElementById: () => null,
            querySelectorAll: () => [],
            querySelector: () => null,
        },
        fetch: async (url, options) => {
            requests.push(String(url));
            const isProxy = String(url).startsWith('/proxy/');
            const effectiveUrl = isProxy ? decodeURIComponent(String(url).slice('/proxy/'.length)) : String(url);
            const parsed = new URL(effectiveUrl);
            if (parsed.pathname.startsWith('/api/characters/')) {
                if (failDirectMetadata && !isProxy) throw new TypeError('Failed to fetch');
                const topics = metadata ? await metadata(parsed, options) : fullTopics;
                return { ok: true, json: async () => ({ node: { topics } }) };
            }
            const page = Number(parsed.searchParams.get('page') || 1);
            const nodes = structuredClone(pages[page - 1] || []);
            const result = { nodes, cursor: page < pages.length ? page + 1 : null };
            return { ok: true, json: async () => favorites ? result : { data: result } };
        },
    });
    const noop = () => {};
    const core = { getProviderExcludeTags: () => excludes, debugLog: noop,
        showToast: (...args) => notices.push(args), renderSkeletonGrid: noop };
    class BrowseView {
        updateLoadMoreVisibility(...args) { loadMore.push(args); }
        deactivate() {}
        disconnectImageObserver() {}
    }
    const dependencies = {
        '../browse-view.js': { BrowseView },
        '../../core-api.js': { default: core },
        '../provider-utils.js': {
            IMG_PLACEHOLDER: '', formatNumber: String, BROWSE_PURIFY_CONFIG: {},
            skeletonLines: noop, deferRender: noop, deferCall: noop, isMobileMode: () => false,
            finishBrowseImport: noop, proxyEncode: encodeURIComponent,
            readJsonClassified: response => response.json(), renderBrowseError: (...args) => notices.push(args),
        },
        './chub-api.js': {
            CHUB_API_BASE: 'https://api.chub.ai', CHUB_GATEWAY_BASE: 'https://gateway.chub.ai',
            CHUB_AVATAR_BASE: '', getChubHeaders: () => ({}),
            extractNodes: data => data.nodes || data.data?.nodes || [],
        },
    };
    const sourceUrl = new URL('../modules/providers/chub/chub-browse.js', import.meta.url);
    const source = await readFile(sourceUrl, 'utf8');
    const module = new SourceTextModule(source + `
        chubDelegatesInitialized = true;
        chubNsfwEnabled = true;
        chubTagFilters = new Map(${JSON.stringify(sessionExcludes.map(tag => [tag, 'exclude']))});
        chubFilterFavorites = ${favorites};
        chubToken = ${favorites ? "'test-token'" : 'null'};
        updateChubAiRatingFieldState = () => {};
        extractChubTagsFromResults = () => {};
        renderChubGrid = () => {};
        renderChubTimeline = () => {};
        chubTimelineCharacters = [${JSON.stringify(allowedCard)}];
        export const harness = {
            load: loadChubCharacters,
            deactivate: () => chubBrowseView.deactivate(),
            switchMode: switchChubViewMode,
            next: () => { chubCurrentPage++; return loadChubCharacters(); },
            get ids() { return chubCharacters.map(c => c.id); },
            get hasMore() { return Boolean(chubHasMore); },
        };
    `, { context, identifier: sourceUrl.href });
    await module.link(async (specifier, referrer) => {
        const values = dependencies[specifier];
        if (values) return new SyntheticModule(Object.keys(values), function () {
            for (const [key, value] of Object.entries(values)) this.setExport(key, value);
        }, { context });
        const url = new URL(specifier, referrer.identifier);
        return new SourceTextModule(await readFile(url, 'utf8'), { context, identifier: url.href });
    });
    await module.evaluate();
    return { api: module.namespace.harness, requests, notices, loadMore, excludes };
}

for (const tag of ['futanari', 'Incest']) {
    test(`browse excludes ${tag} beyond search's first 15 topics`, async () => {
        const { api } = await browseHarness({ excludes: [tag] });
        await api.load();
        assert.deepEqual([...api.ids], [42]);
    });
}

test('session tag exclusions use the same full-topic check', async () => {
    const { api } = await browseHarness({ excludes: [], sessionExcludes: ['Futanari'] });
    await api.load();
    assert.deepEqual([...api.ids], [42]);
});

test('browsing without exclusions does not request full metadata', async () => {
    const { api, requests } = await browseHarness({ excludes: [] });
    await api.load();
    assert.deepEqual([...api.ids], [7684262, 42]);
    assert.equal(requests.length, 1);
});

test('browse continues through a fully excluded page', async () => {
    const { api } = await browseHarness({ pages: [[truncatedCard], [allowedCard]] });
    await api.load();
    assert.deepEqual([...api.ids], [42]);
    assert.equal(api.hasMore, false);
});

test('favorites retains Load More when exclusions hide the whole page', async () => {
    const { api, loadMore } = await browseHarness({ favorites: true,
        pages: [[{ ...truncatedCard, topics: fullTopics }], [allowedCard]] });
    await api.load();
    assert.deepEqual([...api.ids], []);
    assert.equal(api.hasMore, true);
    assert.deepEqual(loadMore.at(-1), ['chubLoadMore', true, true]);
    await api.next();
    assert.deepEqual([...api.ids], [42]);
});

test('an unverifiable card stays hidden and reports the failure', async () => {
    const { api, notices } = await browseHarness({ metadata: async () => { throw new Error('offline'); } });
    await api.load();
    assert.deepEqual([...api.ids], [42]);
    assert.ok(notices.length > 0);
});

test('full-tag verification falls back to the SillyTavern proxy after a direct CORS failure', async () => {
    const { api, requests } = await browseHarness({ failDirectMetadata: true });
    await api.load();
    assert.deepEqual([...api.ids], [42]);
    assert.ok(requests.some(url => url.startsWith('/proxy/')));
});

test('cached full tags are checked again when the exclusion list changes', async () => {
    const { api, excludes, requests } = await browseHarness({ excludes: ['unrelated'] });
    await api.load();
    assert.deepEqual([...api.ids], [7684262, 42]);
    excludes.splice(0, 1, 'futanari');
    await api.load();
    assert.deepEqual([...api.ids], [42]);
    assert.equal(requests.filter(url => url.includes('/api/characters/')).length, 1);
});

test('switching to Following cancels an active full-tag verification load', async () => {
    let aborted = false;
    const { api } = await browseHarness({
        metadata: async (_url, { signal }) => {
            signal.addEventListener('abort', () => { aborted = true; }, { once: true });
            await new Promise(resolve => setTimeout(resolve, 20));
            return fullTopics;
        },
    });
    const loading = api.load();
    await new Promise(resolve => setTimeout(resolve, 0));
    await api.switchMode('timeline');
    await loading;
    assert.equal(aborted, true);
});
