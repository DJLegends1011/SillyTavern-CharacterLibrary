import test from 'node:test';
import assert from 'node:assert/strict';

async function loadApi() {
    try {
        return await import('../modules/providers/masquerade/masquerade-api.js');
    } catch (error) {
        assert.fail(`masquerade-api.js should be importable: ${error.message}`);
    }
}

const SAMPLE_UUID = '477ec869-957d-40ad-a32a-d992623f5b66';

const sampleRow = {
    id: SAMPLE_UUID,
    user_id: '14ed6ac7-ce9d-4e7a-b026-2e76771ad152',
    name: 'Kindred - The Heir',
    tagline: 'An old amulet wakes something ancient.',
    description: 'PERSONALITY: Quiet, possessive, and patient.',
    personality: 'An old amulet wakes something ancient.',
    scenario: 'PERSONALITY: Quiet, possessive, and patient.',
    greeting: '*The amulet turns warm in your palm.*',
    alternate_greetings: ['*She waits in the doorway.*', '', null],
    image_url: 'https://example.test/avatar.jpg',
    background_url: 'https://example.test/background.jpg',
    circle_avatar_url: 'https://example.test/avatar.jpg',
    is_nsfw: true,
    is_unlisted: false,
    origin_tag: 'video_game',
    identity_tags: ['female', 'god'],
    personality_tags: ['wise', 'female'],
    subscriber_count: 29,
    total_messages: 2707,
    unique_chatters: 259,
    quality_score: 97,
    created_at: '2026-02-15T19:47:07.402534+00:00',
};

test('buildCharacterCardFromMasquerade maps a public row to V2 card data', async () => {
    const api = await loadApi();

    const card = api.buildCharacterCardFromMasquerade(sampleRow);

    assert.equal(card.spec, 'chara_card_v2');
    assert.equal(card.spec_version, '2.0');
    assert.equal(card.data.name, sampleRow.name);
    assert.equal(card.data.description, sampleRow.description);
    assert.equal(card.data.personality, '');
    assert.equal(card.data.scenario, '');
    assert.equal(card.data.first_mes, sampleRow.greeting);
    assert.deepEqual(card.data.alternate_greetings, ['*She waits in the doorway.*']);
    assert.deepEqual(card.data.tags, ['video_game', 'female', 'god', 'wise', 'nsfw']);
    assert.equal(card.data.tags.includes('masquerade'), false);
    assert.equal(card.data.creator_notes, '');
    assert.equal(card.data.extensions.masquerade.tagline, sampleRow.tagline);
    assert.match(card.data.extensions.masquerade.sourceUrl, /masqueradeproductions\.org\/character\//);
    assert.doesNotMatch(card.data.creator_notes, /Imported from MasqueradeAI/);
    assert.doesNotMatch(card.data.creator_notes, /Tagline:/);
    assert.doesNotMatch(card.data.creator_notes, /Source:/);
    assert.doesNotMatch(card.data.creator_notes, /2707 messages/);
    assert.equal(card.data.extensions.masquerade.id, sampleRow.id);
    assert.equal(card.data.extensions.masquerade.pageName, sampleRow.name);
    assert.equal(card.data.extensions.masquerade.background_url, sampleRow.background_url);
    assert.equal(card.data.extensions.masquerade.circle_avatar_url, sampleRow.circle_avatar_url);
    assert.ok(card.data.extensions.masquerade.linkedAt);
});

test('buildCharacterCardFromMasquerade strips duplicated tagline from personality', async () => {
    const api = await loadApi();

    const card = api.buildCharacterCardFromMasquerade({
        ...sampleRow,
        tagline: 'W image gng.',
        personality: 'A confident and playful warrior who enjoys teasing reactions.\n\nW image gng.',
    });

    assert.equal(card.data.personality, 'A confident and playful warrior who enjoys teasing reactions.');
    assert.equal(card.data.extensions.masquerade.tagline, 'W image gng.');
});

test('buildCharacterCardFromMasquerade preserves distinct V2 description and scenario fields', async () => {
    const api = await loadApi();

    const card = api.buildCharacterCardFromMasquerade({
        ...sampleRow,
        description: 'Visible description field.',
        scenario: 'Separate scenario field.',
        personality: '',
        tagline: 'Listing-only tagline.',
    });

    assert.equal(card.data.description, 'Visible description field.');
    assert.equal(card.data.scenario, 'Separate scenario field.');
    assert.equal(card.data.personality, '');
    assert.equal(card.data.creator_notes, '');
    assert.equal(card.data.extensions.masquerade.tagline, 'Listing-only tagline.');
});

test('buildCharacterCardFromMasquerade uses real creator notes only when supplied by source data', async () => {
    const api = await loadApi();

    const card = api.buildCharacterCardFromMasquerade({
        ...sampleRow,
        creator_notes: 'Actual author notes from the source card.',
    });

    assert.equal(card.data.creator_notes, 'Actual author notes from the source card.');
});

test('parseCharacterUrl extracts Masquerade character IDs from supported routes', async () => {
    const api = await loadApi();

    assert.equal(api.parseCharacterUrl(`https://www.masqueradeproductions.org/character/${SAMPLE_UUID}`), SAMPLE_UUID);
    assert.equal(api.parseCharacterUrl(`https://masqueradeproductions.org/chat/${SAMPLE_UUID}`), SAMPLE_UUID);
    assert.equal(api.parseCharacterUrl(`www.masqueradeproductions.org/character/${SAMPLE_UUID}`), SAMPLE_UUID);
    assert.equal(api.parseCharacterUrl('https://example.test/character/477ec869-957d-40ad-a32a-d992623f5b66'), null);
    assert.equal(api.parseCharacterUrl('https://www.masqueradeproductions.org/character/not-a-uuid'), null);
});

test('normalizeMasqueradeCharacter returns stable browse fields and gallery candidates', async () => {
    const api = await loadApi();

    const normalized = api.normalizeMasqueradeCharacter({
        ...sampleRow,
        character_id: SAMPLE_UUID,
        avatar_url: sampleRow.image_url,
    });

    assert.equal(normalized.id, SAMPLE_UUID);
    assert.equal(normalized.character_id, SAMPLE_UUID);
    assert.equal(normalized.avatar_url, sampleRow.image_url);
    assert.deepEqual(normalized.tags, ['video_game', 'female', 'god', 'wise']);
    assert.deepEqual(normalized.galleryUrls, [sampleRow.background_url]);
});

test('sortMasqueradeCharactersForBrowse matches the website popular scoring', async () => {
    const api = await loadApi();

    const rawMessageLeader = {
        ...sampleRow,
        id: SAMPLE_UUID,
        name: 'Raw message leader',
        total_messages: 5000,
        unique_chatters: 1,
        quality_score: 0,
        is_amplified: false,
    };
    const webPopularLeader = {
        ...sampleRow,
        id: 'c5f25770-af64-452d-9983-16676d1f47fe',
        name: 'Website popular leader',
        total_messages: 1000,
        unique_chatters: 10,
        quality_score: 100,
        is_amplified: true,
    };

    const sorted = api.sortMasqueradeCharactersForBrowse([rawMessageLeader, webPopularLeader], {
        sort: 'popular',
        nsfw: false,
    });

    assert.equal(sorted[0].id, webPopularLeader.id);
    assert.ok(
        api.getMasqueradePopularityScore(webPopularLeader) > api.getMasqueradePopularityScore(rawMessageLeader),
    );
});

test('Masquerade popular scoring boosts explicit rows only when feral mode is enabled', async () => {
    const api = await loadApi();

    const explicitRow = {
        ...sampleRow,
        is_nsfw: true,
        quality_score: 80,
        total_messages: 100,
        unique_chatters: 10,
    };

    assert.ok(
        api.getMasqueradePopularityScore(explicitRow, { nsfw: true })
            > api.getMasqueradePopularityScore(explicitRow, { nsfw: false }),
    );
});

test('visibility helpers reject force-private Masquerade rows', async () => {
    const api = await loadApi();

    assert.equal(api.isMasqueradeCharacterImportable(sampleRow), true);
    assert.equal(api.isMasqueradeCharacterBrowsable(sampleRow), true);
    assert.equal(api.isMasqueradeCharacterImportable({ ...sampleRow, force_private: true }), false);
    assert.equal(api.isMasqueradeCharacterBrowsable({ ...sampleRow, force_private: true }), false);
});

test('searchMasqueradeCharacters paginates fuzzy search results', async () => {
    const api = await loadApi();
    const oldFetch = globalThis.fetch;
    const rows = Array.from({ length: 75 }, (_, index) => ({
        ...sampleRow,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        name: `Search result ${index}`,
        is_nsfw: false,
    }));

    globalThis.fetch = async () => ({
        ok: true,
        json: async () => rows,
    });

    try {
        const pageTwo = await api.searchMasqueradeCharacters({
            query: 'kindred',
            page: 2,
            limit: 10,
            nsfw: false,
        });

        assert.equal(pageTwo.length, 10);
        assert.equal(pageTwo[0].name, 'Search result 10');
        assert.equal(pageTwo[9].name, 'Search result 19');
    } finally {
        globalThis.fetch = oldFetch;
    }
});
