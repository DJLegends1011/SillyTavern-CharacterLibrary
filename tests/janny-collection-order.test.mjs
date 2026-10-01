import test from 'node:test';
import assert from 'node:assert/strict';
import { orderJannyCollectionCharacters } from '../modules/providers/janny/janny-collection-order.js';

test('membership order wins over response order, names and dates without mutating input', () => {
    const input = [{ id: 'alcina', createdAtStamp: 200 }, { id: 'jean', createdAtStamp: 300 }, { id: 'kobeni', createdAtStamp: 100 }];
    assert.deepEqual(orderJannyCollectionCharacters(input, ['kobeni', 'alcina', 'jean']).map(c => c.id), ['kobeni', 'alcina', 'jean']);
    assert.deepEqual(input.map(c => c.id), ['alcina', 'jean', 'kobeni']);
});

test('missing cards are skipped and unlisted cards keep their relative order at the end', () => {
    const input = [{ id: 'extra-z' }, { id: 'a' }, { id: 'extra-a' }, { id: 'z' }];
    assert.deepEqual(orderJannyCollectionCharacters(input, ['missing', 'z', 'a', 'z']).map(c => c.id), ['z', 'a', 'extra-z', 'extra-a']);
});

test('without member ids, member order is preserved in a separate array', () => {
    const input = [{ id: 'z', createdAtStamp: 1 }, { id: 'a', createdAtStamp: 2 }];
    const ordered = orderJannyCollectionCharacters(input);
    assert.deepEqual(ordered, input);
    assert.notEqual(ordered, input);
    assert.deepEqual(orderJannyCollectionCharacters(null), []);
});
