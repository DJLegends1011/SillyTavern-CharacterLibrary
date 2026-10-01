import test from 'node:test';
import assert from 'node:assert/strict';

import { orderJannyCollectionCharacters } from '../modules/providers/janny/janny-collection-order.js';

test('Janny collection cards default to latest: newest character first, without mutating input', () => {
    const input = [
        { id: 'old', name: 'Old', createdAtStamp: 100 },
        { id: 'iso', name: 'ISO', createdAt: '2026-07-19T12:00:00Z' },
        { id: 'new', name: 'New', createdAtStamp: 2000000000 },
    ];
    const ordered = orderJannyCollectionCharacters(input);
    assert.deepEqual(ordered.map(c => c.id), ['new', 'iso', 'old']);
    assert.deepEqual(input.map(c => c.id), ['old', 'iso', 'new']);
});

test('undated characters follow the dated ones in arrival order, never alphabetically', () => {
    const input = [
        { id: 'z', name: 'Zed' },
        { id: 'dated', name: 'Dated', createdAtStamp: 10 },
        { id: 'a', name: 'Alpha' },
    ];
    assert.deepEqual(orderJannyCollectionCharacters(input).map(c => c.id), ['dated', 'z', 'a']);
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
