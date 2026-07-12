import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    filterPickerFolders,
    buildPickerModel,
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
        assert.equal(model.mainChecked, true);
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
});
