import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createJannyHelperHarness, jannyCharacterDocument } from './helpers/janny-helper-harness.mjs';

const characterId = 'aaaaaaaa-1111-4111-8111-111111111111';
const identifier = `${characterId}_demo`;
const characterUrl = 'https://jannyai.com/characters/' + identifier;
const completeCharacter = { id: characterId, name: 'Demo', personality: 'Definition', firstMessage: 'Hello', scenario: '', exampleDialogs: '', tagIds: [1], creatorId: 'creator' };
const browserCalls = [], browserReplies = [], directCalls = [], importCalls = [];
globalThis.window = {
    getSetting: () => undefined,
    apiRequest: async (path, method, body) => {
        assert.equal(path, '/plugins/cl-helper/jannyai-browser-fetch');
        assert.equal(method, 'POST');
        browserCalls.push(body);
        const reply = browserReplies.shift();
        assert.ok(reply, 'Missing helper response');
        return { ok: true, status: 200, json: async () => ({ ok: true, finalUrl: characterUrl, body: '', ...reply }) };
    },
    addEventListener() {}, postMessage() {}, location: { origin: 'http://localhost' },
};
globalThis.fetch = async url => {
    directCalls.push(url);
    if (url === '/api/characters/import') importCalls.push(url);
    return { ok: false, status: 503, text: async () => '' };
};
await import('../modules/core-api.js');
const { default: provider } = await import('../modules/providers/janny/janny-provider.js');

beforeEach(() => { browserCalls.length = browserReplies.length = directCalls.length = importCalls.length = 0; });

test('requests hydrated character data in one browser call', async () => {
    browserReplies.push({ status: 200, hydratedCharacter: { character: completeCharacter, imageUrl: 'https://image.jannyai.com/demo.png' } });
    const result = await provider.fetchMetadata(identifier);
    assert.equal(result?.personality, 'Definition');
    assert.equal(result.firstMessage, 'Hello');
    assert.equal(browserCalls.length, 1);
    assert.equal(browserCalls[0].path, '/characters/' + identifier);
    assert.equal(browserCalls[0].inspectCharacterId, characterId);
    assert.equal(directCalls.length, 0);
});

for (const character of [
    { ...completeCharacter, id: 'different' },
    { ...completeCharacter, firstMessage: '' },
    { ...completeCharacter, firstMessage: ' \n' },
    { ...completeCharacter, personality: '', scenario: '', exampleDialogs: '' },
    { ...completeCharacter, personality: {} },
    { ...completeCharacter, scenario: {} },
    { ...completeCharacter, firstMessage: ['Hello'] },
    null,
]) {
    test('rejects incomplete or mismatched hydrated payload ' + JSON.stringify(character), async () => {
        browserReplies.push({ status: 200, hydratedCharacter: { character } });
        await assert.rejects(provider.fetchMetadata(identifier), error => error.code === 'JANNY_PAGE_SHAPE_CHANGED');
        assert.equal(directCalls.length, 0);
    });
}

test('accepts scenario or exampleDialogs as the complete definition', async () => {
    for (const field of ['scenario', 'exampleDialogs']) {
        browserReplies.push({ status: 200, hydratedCharacter: { character: { ...completeCharacter, personality: '', [field]: 'Definition' } } });
        assert.equal((await provider.fetchMetadata(identifier))[field], 'Definition');
    }
});

for (const operation of ['fetchMetadata', 'fetchRemoteCard', 'importCharacter']) {
    test(operation + ' propagates classified blocks without importing listing data', async () => {
        browserReplies.push({ status: 403, body: '<title>Forbidden</title>' });
        const input = operation === 'fetchRemoteCard' ? { id: characterId, slug: 'demo' } : identifier;
        await assert.rejects(provider[operation](input, { id: characterId, name: 'Listing stub' }), error => error.code === 'JANNY_CF_BLOCKED');
        assert.equal(browserCalls.length, 1);
        assert.equal(importCalls.length, 0);
        assert.equal(directCalls.length, 0);
    });
}

test('import cannot bypass hydration with plausible pre-fetched definition fields', async () => {
    browserReplies.push({ status: 200, hydratedCharacter: null });
    await assert.rejects(provider.importCharacter(identifier, completeCharacter), error => error.code === 'JANNY_PAGE_SHAPE_CHANGED');
    assert.equal(browserCalls.length, 1);
    assert.equal(importCalls.length, 0);
});

test('provider consumes actual helper extraction and maps full card fields', async () => {
    const harness = createJannyHelperHarness([], { document: jannyCharacterDocument({ ...completeCharacter, scenario: 'Scene', exampleDialogs: 'Examples' }) });
    const original = window.apiRequest;
    window.apiRequest = harness.apiRequest;
    try {
        const card = await provider.fetchRemoteCard({ id: characterId, slug: 'demo' });
        assert.equal(card?.data.description, 'Definition');
        assert.equal(card.data.first_mes, 'Hello');
        assert.equal(card.data.scenario, 'Scene');
        assert.equal(card.data.mes_example, 'Examples');
        assert.equal(harness.navigations.length, 1);
        assert.equal(harness.requests.length, 0);
    } finally { window.apiRequest = original; }
});

test('imports hydrated definitions and only backfills metadata from an identity-matched listing', async () => {
    const originalFetch = globalThis.fetch;
    let embeddedCard;
    await provider.init({ embedCharacterDataInPng: (png, card) => { embeddedCard = card; return png; } });
    globalThis.fetch = async url => {
        directCalls.push(url);
        if (url === 'https://image.jannyai.com/demo.png') return { ok: true, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer };
        if (url === '/api/characters/import') {
            importCalls.push(url);
            return { ok: true, text: async () => '{"file_name":"demo"}' };
        }
        return { ok: false, status: 503, text: async () => '' };
    };
    try {
        browserReplies.push({ status: 200, hydratedCharacter: { character: { ...completeCharacter, creatorId: null, tagIds: [] }, imageUrl: 'https://image.jannyai.com/demo.png' } });
        const result = await provider.importCharacter(identifier, { id: characterId, creatorId: 'listing-creator', tagIds: [987654321], personality: 'DO NOT IMPORT', firstMessage: 'NOT THE GREETING' });
        assert.equal(result.success, true);
        assert.equal(embeddedCard.data.description, 'Definition');
        assert.equal(embeddedCard.data.first_mes, 'Hello');
        assert.equal(embeddedCard.data.creator, 'listing-creator');
        assert.deepEqual(embeddedCard.data.tags, ['Tag 987654321']);
        assert.equal(browserCalls.length, 1);
        assert.deepEqual(directCalls, ['https://image.jannyai.com/demo.png', '/api/characters/import']);
        assert.equal(importCalls.length, 1);
    } finally { globalThis.fetch = originalFetch; }
});

// The hydrated island's imageUrl is page-supplied: it must not become an outbound fetch to
// wherever the page says. Anything off JannyAI's image hosts falls back to the avatar path
// this provider builds itself.
for (const [name, imageUrl, expectedAvatar] of [
    ['a foreign https host is refused', 'https://attacker.example/pixel.png', 'https://image.jannyai.com/bot-avatars/demo.png'],
    ['a lookalike host is refused', 'https://image.jannyai.com.attacker.example/pixel.png', 'https://image.jannyai.com/bot-avatars/demo.png'],
    ['a non-https scheme is refused', 'http://image.jannyai.com/demo.png', 'https://image.jannyai.com/bot-avatars/demo.png'],
    ['a relative path is refused', '/demo.png', 'https://image.jannyai.com/bot-avatars/demo.png'],
    ['a JannyAI image host is used as given', 'https://image.jannyai.com/hydrated.png', 'https://image.jannyai.com/hydrated.png'],
]) {
    test('hydrated avatar URL: ' + name, async () => {
        const originalFetch = globalThis.fetch;
        let embeddedCard;
        await provider.init({ embedCharacterDataInPng: (png, card) => { embeddedCard = card; return png; } });
        globalThis.fetch = async url => {
            directCalls.push(url);
            if (url === '/api/characters/import') { importCalls.push(url); return { ok: true, text: async () => '{"file_name":"demo"}' }; }
            return { ok: true, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer };
        };
        try {
            browserReplies.push({ status: 200, hydratedCharacter: { character: { ...completeCharacter, avatar: 'demo.png' }, imageUrl } });
            const result = await provider.importCharacter(identifier, { id: characterId });
            assert.equal(result.success, true);
            assert.ok(embeddedCard, 'import did not produce a card');
            assert.deepEqual(directCalls, [expectedAvatar, '/api/characters/import']);
        } finally { globalThis.fetch = originalFetch; }
    });
}

for (const [name, character] of [
    ['character', [99, completeCharacter]],
    ['definition field', [0, { ...completeCharacter, personality: [99, 'Definition'] }]],
]) {
    test('actual helper/provider boundary rejects unsupported Astro tag around ' + name, async () => {
        const harness = createJannyHelperHarness([], {
            document: jannyCharacterDocument(completeCharacter, { rawProps: JSON.stringify({ character }) }),
        });
        const original = window.apiRequest;
        window.apiRequest = harness.apiRequest;
        try {
            await assert.rejects(provider.fetchMetadata(identifier), error => error.code === 'JANNY_PAGE_SHAPE_CHANGED');
            assert.equal(harness.navigations.length, 1);
            assert.equal(harness.requests.length, 0);
            assert.equal(importCalls.length, 0);
        } finally { window.apiRequest = original; }
    });
}
