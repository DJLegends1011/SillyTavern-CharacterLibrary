import assert from 'node:assert/strict';
import test from 'node:test';

const migration = await import('../modules/providers/janny/janny-link-migration.js').catch(() => ({}));

test('a Janny card missing from JanitorAI is left untouched', async () => {
    assert.equal(typeof migration.migrateJannyRow, 'function', 'migration helper should exist');

    const writes = [];
    const result = await migration.migrateJannyRow({
        avatar: 'missing.png',
        bucket: 'ready',
        resolved: '11111111-1111-4111-8111-111111111111',
        pageName: 'Mirror copy',
        tagline: 'Still available on JannyAI',
    }, {
        verify: async () => null,
        write: async (...args) => { writes.push(args); return true; },
    });

    assert.deepEqual(result, { status: 'missing' });
    assert.deepEqual(writes, []);
});

test('an unverifiable Janny card is left untouched', async () => {
    const writes = [];
    const result = await migration.migrateJannyRow({
        avatar: 'blocked.png',
        bucket: 'ready',
        resolved: '22222222-2222-4222-8222-222222222222',
    }, {
        verify: async () => { throw new Error('browser unavailable'); },
        write: async (...args) => { writes.push(args); return true; },
    });

    assert.equal(result.status, 'unverified');
    assert.equal(result.error.message, 'browser unavailable');
    assert.deepEqual(writes, []);
});

test('a verified Janny card gains a JanitorAI link while keeping its Janny link', async () => {
    const writes = [];
    const result = await migration.migrateJannyRow({
        avatar: 'verified.png',
        bucket: 'ready',
        resolved: '33333333-3333-4333-8333-333333333333',
        pageName: 'Janny listing name',
        tagline: 'Mirrored tagline',
    }, {
        verify: async () => ({
            id: '33333333-3333-4333-8333-333333333333',
            name: 'Janitor listing name',
        }),
        write: async (...args) => { writes.push(args); return true; },
        now: () => '2026-09-04T01:02:03.000Z',
        removeSource: false,
        deleteValue: '__DELETE__',
    });

    assert.deepEqual(result, { status: 'migrated' });
    assert.deepEqual(writes, [[
        'verified.png',
        {
            'extensions.janitorai.id': '33333333-3333-4333-8333-333333333333',
            'extensions.janitorai.linkedAt': '2026-09-04T01:02:03.000Z',
            'extensions.janitorai.pageName': 'Janitor listing name',
            'extensions.janitorai.tagline': 'Mirrored tagline',
        },
    ]]);
});

test('source removal happens only in the same write as a verified JanitorAI link', async () => {
    const writes = [];
    const result = await migration.migrateJannyRow({
        avatar: 'move.png',
        bucket: 'ready',
        resolved: '44444444-4444-4444-8444-444444444444',
    }, {
        verify: async () => ({ id: '44444444-4444-4444-8444-444444444444', name: 'Move me' }),
        write: async (...args) => { writes.push(args); return true; },
        now: () => '2026-09-04T02:03:04.000Z',
        removeSource: true,
        deleteValue: '__DELETE__',
    });

    assert.deepEqual(result, { status: 'migrated' });
    assert.deepEqual(writes[0][1], {
        'extensions.janitorai.id': '44444444-4444-4444-8444-444444444444',
        'extensions.janitorai.linkedAt': '2026-09-04T02:03:04.000Z',
        'extensions.janitorai.pageName': 'Move me',
        'extensions.jannyai': '__DELETE__',
    });
});

test('scan separates ready, already-linked, conflicting, and invalid Janny links', () => {
    assert.equal(typeof migration.scanJannyMigrationRows, 'function', 'scanner should exist');

    const make = (avatar, jannyId, janitorId, ready = true) => ({
        avatar,
        name: avatar.replace('.png', ''),
        _ready: ready,
        data: {
            extensions: {
                ...(jannyId ? { jannyai: { id: jannyId, pageName: `${avatar} page`, tagline: `${avatar} tag` } } : {}),
                ...(janitorId ? { janitorai: { id: janitorId } } : {}),
            },
        },
    });
    const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    const result = migration.scanJannyMigrationRows([
        make('ready.png', idA),
        make('same.png', idA, idA),
        make('conflict.png', idA, idB),
        make('invalid.png', 'not-a-uuid'),
        make('unloaded.png', idA, null, false),
        make('unlinked.png'),
    ], {
        extensionsReady: char => char._ready,
        getName: char => char.name,
    });

    assert.equal(result.notChecked, 1);
    assert.deepEqual(result.rows.map(row => ({
        avatar: row.avatar,
        bucket: row.bucket,
        resolved: row.resolved,
        existing: row.existing,
    })), [
        { avatar: 'ready.png', bucket: 'ready', resolved: idA, existing: null },
        { avatar: 'same.png', bucket: 'already', resolved: idA, existing: idA },
        { avatar: 'conflict.png', bucket: 'conflict', resolved: idA, existing: idB },
        { avatar: 'invalid.png', bucket: 'unresolvable', resolved: null, existing: null },
    ]);
});

test('a verification response for a different UUID is left untouched', async () => {
    const writes = [];
    const result = await migration.migrateJannyRow({
        avatar: 'mismatch.png',
        bucket: 'ready',
        resolved: '55555555-5555-4555-8555-555555555555',
    }, {
        verify: async () => ({ id: '66666666-6666-4666-8666-666666666666', name: 'Wrong card' }),
        write: async (...args) => { writes.push(args); return true; },
    });

    assert.deepEqual(result, { status: 'identity-mismatch' });
    assert.deepEqual(writes, []);
});

test('cleanup preserves an existing JanitorAI namespace while removing the Janny link', async () => {
    const writes = [];
    const result = await migration.migrateJannyRow({
        avatar: 'already.png',
        bucket: 'already',
        resolved: '77777777-7777-4777-8777-777777777777',
        pageName: 'Janny name',
        tagline: 'Janny tagline',
        existingNamespace: {
            id: '77777777-7777-4777-8777-777777777777',
            linkedAt: '2026-08-01T00:00:00.000Z',
            pageName: 'Existing Janitor name',
            avatar: 'existing-avatar.webp',
        },
    }, {
        verify: async () => ({ id: '77777777-7777-4777-8777-777777777777', name: 'Current Janitor name' }),
        write: async (...args) => { writes.push(args); return true; },
        removeSource: true,
        deleteValue: '__DELETE__',
    });

    assert.deepEqual(result, { status: 'cleaned' });
    assert.deepEqual(writes, [[
        'already.png',
        {
            'extensions.janitorai.tagline': 'Janny tagline',
            'extensions.jannyai': '__DELETE__',
        },
    ]]);
});

test('conflicting links are never verified or written', async () => {
    let verified = false;
    let written = false;
    const result = await migration.migrateJannyRow({
        avatar: 'conflict.png',
        bucket: 'conflict',
        resolved: '88888888-8888-4888-8888-888888888888',
        existing: '99999999-9999-4999-8999-999999999999',
    }, {
        verify: async () => { verified = true; return null; },
        write: async () => { written = true; return true; },
    });

    assert.deepEqual(result, { status: 'not-actionable' });
    assert.equal(verified, false);
    assert.equal(written, false);
});

test('a JanitorAI conflict added while verification is pending is never overwritten', async () => {
    const id = 'aaaaaaaa-1111-4111-8111-111111111111';
    const live = {
        avatar: 'changed-during-verify.png',
        data: { extensions: { jannyai: { id } } },
    };
    const writes = [];
    const result = await migration.migrateJannyRow({
        avatar: live.avatar,
        bucket: 'ready',
        resolved: id,
    }, {
        verify: async () => {
            live.data.extensions.janitorai = { id: 'bbbbbbbb-2222-4222-8222-222222222222' };
            return { id, name: 'Verified card' };
        },
        read: () => live,
        write: async (...args) => { writes.push(args); return true; },
    });

    assert.deepEqual(result, { status: 'stale-conflict' });
    assert.deepEqual(writes, []);
});

test('a changed JannyAI source is never deleted from stale scan data', async () => {
    const scannedId = 'cccccccc-3333-4333-8333-333333333333';
    const live = {
        avatar: 'changed-source.png',
        data: { extensions: { jannyai: { id: 'dddddddd-4444-4444-8444-444444444444' } } },
    };
    const writes = [];
    const result = await migration.migrateJannyRow({
        avatar: live.avatar,
        bucket: 'ready',
        resolved: scannedId,
    }, {
        verify: async () => ({ id: scannedId, name: 'Old card' }),
        read: () => live,
        write: async (...args) => { writes.push(args); return true; },
        removeSource: true,
        deleteValue: '__DELETE__',
    });

    assert.deepEqual(result, { status: 'stale-source' });
    assert.deepEqual(writes, []);
});

test('cancellation after verification starts prevents every write', async () => {
    const id = 'eeeeeeee-5555-4555-8555-555555555555';
    const controller = new AbortController();
    const writes = [];
    const result = await migration.migrateJannyRow({
        avatar: 'cancelled.png',
        bucket: 'ready',
        resolved: id,
    }, {
        signal: controller.signal,
        verify: async () => {
            controller.abort();
            return { id, name: 'Too late' };
        },
        write: async (...args) => { writes.push(args); return true; },
    });

    assert.deepEqual(result, { status: 'cancelled' });
    assert.deepEqual(writes, []);
});

test('UUIDs are trimmed and compared case-insensitively', async () => {
    const lower = 'ffffffff-6666-4666-8666-666666666666';
    const upper = lower.toUpperCase();
    const scan = migration.scanJannyMigrationRows([{
        avatar: 'uppercase.png',
        data: { extensions: {
            jannyai: { id: `  ${upper}  ` },
            janitorai: { id: lower },
        } },
    }]);
    assert.equal(scan.rows[0].bucket, 'already');
    assert.equal(scan.rows[0].resolved, lower);

    const writes = [];
    const result = await migration.migrateJannyRow({
        avatar: 'verified-uppercase.png',
        bucket: 'ready',
        resolved: lower,
    }, {
        verify: async () => ({ id: upper, name: 'Same UUID' }),
        write: async (...args) => { writes.push(args); return true; },
    });
    assert.equal(result.status, 'migrated');
    assert.equal(writes.length, 1);
});

test('verified JanitorAI description is preferred over the cached JannyAI tagline', async () => {
    const id = 'abababab-7777-4777-8777-777777777777';
    const writes = [];
    await migration.migrateJannyRow({
        avatar: 'tagline.png',
        bucket: 'ready',
        resolved: id,
        tagline: 'Old mirror tagline',
    }, {
        verify: async () => ({ id, name: 'Card', description: 'Current source tagline' }),
        write: async (...args) => { writes.push(args); return true; },
    });
    assert.equal(writes[0][1]['extensions.janitorai.tagline'], 'Current source tagline');
});
