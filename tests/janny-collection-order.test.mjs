import test from 'node:test';
import assert from 'node:assert/strict';

import { orderJannyCollectionCharacters, orderByIds } from '../modules/providers/janny/janny-collection-order.js';

test('Janny collection cards keep JannyAI order by default, never alphabetical', () => {
    const input = [
        { id: 'k', name: 'Kobeni', createdAtStamp: 100 },
        { id: 'a', name: 'Alcina' },
        { id: 'j', name: 'Jean Grey', createdAtStamp: 2000000000 },
    ];
    const ordered = orderJannyCollectionCharacters(input);
    assert.deepEqual(ordered.map(c => c.id), ['k', 'a', 'j']);
    assert.notEqual(ordered, input, 'returns a copy');
});

test('Janny random collection order uses Fisher-Yates and remains non-mutating', () => {
    const input = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const rolls = [0, 0, 0];
    const ordered = orderJannyCollectionCharacters(input, {
        randomize: true,
        random: () => rolls.shift(),
    });

    assert.deepEqual(ordered.map(c => c.id), ['b', 'c', 'd', 'a']);
    assert.deepEqual(input.map(c => c.id), ['a', 'b', 'c', 'd']);
});

test('orderByIds restores page order after get-characters reorders the batch', () => {
    const fetched = [{ id: 'a' }, { id: 'extra' }, { id: 'k' }, { id: 'j' }];
    assert.deepEqual(orderByIds(fetched, ['k', 'a', 'j']).map(c => c.id), ['k', 'a', 'j', 'extra']);
    assert.deepEqual(orderByIds(fetched, []).map(c => c.id), ['a', 'extra', 'k', 'j']);
});
