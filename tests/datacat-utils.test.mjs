import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    buildDataCatHeaders,
    chooseDataCatToken,
    isDataCatCharacterId,
    normalizeDcCredential,
    sanitizeDataCatUser,
} from '../extras/cl-helper/datacat-utils.js';

describe('normalizeDcCredential', () => {
    it('trims strings and rejects invalid values', () => {
        assert.equal(normalizeDcCredential('  abc123  '), 'abc123');
        assert.equal(normalizeDcCredential(''), null);
        assert.equal(normalizeDcCredential('   \t\n  '), null);
        assert.equal(normalizeDcCredential(null), null);
        assert.equal(normalizeDcCredential('a'.repeat(4097)), null);
    });
});

describe('chooseDataCatToken', () => {
    it('prefers account token when requested and available', () => {
        assert.deepEqual(
            chooseDataCatToken({ accountToken: 'acct', anonymousToken: 'anon', preferAccount: true }),
            { token: 'acct', source: 'account' },
        );
    });

    it('uses anonymous token when account preference is disabled', () => {
        assert.deepEqual(
            chooseDataCatToken({ accountToken: 'acct', anonymousToken: 'anon', preferAccount: false }),
            { token: 'anon', source: 'anonymous' },
        );
    });

    it('falls back to anonymous token when preferred account token is empty', () => {
        assert.deepEqual(
            chooseDataCatToken({ accountToken: '', anonymousToken: 'anon', preferAccount: true }),
            { token: 'anon', source: 'anonymous' },
        );
    });
});

describe('buildDataCatHeaders', () => {
    it('builds DataCat request headers with optional tokens and json content type', () => {
        assert.deepEqual(buildDataCatHeaders({
            sessionToken: 'session',
            deviceToken: 'device',
            json: true,
        }), {
            'User-Agent': 'SillyTavern-CharacterLibrary',
            Accept: 'application/json',
            Origin: 'https://datacat.run',
            Referer: 'https://datacat.run/',
            'X-Session-Token': 'session',
            'X-Device-Token': 'device',
            'Content-Type': 'application/json',
        });
    });
});

describe('sanitizeDataCatUser', () => {
    it('returns only public user fields', () => {
        const sanitized = sanitizeDataCatUser({
            uuid: '  user-123  ',
            email: '  user@example.com  ',
            username: '  datacat  ',
            role: '  admin  ',
            session: 'secret',
            passwordHash: 'hash',
        });

        assert.deepEqual(sanitized, {
            uuid: 'user-123',
            email: 'user@example.com',
            username: 'datacat',
            role: 'admin',
        });
        assert.equal('session' in sanitized, false);
        assert.equal('passwordHash' in sanitized, false);
    });
});

describe('isDataCatCharacterId', () => {
    it('accepts DataCat UUID-like IDs only', () => {
        assert.equal(isDataCatCharacterId('123e4567-e89b-12d3-a456-426614174000'), true);
        assert.equal(isDataCatCharacterId('abc12345'), true);
        assert.equal(isDataCatCharacterId('../bad'), false);
        assert.equal(isDataCatCharacterId('not a uuid'), false);
    });
});
