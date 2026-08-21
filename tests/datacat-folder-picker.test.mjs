import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    filterPickerFolders,
    createDatacatFolderLoader,
    buildPickerModel,
    hasDatacatFolderMembership,
    sortDatacatFoldersByDisplayOrder,
    normalizeDatacatYoursFolderSelection,
    buildDatacatYoursFolderFetchOptions,
    formatDatacatFolderSuccess,
    formatDatacatFolderRemoval,
} from '../modules/providers/datacat/datacat-folder-picker.js';
import { buildDatacatFolderCharactersPath } from '../modules/providers/datacat/datacat-api.js';

describe('filterPickerFolders', () => {
    it('drops reserved/system folders and keeps customs in API order', () => {
        const folders = [
            { id: '1644', title: 'Private Vault', isReserved: true, isPrivateVault: true, systemKey: 'private_vault', displayOrder: -1000 },
            { id: '2359', title: 'marvel smut', isReserved: false, isPrivateVault: false, systemKey: null, displayOrder: 0 },
            { id: '2360', title: 'DC Smut', isReserved: false, isPrivateVault: false, systemKey: null, displayOrder: 1 },
        ];
        assert.deepEqual(filterPickerFolders(folders), [
            { id: '2359', title: 'marvel smut', displayOrder: 0 },
            { id: '2360', title: 'DC Smut', displayOrder: 1 },
        ]);
    });

    it('tolerates junk input', () => {
        assert.deepEqual(filterPickerFolders(null), []);
        assert.deepEqual(filterPickerFolders([{ id: '', title: 'x' }, null, { id: '5' }]), [{ id: '5', title: '', displayOrder: null }]);
    });
});

describe('createDatacatFolderLoader', () => {
    it('shares one request between concurrent loads', async () => {
        let requestCount = 0;
        let resolveRequest;
        const loader = createDatacatFolderLoader(() => {
            requestCount += 1;
            return new Promise(resolve => { resolveRequest = resolve; });
        });

        const first = loader.load();
        const second = loader.load();
        assert.equal(requestCount, 1);

        resolveRequest({
            ok: true,
            folders: [{ id: 12, title: 'Favorites' }],
        });

        assert.deepEqual(await first, [{ id: '12', title: 'Favorites', displayOrder: null }]);
        assert.deepEqual(await second, [{ id: '12', title: 'Favorites', displayOrder: null }]);
        assert.equal(requestCount, 1);
    });

    it('does not retain an empty result as the session cache', async () => {
        let requestCount = 0;
        const loader = createDatacatFolderLoader(async () => {
            requestCount += 1;
            return requestCount === 1
                ? { ok: true, folders: [] }
                : { ok: true, folders: [{ id: 12, title: 'Favorites' }] };
        });

        assert.deepEqual(await loader.load(), []);
        assert.deepEqual(await loader.load(), [{ id: '12', title: 'Favorites', displayOrder: null }]);
        assert.equal(requestCount, 2);
    });

    it('invalidates a populated cache when the account changes', async () => {
        let requestCount = 0;
        const loader = createDatacatFolderLoader(async () => {
            requestCount += 1;
            return {
                ok: true,
                folders: [{ id: requestCount, title: `Account ${requestCount}` }],
            };
        });

        assert.deepEqual(await loader.load(), [{ id: '1', title: 'Account 1', displayOrder: null }]);
        assert.deepEqual(await loader.load(), [{ id: '1', title: 'Account 1', displayOrder: null }]);
        loader.invalidate();
        assert.deepEqual(await loader.load(), [{ id: '2', title: 'Account 2', displayOrder: null }]);
        assert.equal(requestCount, 2);
    });

    it('does not let an invalidated in-flight request overwrite the new cache', async () => {
        const requests = [];
        const loader = createDatacatFolderLoader(() => new Promise(resolve => {
            requests.push(resolve);
        }));

        const oldAccountLoad = loader.load();
        loader.invalidate();
        const newAccountLoad = loader.load();
        assert.equal(requests.length, 2);

        requests[1]({ ok: true, folders: [{ id: 2, title: 'New account' }] });
        assert.deepEqual(await newAccountLoad, [{ id: '2', title: 'New account', displayOrder: null }]);

        requests[0]({ ok: true, folders: [{ id: 1, title: 'Old account' }] });
        assert.deepEqual(await oldAccountLoad, [{ id: '1', title: 'Old account', displayOrder: null }]);
        assert.deepEqual(await loader.load(), [{ id: '2', title: 'New account', displayOrder: null }]);
        assert.equal(requests.length, 2);
    });

    it('allows a later load to recover after a rejected request', async () => {
        let requestCount = 0;
        const loader = createDatacatFolderLoader(async () => {
            requestCount += 1;
            if (requestCount === 1) return { ok: false, error: 'temporary failure' };
            return { ok: true, folders: [{ id: 12, title: 'Favorites' }] };
        });

        await assert.rejects(loader.load(), /temporary failure/);
        assert.deepEqual(await loader.load(), [{ id: '12', title: 'Favorites', displayOrder: null }]);
        assert.equal(requestCount, 2);
    });
});

describe('buildPickerModel', () => {
    it('marks membership with string/number id tolerance', () => {
        const model = buildPickerModel({
            folders: [{ id: '2359', title: 'marvel smut' }, { id: '2360', title: 'DC Smut' }],
            collected: true,
            folderIds: [2359],
        });
        assert.equal(model.collected, true);
        assert.equal(model.mainChecked, false);
        assert.deepEqual(model.rows, [
            { id: '2359', title: 'marvel smut', checked: true },
            { id: '2360', title: 'DC Smut', checked: false },
        ]);
    });

    it('defaults to unchecked on missing status', () => {
        const model = buildPickerModel({ folders: [{ id: '7', title: 'a' }] });
        assert.equal(model.mainChecked, false);
        assert.deepEqual(model.rows, [{ id: '7', title: 'a', checked: false }]);
    });

    it('marks Main only when collected without a custom folder', () => {
        const model = buildPickerModel({
            folders: [{ id: '7', title: 'Custom' }],
            collected: true,
            folderIds: [],
        });
        assert.equal(model.collected, true);
        assert.equal(model.mainChecked, true);
    });
});

describe('hasDatacatFolderMembership', () => {
    it('is active for Main or any custom folder', () => {
        assert.equal(hasDatacatFolderMembership({ collected: true, folderIds: [] }), true);
        assert.equal(hasDatacatFolderMembership({ collected: false, folderIds: [2359] }), true);
        assert.equal(hasDatacatFolderMembership({ collected: false, folderIds: [] }), false);
        assert.equal(hasDatacatFolderMembership(), false);
    });
});
describe('sortDatacatFoldersByDisplayOrder', () => {
    // DataCat v0.97 persists collection order server-side as displayOrder, so CL
    // mirrors it instead of keeping a local override.
    it('sorts ascending by displayOrder regardless of API order', () => {
        const folders = [
            { id: '3883', title: 'misc', displayOrder: 2 },
            { id: '2360', title: 'DC Smut', displayOrder: 1 },
            { id: '2359', title: 'marvel smut', displayOrder: 0 },
        ];
        assert.deepEqual(sortDatacatFoldersByDisplayOrder(folders).map(f => f.id), ['2359', '2360', '3883']);
    });

    it('handles negative order values (system rows sort first)', () => {
        const folders = [
            { id: '2359', title: 'marvel smut', displayOrder: 0 },
            { id: '1644', title: 'Private Vault', displayOrder: -1000 },
        ];
        assert.deepEqual(sortDatacatFoldersByDisplayOrder(folders).map(f => f.id), ['1644', '2359']);
    });

    it('puts folders with no usable displayOrder last, keeping their API order', () => {
        const folders = [
            { id: 'a', title: 'a', displayOrder: null },
            { id: 'b', title: 'b', displayOrder: 5 },
            { id: 'c', title: 'c' },
            { id: 'd', title: 'd', displayOrder: 1 },
        ];
        assert.deepEqual(sortDatacatFoldersByDisplayOrder(folders).map(f => f.id), ['d', 'b', 'a', 'c']);
    });

    it('is stable for equal displayOrder and does not mutate its input', () => {
        const folders = [
            { id: 'x', title: 'x', displayOrder: 1 },
            { id: 'y', title: 'y', displayOrder: 1 },
        ];
        const snapshot = folders.map(f => f.id);
        assert.deepEqual(sortDatacatFoldersByDisplayOrder(folders).map(f => f.id), ['x', 'y']);
        assert.deepEqual(folders.map(f => f.id), snapshot);
    });

    it('tolerates junk input', () => {
        assert.deepEqual(sortDatacatFoldersByDisplayOrder([]), []);
        assert.deepEqual(sortDatacatFoldersByDisplayOrder(null), []);
        assert.deepEqual(sortDatacatFoldersByDisplayOrder(undefined), []);
    });
});

describe('DataCat Yours folder sub-filter helpers', () => {
    const folders = [{ id: '2359' }, { id: '2360' }];

    it('keeps All Yours, Main, and available custom folders', () => {
        assert.equal(normalizeDatacatYoursFolderSelection('all', folders), 'all');
        assert.equal(normalizeDatacatYoursFolderSelection('main', folders), 'main');
        assert.equal(normalizeDatacatYoursFolderSelection(2359, folders), '2359');
    });

    it('falls back to All Yours when a custom folder disappears', () => {
        assert.equal(normalizeDatacatYoursFolderSelection('9999', folders), 'all');
        assert.equal(normalizeDatacatYoursFolderSelection(null, folders), 'all');
    });

    it('routes Main and custom folders through the folder endpoint options', () => {
        const common = { limit: 60, offset: 120, tagIds: ['7'] };
        assert.equal(buildDatacatYoursFolderFetchOptions('all', common), null);
        assert.deepEqual(buildDatacatYoursFolderFetchOptions('main', common), { ...common, folderId: 'main' });
        assert.deepEqual(buildDatacatYoursFolderFetchOptions(2359, common), { ...common, folderId: '2359' });
    });

    it('scopes Main through the folder-character path', () => {
        const common = { limit: 60, offset: 120, tagIds: ['7'] };
        const path = buildDatacatFolderCharactersPath(buildDatacatYoursFolderFetchOptions('main', common));
        const params = new URL(path, 'https://example.test').searchParams;

        assert.equal(params.get('mainOnly'), '1');
        assert.equal(params.has('folderId'), false);
    });
});

describe('DataCat folder notifications', () => {
    it('uses exact destination-aware copy', () => {
        assert.equal(formatDatacatFolderSuccess('WIFE!!!'), 'Saved to "WIFE!!!"');
        assert.equal(formatDatacatFolderSuccess(''), 'Saved to "Main"');
        assert.equal(formatDatacatFolderRemoval('WIFE!!!'), 'Removed from "WIFE!!!"');
        assert.equal(formatDatacatFolderRemoval(''), 'Removed from "Main"');
    });
});
