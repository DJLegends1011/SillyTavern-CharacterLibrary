import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    JANNY_BOOKMARK_CAP_DEFAULT,
    capForSettings,
    canAddBookmarks,
    reconcileBookmarkSet,
} from '../modules/providers/janny/janny-bookmark-logic.js';

test('default cap is 220', () => {
    assert.equal(JANNY_BOOKMARK_CAP_DEFAULT, 220);
});

test('capForSettings falls back to default and clamps', () => {
    assert.equal(capForSettings(() => undefined), 220);
    assert.equal(capForSettings(() => null), 220);
    assert.equal(capForSettings(() => 300), 300);
    assert.equal(capForSettings(() => 0), 1);
});

test('canAddBookmarks blocks at/over cap', () => {
    assert.deepEqual(canAddBookmarks(219, 1, 220), { ok: true, allowed: 1 });
    const blocked = canAddBookmarks(220, 1, 220);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.allowed, 0);
    assert.match(blocked.reason, /cap/i);
});

test('canAddBookmarks partial batch is not ok but reports headroom', () => {
    const r = canAddBookmarks(218, 5, 220);
    assert.equal(r.ok, false);
    assert.equal(r.allowed, 2);
});

test('reconcileBookmarkSet adds and removes', () => {
    const s = new Set(['a']);
    reconcileBookmarkSet(s, ['b', 'c'], true);
    assert.deepEqual([...s].sort(), ['a', 'b', 'c']);
    reconcileBookmarkSet(s, ['a'], false);
    assert.deepEqual([...s].sort(), ['b', 'c']);
});
