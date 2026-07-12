// DataCat folder picker - "Save to folder" dropdown for the preview modal.
// Pure model helpers here are unit-tested; the DOM component follows in this file.

/**
 * Keep only user-created folders. DataCat mixes reserved/system folders
 * (e.g. the Private Vault) into /api/user-folders; the site's own picker
 * hides them and so do we.
 * @param {Array} folders raw folders from fetchDatacatFolders()
 * @returns {{id: string, title: string}[]}
 */
export function filterPickerFolders(folders) {
    if (!Array.isArray(folders)) return [];
    return folders
        .filter(f => f && !f.isReserved && !f.isPrivateVault && !f.systemKey)
        .map(f => ({ id: String(f.id ?? '').trim(), title: String(f.title ?? '') }))
        .filter(f => f.id);
}

/**
 * Build the render model from the folder list + membership status.
 * @param {{folders?: Array, collected?: boolean, folderIds?: Array}} opts
 * @returns {{mainChecked: boolean, rows: {id: string, title: string, checked: boolean}[]}}
 */
export function buildPickerModel({ folders = [], collected = false, folderIds = [] } = {}) {
    const memberIds = new Set((Array.isArray(folderIds) ? folderIds : []).map(v => String(v)));
    return {
        mainChecked: collected === true,
        rows: folders.map(f => ({ id: f.id, title: f.title, checked: memberIds.has(String(f.id)) })),
    };
}
