import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    COMMUNITY_SORT_OPTIONS,
    sortCommunityCollections,
    filterCommunityCollections,
    mergeCommunityCharacters,
    isCommunityProxyBlocked,
} from '../modules/providers/datacat/datacat-community.js';

const col = (over = {}) => ({
    slug: 'curation-x',
    title: 'Untitled',
    description: '',
    position: 1,
    characterCount: 10,
    matureCharacterCount: 0,
    containsMatureContent: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    curator: { username: 'someone' },
    tags: [],
    ...over,
});

describe('sortCommunityCollections', () => {
    const list = [
        col({ slug: 'a', title: 'beta', position: 2, characterCount: 5, createdAt: '2026-03-01', updatedAt: '2026-01-05' }),
        col({ slug: 'b', title: 'Alpha', position: 3, characterCount: 50, createdAt: '2026-01-01', updatedAt: '2026-09-01' }),
        col({ slug: 'c', title: 'gamma', position: 1, characterCount: 20, createdAt: '2026-02-01', updatedAt: '2026-02-01' }),
    ];
    const slugs = (mode) => sortCommunityCollections(list, mode).map(c => c.slug);

    it('featured follows DataCat position order', () => assert.deepEqual(slugs('featured'), ['c', 'a', 'b']));
    it('updated puts the most recently updated first', () => assert.deepEqual(slugs('updated'), ['b', 'c', 'a']));
    it('newest puts the most recently created first', () => assert.deepEqual(slugs('newest'), ['a', 'c', 'b']));
    it('largest sorts by character count', () => assert.deepEqual(slugs('largest'), ['b', 'c', 'a']));
    it('name_asc is case-insensitive', () => assert.deepEqual(slugs('name_asc'), ['b', 'a', 'c']));
    it('unknown modes fall back to featured', () => assert.deepEqual(slugs('bogus'), ['c', 'a', 'b']));
    it('does not mutate its input', () => {
        const before = list.map(c => c.slug);
        sortCommunityCollections(list, 'largest');
        assert.deepEqual(list.map(c => c.slug), before);
    });
    it('every advertised option is a real mode', () => {
        for (const { value } of COMMUNITY_SORT_OPTIONS) {
            assert.equal(sortCommunityCollections(list, value).length, 3);
        }
    });
});

describe('filterCommunityCollections', () => {
    const list = [
        col({ slug: 'empty', characterCount: 0 }),
        col({ slug: 'sfw', title: 'Cozy Fantasy', characterCount: 4 }),
        col({ slug: 'mixed', characterCount: 10, matureCharacterCount: 3, containsMatureContent: true }),
        col({ slug: 'mature', characterCount: 8, matureCharacterCount: 8, containsMatureContent: true,
            curator: { username: 'NightOwl' }, tags: [{ name: 'Smut' }] }),
    ];
    const slugs = (opts) => filterCommunityCollections(list, opts).map(c => c.slug);

    it('always drops empty collections', () => {
        assert.deepEqual(slugs({ nsfwEnabled: true }), ['sfw', 'mixed', 'mature']);
    });
    it('SFW mode hides only collections with nothing SFW inside', () => {
        assert.deepEqual(slugs({ nsfwEnabled: false }), ['sfw', 'mixed']);
    });
    it('query matches title, curator and tag names case-insensitively', () => {
        assert.deepEqual(slugs({ nsfwEnabled: true, query: 'cozy' }), ['sfw']);
        assert.deepEqual(slugs({ nsfwEnabled: true, query: 'nightowl' }), ['mature']);
        assert.deepEqual(slugs({ nsfwEnabled: true, query: 'SMUT' }), ['mature']);
    });
    it('a blank query matches everything', () => {
        assert.deepEqual(slugs({ nsfwEnabled: true, query: '   ' }), ['sfw', 'mixed', 'mature']);
    });
    it('tolerates a missing list', () => {
        assert.deepEqual(filterCommunityCollections(null, {}), []);
    });
});

describe('mergeCommunityCharacters', () => {
    it('keeps rich rows in order and appends only the slim rows past the cap', () => {
        const rich = [{ characterId: 'a', name: 'A' }, { characterId: 'b', name: 'B' }];
        const slim = [
            { characterId: 'a', name: 'A slim' },
            { characterId: 'b', name: 'B slim' },
            { characterId: 'c', name: 'C', avatar: null },
        ];
        const merged = mergeCommunityCharacters(rich, slim);
        assert.deepEqual(merged.map(c => c.characterId), ['a', 'b', 'c']);
        assert.equal(merged[0].name, 'A');
        assert.equal(merged[0]._communitySlim, undefined);
        assert.equal(merged[2]._communitySlim, true);
    });
    it('dedupes rows that repeat within the slim list', () => {
        const merged = mergeCommunityCharacters([], [{ characterId: 'x' }, { characterId: 'x' }]);
        assert.equal(merged.length, 1);
    });
    it('skips rows with no id and tolerates missing inputs', () => {
        assert.deepEqual(mergeCommunityCharacters(null, [{ name: 'no id' }]), []);
        assert.deepEqual(mergeCommunityCharacters([{ characterId: 'a' }], null).map(c => c.characterId), ['a']);
    });
});

describe('isCommunityProxyBlocked', () => {
    it('recognizes an outdated cl-helper allowlist rejection', () => {
        assert.equal(isCommunityProxyBlocked(403, { error: 'Proxy path not allowed' }), true);
    });
    it('does not flag DataCat-side 403s or other statuses', () => {
        assert.equal(isCommunityProxyBlocked(403, { error: 'Forbidden' }), false);
        assert.equal(isCommunityProxyBlocked(404, { error: 'Proxy path not allowed' }), false);
        assert.equal(isCommunityProxyBlocked(403, null), false);
    });
});
