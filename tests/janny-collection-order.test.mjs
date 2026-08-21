import test from 'node:test';
import assert from 'node:assert/strict';

import { orderJannyCollectionCharacters } from '../modules/providers/janny/janny-collection-order.js';

test('Janny collection cards sort newest first without mutating API order', () => {
    const input = [
        { id: 'old', name: 'Old', createdAtStamp: 100 },
        { id: 'iso', name: 'ISO', createdAt: '2026-07-19T12:00:00Z' },
        { id: 'new', name: 'New', createdAtStamp: 2000000000 },
    ];

    const ordered = orderJannyCollectionCharacters(input);

    assert.deepEqual(ordered.map(c => c.id), ['new', 'iso', 'old']);
    assert.deepEqual(input.map(c => c.id), ['old', 'iso', 'new']);
});

test('Janny latest order has a deterministic fallback when dates are missing or tied', () => {
    const input = [
        { id: 'b', name: 'Same' },
        { id: 'z', name: 'Zed', createdAtStamp: 10 },
        { id: 'a', name: 'Same' },
        { id: 'alpha', name: 'Alpha' },
    ];

    const first = orderJannyCollectionCharacters(input);
    const second = orderJannyCollectionCharacters([...input].reverse());

    assert.deepEqual(first.map(c => c.id), ['z', 'alpha', 'a', 'b']);
    assert.deepEqual(second.map(c => c.id), first.map(c => c.id));
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
