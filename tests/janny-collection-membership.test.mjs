import test from 'node:test';
import assert from 'node:assert/strict';

import {
    collectionEntryCharacterId,
    collectionEntryMatchesCharacter,
} from '../modules/providers/janny/janny-collection-membership.js';

test('Janny collection membership recognizes direct and relation-wrapped character ids', () => {
    const id = 'aaaaaaaa-1111-4111-8111-111111111111';
    const entries = [
        id,
        { id },
        { characterId: id },
        { character: { id } },
        { character: { character: { id } } },
        { characters: { character: { character_id: id } } },
    ];

    for (const entry of entries) {
        assert.equal(collectionEntryCharacterId(entry), id);
        assert.equal(collectionEntryMatchesCharacter(entry, id), true);
    }
});

test('Janny collection membership rejects missing and different ids', () => {
    const id = 'aaaaaaaa-1111-4111-8111-111111111111';

    assert.equal(collectionEntryCharacterId({ character: {} }), '');
    assert.equal(collectionEntryMatchesCharacter({ character: {} }, id), false);
    assert.equal(collectionEntryMatchesCharacter({ id: 'bbbbbbbb-2222-4222-8222-222222222222' }, id), false);
});
