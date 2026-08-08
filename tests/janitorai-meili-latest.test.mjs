import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
    JANITORAI_MEILI_SORT,
    buildJanitoraiMeiliRequest,
    normalizeJanitoraiMeiliHit,
    normalizeJanitoraiMeiliPage,
} from '../modules/providers/janitorai/janitorai-meili-latest.js';

globalThis.window ??= {};
await import('../modules/providers/janitor-session.js');
const { fetchJanitoraiMeiliLatest } = await import('../modules/providers/janitorai/janitorai-api.js');

test('builds newest-only Meili request with SFW and numeric include tags', () => {
    assert.equal(JANITORAI_MEILI_SORT, 'meili_latest');
    assert.deepEqual(buildJanitoraiMeiliRequest({
        search: 'witch', page: 3, limit: 80, nsfwEnabled: false, includeTagIds: [2, 5],
    }), {
        search: 'witch',
        page: 3,
        limit: 80,
        filters: ['isNsfw = false', 'tagIds = 2 AND tagIds = 5'],
        facets: ['isNsfw', 'tagIds'],
        sort: ['createdAtStamp:desc'],
        highlight: true,
    });
});

test('omits the SFW clause when NSFW is enabled', () => {
    const request = buildJanitoraiMeiliRequest({ nsfwEnabled: true });
    assert.deepEqual(request.sort, ['createdAtStamp:desc']);
    assert.equal(request.filters.includes('isNsfw = false'), false);
});

const deps = {
    imageBase: 'https://image.jannyai.com/bot-avatars/',
    resolveTagNames: ids => ids.map(id => ({ 2: 'Female', 5: 'OC' })[id] || `Tag ${id}`),
};

test('normalizes a Janny hit for Janitor-native preview and import', () => {
    assert.deepEqual(normalizeJanitoraiMeiliHit({
        id: 'ABC',
        name: 'Mage',
        avatar: 'mage.webp',
        description: 'Notes',
        creatorUsername: 'author',
        creatorId: 'creator-id',
        tagIds: [2, 5],
        createdAtStamp: 1_700_000_000,
        isNsfw: true,
        totalToken: 1234,
    }, deps), {
        character_id: 'ABC',
        name: 'Mage',
        avatar: 'https://image.jannyai.com/bot-avatars/mage.webp',
        description: 'Notes',
        creator_name: 'author',
        creator_id: 'creator-id',
        tags: [{ id: 2, name: 'Female', slug: 'female' }, { id: 5, name: 'OC', slug: 'oc' }],
        created_at: new Date(1_700_000_000 * 1000).toISOString(),
        is_nsfw: true,
        total_tokens: 1234,
        chat_count: 0,
        message_count: 0,
        _listingSource: 'meili',
    });
});

test('uses Meili totalPages and filters excluded numeric tags client-side', () => {
    const response = { results: [{ page: 2, totalPages: 4, hits: [
        { id: 'keep', name: 'Keep', tagIds: [2] },
        { id: 'drop', name: 'Drop', tagIds: [5] },
    ] }] };
    const page = normalizeJanitoraiMeiliPage(response, { ...deps, excludeTagIds: [5] });
    assert.deepEqual(page.characters.map(hit => hit.character_id), ['keep']);
    assert.equal(page.page, 2);
    assert.equal(page.totalPages, 4);
    assert.equal(page.hasMore, true);
});

test('aborts the Meili listing transport without falling through to the proxy', async (t) => {
    const previousFetch = globalThis.fetch;
    const previousWarn = console.warn;
    const controller = new AbortController();
    let searchCalls = 0;
    let markSearchStarted;
    const searchStarted = new Promise(resolve => { markSearchStarted = resolve; });
    t.after(() => {
        globalThis.fetch = previousFetch;
        console.warn = previousWarn;
    });
    console.warn = () => {};
    globalThis.fetch = async (url, init = {}) => {
        if (String(url).includes('/characters/search')) return new Response('', { status: 200 });
        searchCalls++;
        markSearchStarted();
        assert.equal(init.signal, controller.signal);
        return new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
    };

    const pending = fetchJanitoraiMeiliLatest({ signal: controller.signal });
    await searchStarted;
    controller.abort();

    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(searchCalls, 1);
});

test('Janitor sort markup labels the single Meili option Experimental', async () => {
    const source = await readFile(new URL('../modules/providers/janitorai/janitorai-browse.js', import.meta.url), 'utf8');
    assert.match(source, /<optgroup label="Experimental">[\s\S]*meili_latest[\s\S]*Latest \(Meili\)[\s\S]*<\/optgroup>/);
});

test('persisted validation accepts Meili and retains popular fallback', async () => {
    const source = await readFile(new URL('../modules/providers/janitorai/janitorai-browse.js', import.meta.url), 'utf8');
    assert.match(source, /JANITORAI_SORTS/);
    assert.match(source, /'popular'/);
});

test('provider settings advertise Meili Latest as a persistable browse default', async () => {
    const source = await readFile(new URL('../modules/providers/janitorai/janitorai-browse.js', import.meta.url), 'utf8');
    assert.match(source, /browseSortOptions:\s*\[[\s\S]*?\{\s*value:\s*'meili_latest',\s*label:\s*'Latest \(Meili\)'\s*\}/);
});
