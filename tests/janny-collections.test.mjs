// JannyAI collections controller (modules/providers/janny/janny-collections.js), run for
// real against a minimal DOM and a fake host. Needs the browser-global shim:
//   node --import ./tests/setup-browser-globals.mjs --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createJannyCollections } from '../modules/providers/janny/janny-collections.js';
import {
    normalizeJannyCharacter,
    collectionCount,
    collectionCoverSources,
    isCollectionPrivate,
    parseJannyCharacterId,
} from '../modules/providers/janny/janny-collection-model.js';

const source = readFileSync(new URL('../modules/providers/janny/janny-collections.js', import.meta.url), 'utf8');

const REJECTED = ['JANNY_LOGIN_REQUIRED', 'JANNY_TOKEN_EXPIRED', 'JANNY_TOKEN_REJECTED'];
const CHAR_ID = '11111111-1111-4111-8111-111111111111';
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const failure = (code, extra = {}) => Object.assign(new Error('Synthetic transport error'), { code }, extra);
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fakeElement(id) {
    const classes = new Set();
    return {
        id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, dataset: {}, attributes: {},
        classList: {
            add: (...names) => names.forEach(n => classes.add(n)),
            remove: (...names) => names.forEach(n => classes.delete(n)),
            contains: n => classes.has(n),
            toggle: (n, force = !classes.has(n)) => (force ? classes.add(n) : classes.delete(n), force),
        },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        querySelector: () => null,
        querySelectorAll: () => [],
        insertAdjacentHTML(_position, html) { this.innerHTML += html; },
        addEventListener() {},
        focus() {},
        contains: () => true,
    };
}

const SECTION_IDS = [
    'jannyBrowseSection', 'jannyCollectionsDirectory', 'jannyCollectionsHeader',
    'jannyCollectionsTabs', 'jannyCollectionsPublicBtn', 'jannyCollectionsMineBtn', 'jannyCollectionsPublicTools',
    'jannyCollectionsOwnedTools', 'jannyCollectionsCreateForm', 'jannyCollectionsGrid', 'jannyCollectionsLoadMore',
    'jannyCollectionsLoadMoreBtn', 'jannyCollectionDetail', 'jannyCollectionDetailBanner', 'jannyCollectionEditor',
    'jannyCollectionDetailDescription', 'jannyCollectionCharGrid', 'jannyCollectionDropdown', 'jannyCollectionDropdownBtn',
    'jannyPublicCollectionsSort', 'jannyNewCollectionName', 'jannyNewCollectionDescription', 'jannyNewCollectionPrivate',
    'jannyCreateCollectionError', 'jannyCreateCollectionBtn', 'jannyEditCollectionName', 'jannyEditCollectionDescription',
    'jannyEditCollectionPrivate', 'jannyEditCollectionSaveBtn', 'jannyEditAddCharacterInput',
];

const OWNED = () => [{ id: 'col-1', name: 'Old private collection', characterCount: 1, isPrivate: true }];

function setup({ api = {}, host = {}, selected = { id: 'old-character', name: 'Old character' } } = {}) {
    const elements = new Map();
    const el = (id) => {
        if (!elements.has(id)) elements.set(id, fakeElement(id));
        return elements.get(id);
    };
    for (const id of SECTION_IDS) el(id);
    el('jannyCollectionsSection').classList.add('hidden');

    const toasts = [];
    const skeletons = [];
    const observed = [];
    const previews = [];
    globalThis.document = { getElementById: id => elements.get(id) || null, addEventListener() {} };
    Object.assign(globalThis.window, {
        escapeHtml: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        showToast: (...args) => toasts.push(args),
        renderSkeletonGrid: (container) => { skeletons.push(container.id); container.innerHTML = '<div class="cl-skeleton-card"></div>'; },
        showConfirm: async () => true,
        getSetting: () => undefined,
        debugLog() {},
        initCustomSelect() {},
        pushOverlayGuard() {},
        registerOverlay() {},
    });

    const state = { generation: 0, active: true, selected };
    let ctrl;
    const fullApi = {
        fetchCollections: async () => OWNED(),
        fetchCollectionCharacters: async () => [{ characterId: 'old-character' }],
        fetchPublicCollections: async () => ({ collections: [], hasMore: false }),
        fetchPublicCollection: async () => ({ collection: {}, characterIds: [] }),
        fetchCollectorCollections: async () => ({ collections: [] }),
        fetchCharactersByIds: async ids => ids.map(id => ({ id, name: `Card ${id}`, avatar: `/${id}.webp` })),
        fetchPublicCharactersByIds: async ids => ids.map(id => ({ id, name: `Card ${id}`, avatar: `/${id}.webp` })),
        createCollection: async () => ({ success: true, id: null }),
        updateCollection: async () => ({ success: true }),
        deleteCollection: async () => ({ success: true }),
        addCharacterToCollection: async () => ({}),
        removeCharacterFromCollection: async () => ({}),
        // Fail closed unless a test installs a session: a 401 is a real rejection
        sessionStatus: async () => ({ active: false }),
        ...api,
    };
    ctrl = createJannyCollections({
        api: fullApi,
        siteBase: 'https://jannyai.com',
        getView: () => ({ observeImages: grid => observed.push(grid.id) }),
        getGeneration: () => state.generation,
        isAccountActive: () => state.active,
        ensureAccountReady: async () => state.active,
        // Mirrors janny-browse: a definitive login rejection bumps the generation and invalidates
        handleAccountFailure: (err, generation) => {
            if (generation !== state.generation || !REJECTED.includes(err?.code)) return;
            state.generation++;
            state.active = false;
            ctrl.invalidate();
        },
        describeError: err => (err?.code === 'JANNY_CF_BLOCKED' ? 'Cloudflare challenged JannyAI.' : 'The JannyAI request failed.'),
        resolveAvatarUrl: src => src,
        createCard: c => `<div class="browse-card" data-janny-id="${c.id}">${c.name}</div>`,
        getSelectedCharacter: () => state.selected,
        openPreview: c => previews.push(c),
        closePreview() {},
        filterByAuthor() {},
        ...host,
    });
    const d = ctrl._debug;

    /** Seed a loaded owned list the way a finished loadOwned leaves it. */
    async function seedOwned() {
        await d.loadOwned(true);
        await settle();
    }
    /** Replace the account: what janny-browse's invalidateJannyAccountCache does. */
    function swapAccount() {
        state.generation++;
        ctrl.invalidate();
        state.active = true;
    }
    return { ctrl, d, el, elements, toasts, skeletons, observed, previews, state, api: fullApi, seedOwned, swapAccount };
}

// ── Model ────────────────────────────────────────────────────────────

test('normalizeJannyCharacter unwraps relation wrappers and keeps browse-card fields', () => {
    const c = normalizeJannyCharacter({ character: { character: { id: 'x', title: 'T', avatarUrl: 'a.webp', user: { username: 'amy' } } } });
    assert.equal(c.id, 'x');
    assert.equal(c.name, 'T');
    assert.equal(c.avatar, 'a.webp');
    assert.equal(c.creatorUsername, 'amy');
    assert.equal(normalizeJannyCharacter({ name: 'no id' }), null);
});

test('collectionCount distinguishes an unknown count from an empty collection', () => {
    assert.equal(collectionCount({ characterCount: null }), null);
    assert.equal(collectionCount({}), null);
    assert.equal(collectionCount({ characterCount: 0 }), 0);
    assert.equal(collectionCount({ _count: { collectionCharacters: 5 } }), 5);
    assert.equal(collectionCount({ characterCount: 9, collectionCharacters: [{}, {}] }), 2);
});

test('collectionCoverSources dedupes across pools and caps at four', () => {
    const covers = collectionCoverSources({
        images: ['a', 'b', 'a'],
        coverCharacters: [{ avatar: 'c' }],
        characters: [{ character: { image: 'd' } }, { avatar: 'e' }],
    });
    assert.deepEqual(covers, ['c', 'a', 'b', 'd']);
});

test('isCollectionPrivate reads every privacy shape the site has used', () => {
    for (const value of [true, 'yes', 'private', '1', 'TRUE']) assert.equal(isCollectionPrivate({ isPrivate: value }), true);
    for (const value of [false, 'no', '', null, undefined]) assert.equal(isCollectionPrivate({ isPrivate: value }), false);
    assert.equal(isCollectionPrivate({ private: true }), true);
});

test('parseJannyCharacterId accepts character URLs and bare ids only', () => {
    assert.equal(parseJannyCharacterId(`https://jannyai.com/characters/${CHAR_ID}_character-bob`), CHAR_ID);
    assert.equal(parseJannyCharacterId(`  ${CHAR_ID} `), CHAR_ID);
    assert.equal(parseJannyCharacterId('https://jannyai.com/collections/abc'), '');
    assert.equal(parseJannyCharacterId('bob'), '');
});

// ── Shimmer contract ─────────────────────────────────────────────────

test('opening collections paints skeleton cards, then shared collection cards on the image loader', async () => {
    const page = deferred();
    const t = setup({ api: { fetchPublicCollections: () => page.promise } });
    t.ctrl.setOpen(true);
    assert.deepEqual(t.skeletons, ['jannyCollectionsGrid']);
    assert.doesNotMatch(t.el('jannyCollectionsGrid').innerHTML, /fa-spin|Loading/);

    page.resolve({ collections: [{ id: 'c1', path: '/collections/c1_cozy', name: 'Cozy', characterCount: 3, ownerName: 'amy', viewCount: 12, images: ['https://img/1.webp'] }], hasMore: false });
    await settle();
    const html = t.el('jannyCollectionsGrid').innerHTML;
    assert.match(html, /class="browse-collection-card" data-collection-id="\/collections\/c1_cozy"/);
    assert.match(html, /browse-collection-tile browse-card-image"><img data-src="https:\/\/img\/1\.webp"/);
    assert.match(html, /by amy · 12 views/);
    assert.doesNotMatch(html, /loading="lazy"/);
    assert.ok(t.observed.includes('jannyCollectionsGrid'), 'covers never reached the image loader');
});

test('collections never use native lazy loading and every grid is reconnectable', () => {
    assert.doesNotMatch(source, /loading="lazy"/);
    const t = setup();
    assert.deepEqual(t.ctrl.gridIds, ['jannyCollectionsGrid', 'jannyCollectionCharGrid']);
});

test('a collection opens with skeleton cards, then its characters', async () => {
    const detail = deferred();
    const t = setup({
        api: {
            fetchPublicCollections: async () => ({ collections: [{ id: 'c1', path: '/collections/c1', name: 'Cozy', ownerName: 'amy' }], hasMore: false }),
            fetchPublicCollection: () => detail.promise,
        },
    });
    t.ctrl.setOpen(true);
    await settle();
    t.d.openFromDirectory('/collections/c1');
    assert.equal(t.d.nav.length, 2);
    assert.ok(t.skeletons.includes('jannyCollectionCharGrid'));
    assert.match(t.el('jannyCollectionDetailBanner').innerHTML, /Cozy/);
    detail.resolve({ collection: { name: 'Cozy', ownerName: 'amy' }, characterIds: ['a', 'b'] });
    await settle();
    assert.match(t.el('jannyCollectionCharGrid').innerHTML, /data-janny-id="a"[\s\S]*data-janny-id="b"|data-janny-id="b"[\s\S]*data-janny-id="a"/);
    assert.ok(t.observed.includes('jannyCollectionCharGrid'));
});

test('a public collection opens latest-first using looked-up creation dates', async () => {
    let lookedUp = [];
    const t = setup({
        api: {
            fetchPublicCollections: async () => ({ collections: [{ id: 'c1', path: '/collections/c1', name: 'My own bots' }], hasMore: false }),
            // JannyAI's page shuffles on every load and get-characters carries no dates
            fetchPublicCollection: async () => ({ collection: { name: 'My own bots' }, characterIds: ['alcina', 'kobeni', 'jean'] }),
            fetchPublicCharactersByIds: async () => [{ id: 'alcina', name: 'Alcina' }, { id: 'jean', name: 'Jean Grey' }, { id: 'kobeni', name: 'Kobeni' }],
            fetchCreatedStamps: async chars => {
                lookedUp = chars.map(c => c.id);
                return new Map([['kobeni', 300], ['jean', 200], ['alcina', 100]]);
            },
        },
    });
    t.ctrl.setOpen(true);
    await settle();
    t.d.openFromDirectory('/collections/c1');
    await settle();
    const order = [...t.el('jannyCollectionCharGrid').innerHTML.matchAll(/data-janny-id="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(order, ['kobeni', 'jean', 'alcina']);
    assert.deepEqual(lookedUp.sort(), ['alcina', 'jean', 'kobeni']);
});

test('a failed date lookup still opens the collection', async () => {
    const t = setup({
        api: {
            fetchPublicCollections: async () => ({ collections: [{ id: 'c1', path: '/collections/c1', name: 'One' }], hasMore: false }),
            fetchPublicCollection: async () => ({ collection: {}, characterIds: ['a', 'b'] }),
            fetchCreatedStamps: async () => { throw new Error('search down'); },
        },
    });
    t.ctrl.setOpen(true);
    await settle();
    t.d.openFromDirectory('/collections/c1');
    await settle();
    assert.match(t.el('jannyCollectionCharGrid').innerHTML, /data-janny-id="a"[\s\S]*data-janny-id="b"/);
});

// ── Directory + navigation ───────────────────────────────────────────

test('load more appends the next page instead of repainting the grid', async () => {
    let calls = 0;
    const t = setup({
        api: {
            fetchPublicCollections: async ({ page }) => {
                calls++;
                return page === 1
                    ? { collections: [{ id: 'c1', path: '/collections/c1', name: 'One' }], hasMore: true }
                    : { collections: [{ id: 'c2', path: '/collections/c2', name: 'Two' }], hasMore: true };
            },
        },
    });
    t.ctrl.setOpen(true);
    await settle();
    const grid = t.el('jannyCollectionsGrid');
    grid.innerHTML += '<!-- first page marker -->';
    assert.equal(t.ctrl.canLoadMore(), true);
    t.ctrl.loadMore();
    await settle();
    assert.match(grid.innerHTML, /first page marker[\s\S]*\/collections\/c2/);
    assert.equal(calls, 2);
});

test('a page that adds nothing new ends paging', async () => {
    const same = { collections: [{ id: 'c1', path: '/collections/c1', name: 'One' }], hasMore: true };
    const t = setup({ api: { fetchPublicCollections: async () => same } });
    t.ctrl.setOpen(true);
    await settle();
    t.ctrl.loadMore();
    await settle();
    assert.equal(t.d.pub.hasMore, false);
    assert.equal(t.ctrl.canLoadMore(), false);
});

test('owner link opens the collector view and Back returns to the collection', async () => {
    const t = setup({
        api: {
            fetchPublicCollections: async () => ({ collections: [{ id: 'c1', path: '/collections/c1', name: 'Cozy', ownerName: 'amy' }], hasMore: false }),
            fetchPublicCollection: async () => ({ collection: { name: 'Cozy', ownerName: 'amy' }, characterIds: [] }),
            fetchCollectorCollections: async () => ({ collections: [{ id: 'c9', path: '/collections/c9', name: 'Other' }] }),
        },
    });
    t.ctrl.setOpen(true);
    await settle();
    t.d.openFromDirectory('/collections/c1');
    await settle();
    assert.match(t.el('jannyCollectionDetailBanner').innerHTML, /data-coll-action="collector" data-owner="amy"/);
    assert.doesNotMatch(t.el('jannyCollectionDetailBanner').innerHTML, /data-coll-action="edit"/);
    t.d.push({ kind: 'collector', name: 'amy', items: undefined, loading: false, error: '' });
    await settle();
    assert.match(t.el('jannyCollectionsHeader').innerHTML, /Collections by amy/);
    assert.match(t.el('jannyCollectionsGrid').innerHTML, /\/collections\/c9/);
    t.d.back();
    assert.equal(t.d.nav.at(-1).kind, 'detail');
    t.d.back();
    t.d.back();
    assert.equal(t.el('jannyCollectionsSection').classList.contains('hidden'), true, 'Back at the root returns to browse');
});

test('owned collections: one fetch for concurrent loads, empty state, then a Cloudflare error', async () => {
    const list = deferred();
    let reads = 0;
    const t = setup({ api: { fetchCollections: () => { reads++; return list.promise; } } });
    t.ctrl.setOpen(true);
    t.d.setTab('owned');
    assert.ok(t.skeletons.includes('jannyCollectionsGrid'));
    const again = t.d.loadOwned();
    await settle();
    assert.equal(reads, 1);
    list.resolve([]);
    await again;
    await settle();
    assert.match(t.el('jannyCollectionsGrid').innerHTML, /No collections yet/);
    t.api.fetchCollections = async () => { throw failure('JANNY_CF_BLOCKED'); };
    await t.d.loadOwned(true);
    await settle();
    assert.match(t.el('jannyCollectionsGrid').innerHTML, /Cloudflare/);
    assert.equal(t.d.owned.loading, false);
});

test('owned cards are plain; Edit and Delete live inside the opened collection', async () => {
    const t = setup();
    t.ctrl.setOpen(true);
    t.d.setTab('owned');
    await settle();
    const card = t.el('jannyCollectionsGrid').innerHTML;
    assert.match(card, /data-collection-id="col-1"/);
    assert.doesNotMatch(card, /data-coll-action="(edit|delete)"/);
    t.d.openFromDirectory('col-1');
    await settle();
    const bannerHtml = t.el('jannyCollectionDetailBanner').innerHTML;
    assert.match(bannerHtml, /data-coll-action="edit"/);
    assert.match(bannerHtml, /data-coll-action="delete"/);
    assert.match(bannerHtml, /https:\/\/jannyai\.com\/collections\/col-1/);
});

test('Back while editing leaves edit mode before leaving the collection', async () => {
    const t = setup();
    t.ctrl.setOpen(true);
    t.d.setTab('owned');
    await settle();
    t.d.openFromDirectory('col-1');
    await settle();
    t.d.nav.at(-1).editing = true;
    t.d.back();
    assert.equal(t.d.nav.length, 2);
    assert.equal(t.d.nav.at(-1).editing, false);
});

test('cover hydration fills owned mosaics from members and caches membership', async () => {
    const t = setup({ api: { fetchCollectionCharacters: async () => [{ id: 'old-character', avatar: '/avatar.png', name: 'Character' }] } });
    await t.seedOwned();
    assert.equal(t.d.owned.items[0].coverCharacters[0].avatar, '/avatar.png');
    assert.equal(t.d.members.get('col-1').has('old-character'), true);
});

test('saving an edit renames the owned list entry too', async () => {
    const t = setup();
    t.ctrl.setOpen(true);
    t.d.setTab('owned');
    await settle();
    t.d.openFromDirectory('col-1');
    await settle();
    t.d.nav.at(-1).editing = true;
    t.el('jannyEditCollectionName').value = 'Renamed';
    await t.d.saveEdit();
    assert.equal(t.d.owned.items[0].name, 'Renamed');
    assert.equal(t.d.nav.at(-1).editing, false);
});

// ── Picker ───────────────────────────────────────────────────────────

test('picker shows skeleton rows until membership is known, then checks the member collection', async () => {
    const members = deferred();
    const t = setup({ api: { fetchCollectionCharacters: () => members.promise } });
    const opening = t.ctrl.togglePicker();
    await settle();
    assert.match(t.el('jannyCollectionDropdown').innerHTML, /cl-skeleton-line/);
    members.resolve([{ characterId: 'old-character' }]);
    await opening;
    const menu = t.el('jannyCollectionDropdown').innerHTML;
    assert.match(menu, /janny-collection-picker-row is-member" data-collection-id="col-1"/);
    assert.match(menu, /data-picker-action="new"/);
});

test('membership lookup for a previous selection cannot mark the current character', async () => {
    const members = deferred();
    const t = setup({ api: { fetchCollectionCharacters: () => members.promise } });
    await t.seedOwned();
    t.d.members.clear();
    const pending = t.d.refreshMembership();
    t.state.selected = { id: 'different-character' };
    members.resolve([{ characterId: 'old-character' }]);
    await pending;
    assert.equal(t.d.picker.memberIds.size, 0);
    assert.equal(t.d.picker.checkedFor, '');
});

async function seededPicker(api = {}) {
    const t = setup({ api });
    await t.seedOwned();
    await t.d.refreshMembership();
    return t;
}

test('adding from the picker updates membership, count and toast', async () => {
    const t = await seededPicker({ fetchCollectionCharacters: async () => [] });
    assert.equal(t.d.picker.memberIds.has('col-1'), false);
    await t.d.toggleMembership('col-1');
    assert.equal(t.d.picker.memberIds.has('col-1'), true);
    assert.equal(t.d.owned.items[0].characterCount, 2);
    assert.equal(t.toasts.some(([message, kind]) => kind === 'success' && /Added Old character/.test(message)), true);
});

test('failed collection mutation leaves membership and count unchanged', async () => {
    const t = await seededPicker({ removeCharacterFromCollection: async () => { throw failure('JANNY_CF_BLOCKED'); } });
    await t.d.toggleMembership('col-1');
    assert.equal(t.d.picker.memberIds.has('col-1'), true);
    assert.equal(t.d.owned.items[0].characterCount, 1);
    assert.equal(t.toasts.some(([, kind]) => kind === 'success'), false);
});

test('definitive rejection invalidates without duplicate-add reconciliation', async () => {
    let reads = 0;
    const t = await seededPicker({
        fetchCollectionCharacters: async () => { reads++; return []; },
        addCharacterToCollection: async () => { throw failure('JANNY_LOGIN_REQUIRED', { status: 401 }); },
    });
    reads = 0;
    await t.d.toggleMembership('col-1');
    assert.equal(reads, 0, 'an inactive session must not be reconciled against collection contents');
    assert.equal(t.d.owned.items.length + t.d.picker.memberIds.size + t.d.members.size, 0);
    assert.equal(t.toasts.some(([, kind]) => kind === 'success' || kind === 'info'), false);
});

test('a duplicate add on a still-active session reports membership instead of a login failure', async () => {
    let reads = 0;
    const t = await seededPicker({
        fetchCollectionCharacters: async () => { reads++; return reads > 1 ? [{ characterId: 'old-character' }] : []; },
        addCharacterToCollection: async () => { throw failure('JANNY_LOGIN_REQUIRED', { status: 401 }); },
        sessionStatus: async () => ({ active: true }),
    });
    await t.d.toggleMembership('col-1');
    assert.equal(t.d.owned.items.length, 1, 'the account was invalidated');
    assert.equal(t.d.picker.memberIds.has('col-1'), true);
    assert.equal(t.d.owned.items[0].characterCount, 1, 'duplicate add was counted');
    assert.equal(t.toasts.some(([message, kind]) => kind === 'info' && /already in Old private collection/.test(message)), true);
    assert.equal(t.toasts.some(([, kind]) => kind === 'error'), false);
});

test('in-flight successful mutation cannot alter a replacement account', async () => {
    const removal = deferred();
    const t = await seededPicker({ removeCharacterFromCollection: () => removal.promise });
    const pending = t.d.toggleMembership('col-1');
    await settle();
    t.swapAccount();
    await t.seedOwned();
    await t.d.refreshMembership();
    removal.resolve({});
    await pending;
    assert.equal(t.d.owned.items[0].characterCount, 1);
    assert.equal(t.d.picker.memberIds.has('col-1'), true);
    assert.equal(t.toasts.some(([, kind]) => kind === 'success'), false);
});

// ── Account replacement ──────────────────────────────────────────────

for (const operation of ['loadOwned', 'refreshMembership']) {
    test(`account replacement discards pending ${operation}`, async () => {
        const gate = deferred();
        const t = setup({ api: { fetchCollections: () => gate.promise, fetchCollectionCharacters: () => gate.promise } });
        if (operation === 'refreshMembership') {
            t.api.fetchCollections = async () => OWNED();
            await t.seedOwned();
            t.d.members.clear();
            t.api.fetchCollectionCharacters = () => gate.promise;
        }
        const pending = t.d[operation](true);
        await settle();
        t.swapAccount();
        gate.resolve([{ id: 'col-1', characterId: 'old-character' }]);
        await pending;
        await settle();
        assert.equal(t.d.owned.items.length + t.d.picker.memberIds.size + t.d.members.size, 0);
        assert.equal(t.d.owned.loaded, false);
    });
}

test('invalidation drops owned screens, private DOM and the open picker', async () => {
    const t = setup();
    t.ctrl.setOpen(true);
    t.d.setTab('owned');
    await settle();
    t.d.openFromDirectory('col-1');
    await settle();
    t.el('jannyCollectionDropdown').innerHTML = 'Old private collection';
    t.swapAccount();
    assert.deepEqual(t.d.nav.map(v => v.kind), ['owned']);
    assert.equal(t.el('jannyCollectionCharGrid').innerHTML, '');
    assert.equal(t.el('jannyCollectionDropdown').innerHTML, '');
    assert.match(t.el('jannyCollectionsGrid').innerHTML, /Sign in to see your collections/);
    assert.equal(t.d.owned.items.length + t.d.members.size, 0);
});

async function inOwnedDetail(api) {
    const t = setup({ api });
    t.ctrl.setOpen(true);
    t.d.setTab('owned');
    await settle();
    t.d.openFromDirectory('col-1');
    await settle();
    t.d.nav.at(-1).editing = true;
    t.el('jannyEditCollectionName').value = 'New name';
    t.el('jannyNewCollectionName').value = 'New name';
    t.el('jannyEditAddCharacterInput').value = CHAR_ID;
    return t;
}

for (const [operation, boundary, args] of [
    ['hydrateOwnedCovers', 'fetchCollectionCharacters', []],
    ['saveEdit', 'updateCollection', []],
    ['createFromForm', 'createCollection', []],
    ['removeFromCurrent', 'removeCharacterFromCollection', ['old-character']],
    ['deleteCurrent', 'deleteCollection', []],
    ['addFromInput', 'addCharacterToCollection', []],
]) {
    test(`definitive rejection in ${operation} invalidates all account data`, async () => {
        const t = await inOwnedDetail({});
        if (operation === 'hydrateOwnedCovers') t.d.owned.items[0].coverCharacters = undefined;
        t.api[boundary] = async () => { throw failure('JANNY_TOKEN_REJECTED'); };
        await t.d[operation](...args);
        await settle();
        assert.equal(t.d.owned.items.length + t.d.members.size + t.d.picker.memberIds.size, 0);
        assert.equal(t.d.nav.some(v => v.kind === 'detail'), false);
    });
}

for (const [operation, boundary, args] of [
    ['saveEdit', 'updateCollection', []],
    ['removeFromCurrent', 'removeCharacterFromCollection', ['old-character']],
    ['deleteCurrent', 'deleteCollection', []],
    ['addFromInput', 'addCharacterToCollection', []],
    ['createFromForm', 'createCollection', []],
]) {
    test(`pending ${operation} cannot mutate a replacement account`, async () => {
        const gate = deferred();
        const t = await inOwnedDetail({});
        t.api[boundary] = () => gate.promise;
        const pending = t.d[operation](...args);
        await settle();
        t.swapAccount();
        t.api[boundary] = async () => ({});
        await t.seedOwned();
        gate.resolve({});
        await pending;
        await settle();
        assert.equal(t.d.owned.items.length, 1);
        assert.equal(t.d.owned.items[0].name, 'Old private collection');
        assert.equal(t.d.owned.items[0].characterCount, 1);
        assert.equal(t.toasts.some(([, kind]) => kind === 'success'), false);
    });
}
