import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    buildDataCatHeaders,
    buildDataCatAccountIdentifyHeaders,
    chooseDataCatToken,
    isDataCatCharacterId,
    normalizeDcCredential,
    normalizeOptionalDcCredential,
    sanitizeDataCatUser,
} from '../extras/cl-helper/datacat-utils.js';
import {
    buildDatacatYoursCharactersPath,
    isDatacatYoursCollectableHit,
    isDatacatYoursSavedHit,
    getDatacatGoogleAuthOriginIssue,
    resolveDatacatGoogleAuthLocalhostUrl,
} from '../modules/providers/datacat/datacat-api.js';

describe('normalizeDcCredential', () => {
    it('trims strings and rejects invalid values', () => {
        assert.equal(normalizeDcCredential('  abc123  '), 'abc123');
        assert.equal(normalizeDcCredential(''), null);
        assert.equal(normalizeDcCredential('   \t\n  '), null);
        assert.equal(normalizeDcCredential('abc\r\n123'), null);
        assert.equal(normalizeDcCredential(null), null);
        assert.equal(normalizeDcCredential('a'.repeat(4097)), null);
    });
});

describe('normalizeOptionalDcCredential', () => {
    it('omits missing optional credentials and normalizes supplied strings', () => {
        assert.equal(normalizeOptionalDcCredential(undefined), null);
        assert.equal(normalizeOptionalDcCredential(null), null);
        assert.equal(normalizeOptionalDcCredential(''), null);
        assert.equal(normalizeOptionalDcCredential('  device-token  '), 'device-token');
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
        assert.deepEqual(
            chooseDataCatToken({ accountToken: 'acct', anonymousToken: null, preferAccount: false }),
            { token: null, source: null },
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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Accept: 'application/json',
            Origin: 'https://datacat.run',
            Referer: 'https://datacat.run/',
            'X-Session-Token': 'session',
            'X-Device-Token': 'device',
            'Content-Type': 'application/json',
        });
    });
});

describe('buildDataCatAccountIdentifyHeaders', () => {
    it('builds authenticated identify headers without requiring a device token', () => {
        assert.deepEqual(buildDataCatAccountIdentifyHeaders('  account-token  ', null), {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Accept: 'application/json',
            Origin: 'https://datacat.run',
            Referer: 'https://datacat.run/',
            'X-Session-Token': 'account-token',
            'Content-Type': 'application/json',
        });
    });

    it('includes a device token when one is available', () => {
        assert.equal(buildDataCatAccountIdentifyHeaders('', 'device'), null);
        assert.equal(buildDataCatAccountIdentifyHeaders('bad\ntoken', 'device'), null);
        assert.deepEqual(buildDataCatAccountIdentifyHeaders('account-token', 'device-token')['X-Device-Token'], 'device-token');
    });
});

describe('resolveDatacatGoogleAuthLocalhostUrl', () => {
    it('rewrites loopback IP URLs to localhost for Firebase auth', () => {
        assert.equal(
            resolveDatacatGoogleAuthLocalhostUrl('http://127.0.0.1:8001/characters?x=1#settings'),
            'http://localhost:8001/characters?x=1#settings',
        );
    });

    it('does not rewrite localhost, LAN, or HTTPS URLs', () => {
        assert.equal(resolveDatacatGoogleAuthLocalhostUrl('http://localhost:8001/characters'), null);
        assert.equal(resolveDatacatGoogleAuthLocalhostUrl('http://192.168.1.50:8001/characters'), null);
        assert.equal(resolveDatacatGoogleAuthLocalhostUrl('https://127.0.0.1:8001/characters'), null);
        assert.equal(resolveDatacatGoogleAuthLocalhostUrl('not a url'), null);
    });

    it('does not rewrite embedded Character Library pages because SillyTavern CSRF is tied to the parent origin', () => {
        assert.equal(
            resolveDatacatGoogleAuthLocalhostUrl('http://127.0.0.1:8001/scripts/extensions/third-party/SillyTavern-CharacterLibrary/app/library.html?csrf=abc&embedded=1'),
            null,
        );
    });
});

describe('getDatacatGoogleAuthOriginIssue', () => {
    it('allows localhost Google auth', () => {
        assert.equal(getDatacatGoogleAuthOriginIssue('http://localhost:8001/characters'), null);
    });

    it('blocks embedded loopback, plain loopback, and LAN origins before Firebase popup auth', () => {
        assert.equal(
            getDatacatGoogleAuthOriginIssue('http://127.0.0.1:8001/scripts/extensions/third-party/SillyTavern-CharacterLibrary/app/library.html?embedded=1&csrf=abc'),
            'embedded-loopback',
        );
        assert.equal(getDatacatGoogleAuthOriginIssue('http://127.0.0.1:8001/characters'), 'loopback');
        assert.equal(getDatacatGoogleAuthOriginIssue('http://192.168.1.50:8001/characters'), 'unsupported-host');
    });

    it('does not block malformed URLs because runtime auth error handling can handle them', () => {
        assert.equal(getDatacatGoogleAuthOriginIssue('not a url'), null);
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
        assert.equal(isDataCatCharacterId('--------'), false);
        assert.equal(isDataCatCharacterId('abc--123'), false);
    });
});

describe('isDatacatYoursCollectableHit', () => {
    it('hides Yours controls for unextracted or external-only rows', () => {
        assert.equal(isDatacatYoursCollectableHit({
            characterId: '913bce55-0975-4f1c-a8a2-74771c5e51ea',
            primaryContentSourceKind: 'janitor_core',
            isFullyExtractedInDb: false,
            hasPartialExtraction: true,
            isPublicFeedInDb: false,
        }), false);
        assert.equal(isDatacatYoursCollectableHit({
            character_id: '913bce55-0975-4f1c-a8a2-74771c5e51ea',
            _source: 'meilisearch',
        }), false);
    });

    it('shows Yours controls for extracted creator rows and normal public rows', () => {
        assert.equal(isDatacatYoursCollectableHit({
            characterId: '913bce55-0975-4f1c-a8a2-74771c5e51ea',
            isFullyExtractedInDb: true,
        }), true);
        assert.equal(isDatacatYoursCollectableHit({
            character_id: '190fafd9-b5f0-4c24-b532-7fdac0c5a357',
            name: 'Public DataCat row',
        }), true);
    });

    it('shows Yours controls for real recent-public summary rows whether or not they were janny-recovered', () => {
        // Real shape from /api/characters/recent-public?summary=1: collectability is
        // signalled by appearOnPublicFeed/isPublic, NOT the *_in_db names. The
        // has_janny_recovery / is_recovery_placeholder keys are present on every
        // native row, so their mere presence must not gate the control off.
        const summaryRow = {
            characterId: '402d5565-705d-43e1-8bb6-fbdbd77a6765',
            name: 'The Tribal Hunter has captured you for Marriage',
            isPublic: true,
            appearOnPublicFeed: true,
            appear_on_public_feed: true,
            isCollected: false,
            isExtractedByYou: false,
            extractedAt: '2026-06-15T17:49:05.903Z',
            primary_content_source_kind: 'janitor_core',
            is_recovery_placeholder: false,
        };
        // Non-janny-recovered public card (the reported bug) must be collectable.
        assert.equal(isDatacatYoursCollectableHit({ ...summaryRow, has_janny_recovery: false }), true);
        // Janny-recovered public card stays collectable.
        assert.equal(isDatacatYoursCollectableHit({ ...summaryRow, has_janny_recovery: true }), true);
    });
});

describe('isDatacatYoursSavedHit', () => {
    it('detects DataCat Yours saved state from row flags', () => {
        assert.equal(isDatacatYoursSavedHit({ isCollected: true }), true);
        assert.equal(isDatacatYoursSavedHit({ viewer_is_collected: true }), true);
        assert.equal(isDatacatYoursSavedHit({ collected: true }), true);
        assert.equal(isDatacatYoursSavedHit({ name: 'Not saved' }), false);
    });

    it('lets live CL state override stale row flags', () => {
        assert.equal(isDatacatYoursSavedHit({ isCollected: true }, false), false);
        assert.equal(isDatacatYoursSavedHit({ name: 'Saved after click' }, true), true);
    });
});

describe('buildDatacatYoursCharactersPath', () => {
    it('builds the DataCat Yours list route with pagination, token filter, tags, and added sort', () => {
        assert.equal(
            buildDatacatYoursCharactersPath({
                limit: 80,
                offset: 160,
                minTotalTokens: 889,
                tagIds: [5, 9],
            }),
            '/api/characters?limit=80&offset=160&minTotalTokens=889&tagIds=5%2C9&sort=added',
        );
    });
});
