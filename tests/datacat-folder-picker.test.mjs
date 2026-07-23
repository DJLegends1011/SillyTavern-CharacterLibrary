import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    filterPickerFolders,
    buildPickerModel,
    hasDatacatFolderMembership,
    applyDatacatFolderOrder,
    normalizeDatacatYoursFolderSelection,
    buildDatacatYoursFolderFetchOptions,
} from '../modules/providers/datacat/datacat-folder-picker.js';

describe('filterPickerFolders', () => {
    it('drops reserved/system folders and keeps customs in API order', () => {
        const folders = [
            { id: '1644', title: 'Private Vault', isReserved: true, isPrivateVault: true, systemKey: 'private_vault' },
            { id: '2359', title: 'marvel smut', isReserved: false, isPrivateVault: false, systemKey: null },
            { id: '2360', title: 'DC Smut', isReserved: false, isPrivateVault: false, systemKey: null },
        ];
        assert.deepEqual(filterPickerFolders(folders), [
            { id: '2359', title: 'marvel smut' },
            { id: '2360', title: 'DC Smut' },
        ]);
    });

    it('tolerates junk input', () => {
        assert.deepEqual(filterPickerFolders(null), []);
        assert.deepEqual(filterPickerFolders([{ id: '', title: 'x' }, null, { id: '5' }]), [{ id: '5', title: '' }]);
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
describe('applyDatacatFolderOrder', () => {
    const folders = [
        { id: '2359', title: 'marvel smut' },
        { id: '2360', title: 'DC Smut' },
        { id: '3883', title: 'misc' },
    ];

    it('reorders saved ids first, tolerating string/number mismatch', () => {
        const result = applyDatacatFolderOrder(folders, ['2360', 2359]);
        assert.deepEqual(result, [
            { id: '2360', title: 'DC Smut' },
            { id: '2359', title: 'marvel smut' },
            { id: '3883', title: 'misc' },
        ]);
    });

    it('skips ids that no longer exist and does not duplicate on repeated ids', () => {
        const result = applyDatacatFolderOrder(folders, ['9999', '2360', '2360', '2359']);
        assert.deepEqual(result, [
            { id: '2360', title: 'DC Smut' },
            { id: '2359', title: 'marvel smut' },
            { id: '3883', title: 'misc' },
        ]);
    });

    it('keeps server order unchanged on empty/missing orderIds and does not mutate input', () => {
        const original = [...folders];
        assert.deepEqual(applyDatacatFolderOrder(folders, []), folders);
        assert.deepEqual(applyDatacatFolderOrder(folders, undefined), folders);
        assert.deepEqual(applyDatacatFolderOrder(folders, null), folders);
        assert.deepEqual(folders, original); // input array not mutated

        assert.deepEqual(applyDatacatFolderOrder([], ['1']), []);
        assert.deepEqual(applyDatacatFolderOrder(null, ['1']), []);
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
        assert.deepEqual(buildDatacatYoursFolderFetchOptions('main', common), { ...common, mainOnly: true });
        assert.deepEqual(buildDatacatYoursFolderFetchOptions(2359, common), { ...common, folderId: '2359' });
    });
});
