import test from 'node:test';
import assert from 'node:assert/strict';

const SAMPLE_UUID = '477ec869-957d-40ad-a32a-d992623f5b66';
const OTHER_UUID = 'c5f25770-af64-452d-9983-16676d1f47fe';

async function loadProvider() {
    globalThis.window ||= {};
    globalThis.document ||= {};
    try {
        return (await import('../modules/providers/masquerade/masquerade-provider.js')).default;
    } catch (error) {
        assert.fail(`masquerade-provider.js should be importable: ${error.message}`);
    }
}

async function loadBrowseModule() {
    globalThis.window ||= {};
    globalThis.document ||= {};
    try {
        return await import('../modules/providers/masquerade/masquerade-browse.js');
    } catch (error) {
        assert.fail(`masquerade-browse.js should be importable: ${error.message}`);
    }
}

test('Masquerade provider exposes identity, URL handling, and link metadata', async () => {
    const provider = await loadProvider();
    const card = { data: { extensions: {} } };

    assert.equal(provider.id, 'masquerade');
    assert.equal(provider.name, 'MasqueradeAI');
    assert.equal(provider.supportsImport, true);
    assert.equal(provider.canHandleUrl(`https://www.masqueradeproductions.org/character/${SAMPLE_UUID}`), true);
    assert.equal(provider.canHandleUrl('https://example.test/character/477ec869-957d-40ad-a32a-d992623f5b66'), false);
    assert.equal(provider.parseUrl(`https://www.masqueradeproductions.org/chat/${SAMPLE_UUID}`), SAMPLE_UUID);

    provider.setLinkInfo(card, { id: SAMPLE_UUID, fullPath: SAMPLE_UUID, pageName: 'Kindred' });

    assert.equal(card.data.extensions.masquerade.id, SAMPLE_UUID);
    assert.equal(card.data.extensions.masquerade.pageName, 'Kindred');
    assert.deepEqual(provider.getLinkInfo(card), {
        providerId: 'masquerade',
        id: SAMPLE_UUID,
        fullPath: SAMPLE_UUID,
        linkedAt: card.data.extensions.masquerade.linkedAt,
    });
    assert.match(provider.getCharacterUrl(provider.getLinkInfo(card)), /masqueradeproductions\.org\/character\//);
});

test('Masquerade browse view keeps the copied provider topbar controls', async () => {
    const provider = await loadProvider();
    const html = provider.renderFilterBar();

    assert.match(html, /class="masquerade-view-btn active"/);
    assert.match(html, /data-masquerade-view="following"/);
    assert.match(html, /id="masqueradeSortSelect"/);
    assert.match(html, /id="masqueradeTagsBtn"/);
    assert.match(html, /id="masqueradeFiltersBtn"/);
    assert.match(html, /id="masqueradeNsfwToggle"/);
    assert.match(html, /id="refreshMasqueradeBtn"/);
});

test('Masquerade browse sort controls match the current website controls', async () => {
    const provider = await loadProvider();
    const html = provider.renderFilterBar();

    assert.match(html, /<option value="popular" selected>.*Popular<\/option>/);
    assert.match(html, /<option value="new">.*New<\/option>/);
    assert.match(html, /<option value="amplified">.*Amplified<\/option>/);
    assert.match(html, /<option value="shuffle">.*Shuffle<\/option>/);
    assert.doesNotMatch(html, /<option value="quality">/);
    assert.doesNotMatch(html, /<option value="subscribers">/);
    assert.doesNotMatch(html, /<option value="chatters">/);
});

test('Masquerade preview modal uses the shared browse modal shell', async () => {
    const provider = await loadProvider();
    const html = provider.renderModals();

    assert.match(html, /id="masqueradeCharModal" class="modal-overlay hidden"/);
    assert.match(html, /class="modal-glass browse-char-modal"/);
    assert.match(html, /class="modal-header"/);
    assert.match(html, /class="modal-controls"/);
    assert.doesNotMatch(html, /class="modal hidden browse-char-modal"/);
    assert.doesNotMatch(html, /class="modal-content browse-char-content"/);
});

test('Masquerade preview modal shows website-visible stats only', async () => {
    const provider = await loadProvider();
    const html = provider.renderModals();

    assert.match(html, /id="masqueradeCharMessages"[^>]*>0<\/span> messages/);
    assert.match(html, /id="masqueradeCharUsers"[^>]*>0<\/span> users/);
    assert.match(html, /id="masqueradeCharFans"[^>]*>0<\/span> fans/);
    assert.doesNotMatch(html, /masqueradeCharSaved/);
    assert.doesNotMatch(html, /masqueradeCharQuality/);
    assert.doesNotMatch(html, />\s*saved\s*</);
    assert.doesNotMatch(html, />\s*quality\s*</);
});

test('Masquerade link stats match the website-visible message user and fan counts', async () => {
    const provider = await loadProvider();
    const originalFetchMetadata = provider.fetchMetadata;

    assert.deepEqual(provider.linkStatFields, {
        stat1: { icon: 'fa-solid fa-message', label: 'Messages' },
        stat2: { icon: 'fa-solid fa-users', label: 'Users' },
        stat3: { icon: 'fa-solid fa-heart', label: 'Fans' },
    });

    provider.fetchMetadata = async id => ({
        id,
        total_messages: 12,
        unique_chatters: 3,
        subscriber_count: 4,
        quality_score: 95,
    });
    try {
        assert.deepEqual(await provider.fetchLinkStats({ id: SAMPLE_UUID, fullPath: SAMPLE_UUID }), {
            stat1: 12,
            stat2: 3,
            stat3: 4,
        });
    } finally {
        provider.fetchMetadata = originalFetchMetadata;
        provider.clearCachedLinkNode();
    }
});

test('Masquerade import summary includes provider gallery-only cards', async () => {
    const { buildMasqueradeImportSummary } = await loadBrowseModule();
    assert.equal(typeof buildMasqueradeImportSummary, 'function');

    const summary = buildMasqueradeImportSummary({
        characterName: 'Vicky',
        fileName: 'masquerade_vicky.png',
        avatarUrl: 'https://example.test/vicky.png',
        hasGallery: true,
        providerCharId: SAMPLE_UUID,
        fullPath: SAMPLE_UUID,
        galleryId: 'gallery-123',
        embeddedMediaUrls: [],
        galleryPageUrls: [],
        cardData: { name: 'Vicky' },
    }, { name: 'MasqueradeAI' });

    assert.deepEqual(summary.mediaCharacters, []);
    assert.equal(summary.galleryCharacters.length, 1);
    assert.deepEqual(summary.galleryCharacters[0], {
        name: 'Vicky',
        fullPath: SAMPLE_UUID,
        provider: { name: 'MasqueradeAI' },
        linkInfo: { id: SAMPLE_UUID, fullPath: SAMPLE_UUID },
        url: `https://www.masqueradeproductions.org/character/${SAMPLE_UUID}`,
        avatar: 'masquerade_vicky.png',
        galleryId: 'gallery-123',
    });
});

test('Masquerade preview fetches the requested character instead of reusing stale cache', async () => {
    const provider = await loadProvider();
    const originalFetchMetadata = provider.fetchMetadata;
    provider.clearCachedLinkNode();

    provider.fetchMetadata = async id => ({ id, name: id === SAMPLE_UUID ? 'Kindred' : 'Texas' });
    try {
        const first = await provider.buildPreviewObject(null, { id: SAMPLE_UUID, fullPath: SAMPLE_UUID });
        const second = await provider.buildPreviewObject(null, { id: OTHER_UUID, fullPath: OTHER_UUID });

        assert.equal(first.id, SAMPLE_UUID);
        assert.equal(second.id, OTHER_UUID);
    } finally {
        provider.fetchMetadata = originalFetchMetadata;
        provider.clearCachedLinkNode();
    }
});

test('Masquerade browse import shows summary for gallery-only cards and binds modal listeners once', async () => {
    const provider = await loadProvider();
    const registry = await import('../modules/providers/provider-registry.js');
    const oldDocument = globalThis.document;
    const oldWindow = globalThis.window;
    const oldRequestAnimationFrame = globalThis.requestAnimationFrame;
    const openPreview = globalThis.window?.openMasqueradeCharPreview;
    const originalImportCharacter = provider.importCharacter;

    class FakeClassList {
        constructor() {
            this.values = new Set();
        }

        add(...classes) {
            for (const cls of classes) this.values.add(cls);
        }

        remove(...classes) {
            for (const cls of classes) this.values.delete(cls);
        }

        toggle(cls, force) {
            const shouldAdd = force ?? !this.values.has(cls);
            if (shouldAdd) this.values.add(cls);
            else this.values.delete(cls);
            return shouldAdd;
        }

        contains(cls) {
            return this.values.has(cls);
        }
    }

    class FakeElement {
        constructor(id) {
            this.id = id;
            this.listeners = {};
            this.dataset = {};
            this.style = {};
            this.classList = new FakeClassList();
        }

        addEventListener(event, handler) {
            this.listeners[event] ||= [];
            this.listeners[event].push(handler);
        }

        removeEventListener(event, handler) {
            this.listeners[event] = (this.listeners[event] || []).filter(fn => fn !== handler);
        }

        async dispatch(event, payload = {}) {
            for (const handler of this.listeners[event] || []) {
                await handler({
                    target: this,
                    currentTarget: this,
                    stopPropagation() {},
                    preventDefault() {},
                    ...payload,
                });
            }
        }

        querySelector() { return null; }
    }

    const elements = new Map();
    const getElement = id => {
        if (!elements.has(id)) elements.set(id, new FakeElement(id));
        return elements.get(id);
    };
    const shownSummaries = [];
    const toasts = [];
    provider.importCharacter = async () => ({
        success: true,
        characterName: 'Lucoa & Lucow (Astrodragon)',
        fileName: 'masquerade_lucoa.png',
        avatarUrl: 'https://example.test/avatar.png',
        hasGallery: true,
        providerCharId: SAMPLE_UUID,
        fullPath: SAMPLE_UUID,
        galleryId: 'gallery-lucoa',
        embeddedMediaUrls: [],
        galleryPageUrls: [],
        cardData: { name: 'Lucoa & Lucow (Astrodragon)' },
    });
    provider.browseView.provider = provider;
    registry.registerProvider(provider);

    globalThis.document = {
        getElementById: getElement,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
        body: { style: {} },
    };
    globalThis.window = {
        openMasqueradeCharPreview: openPreview,
        registerOverlay() {},
        checkCharacterForDuplicatesAsync: async () => [],
        getSetting: () => undefined,
        showToast: (message, type) => toasts.push({ message, type }),
        hideModal: id => getElement(id).classList.add('hidden'),
        showImportSummaryModal(summary) {
            shownSummaries.push(summary);
            getElement('importSummaryModal').classList.remove('hidden');
        },
        fetchAndAddCharacter: async () => true,
        fetchCharacters: async () => {},
        getAllCharacters: () => [],
        escapeHtml: value => String(value),
    };
    globalThis.requestAnimationFrame = callback => callback();

    try {
        provider.browseView.init();
        provider.browseView.init();

        assert.equal(getElement('masqueradeImportBtn').listeners.click.length, 1);
        assert.equal(getElement('masqueradeCharClose').listeners.click.length, 1);
        assert.equal(getElement('masqueradeCharModal').listeners.click.length, 1);

        window.openMasqueradeCharPreview({
            id: SAMPLE_UUID,
            name: 'Lucoa & Lucow (Astrodragon)',
            image_url: 'https://example.test/avatar.png',
            background_url: 'https://example.test/background.png',
        });
        await getElement('masqueradeImportBtn').dispatch('click');

        assert.equal(shownSummaries.length, 1);
        assert.equal(getElement('importSummaryModal').classList.contains('hidden'), false);
        assert.equal(shownSummaries[0].galleryCharacters.length, 1);
        assert.deepEqual(shownSummaries[0].mediaCharacters, []);
        assert.equal(toasts.some(toast => toast.type === 'error'), false);
    } finally {
        globalThis.document = oldDocument;
        globalThis.window = oldWindow;
        globalThis.requestAnimationFrame = oldRequestAnimationFrame;
        provider.importCharacter = originalImportCharacter;
    }
});
