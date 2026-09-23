// DataCat Community Collections -- pure helpers (no DOM, no network)
//
// The feed (/api/community/curations) returns every published collection in one
// response and ignores sort/limit/offset, so sorting and filtering happen here.
// A collection's detail payload caps its rich character rows at 240; the
// cart-items endpoint lists every member but in a slim shape with no avatar.

export const COMMUNITY_SORT_OPTIONS = [
    { value: 'featured', label: 'Featured' },
    { value: 'updated', label: 'Recently Updated' },
    { value: 'newest', label: 'Newest' },
    { value: 'largest', label: 'Most Characters' },
    { value: 'name_asc', label: 'Name A-Z' },
];

const COMMUNITY_SORT_ICONS = {
    featured: '⭐',
    updated: '🔄',
    newest: '🆕',
    largest: '📚',
    name_asc: '📝',
};

export function buildCommunitySortOptionsHtml(selected) {
    return COMMUNITY_SORT_OPTIONS.map(o =>
        `<option value="${o.value}"${o.value === selected ? ' selected' : ''}>${COMMUNITY_SORT_ICONS[o.value] || ''} ${o.label}</option>`,
    ).join('');
}

const timeOf = (raw) => {
    const t = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(t) ? t : 0;
};

const COMPARATORS = {
    featured: (a, b) => (Number(a.position) || Infinity) - (Number(b.position) || Infinity),
    updated: (a, b) => timeOf(b.updatedAt || b.createdAt) - timeOf(a.updatedAt || a.createdAt),
    newest: (a, b) => timeOf(b.createdAt) - timeOf(a.createdAt),
    largest: (a, b) => (Number(b.characterCount) || 0) - (Number(a.characterCount) || 0),
    name_asc: (a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' }),
};

export function sortCommunityCollections(list, mode) {
    const compare = COMPARATORS[mode] || COMPARATORS.featured;
    return [...(Array.isArray(list) ? list : [])].sort(compare);
}

/**
 * Empty collections are always dropped. SFW mode hides a collection only when
 * every character in it is mature -- mixed collections stay, and their NSFW
 * cards are filtered inside the detail view like everywhere else.
 */
export function filterCommunityCollections(list, { nsfwEnabled = false, query = '' } = {}) {
    if (!Array.isArray(list)) return [];
    const needle = String(query || '').trim().toLowerCase();
    return list.filter(c => {
        const count = Number(c?.characterCount) || 0;
        if (count <= 0) return false;
        if (!nsfwEnabled && (Number(c.matureCharacterCount) || 0) >= count) return false;
        if (!needle) return true;
        const haystack = [
            c.title,
            c.description,
            c.curator?.username,
            c.curator?.displayName,
            ...(Array.isArray(c.tags) ? c.tags.map(t => t?.name) : []),
        ].filter(Boolean).join('\n').toLowerCase();
        return haystack.includes(needle);
    });
}

const rowId = (row) => row?.characterId || row?.character_id || row?.id || '';

/**
 * Rich detail rows first (in collection order), then any cart-items rows past
 * the detail cap. Slim rows are flagged so the grid knows they carry no avatar.
 */
export function mergeCommunityCharacters(richRows, slimRows) {
    const seen = new Set();
    const merged = [];
    for (const row of Array.isArray(richRows) ? richRows : []) {
        const id = rowId(row);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push(row);
    }
    for (const row of Array.isArray(slimRows) ? slimRows : []) {
        const id = rowId(row);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push({ ...row, _communitySlim: true });
    }
    return merged;
}

/** An older cl-helper rejects community paths at its proxy allowlist. */
export function isCommunityProxyBlocked(status, body) {
    return status === 403 && body?.error === 'Proxy path not allowed';
}
