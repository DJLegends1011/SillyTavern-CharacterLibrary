export const JANITORAI_MEILI_SORT = 'meili_latest';

function finiteNumber(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function buildJanitoraiMeiliRequest({
    search = '', page = 1, limit = 80, nsfwEnabled = false, includeTagIds = [],
} = {}) {
    const filters = [];
    if (!nsfwEnabled) filters.push('isNsfw = false');
    if (includeTagIds.length) filters.push(includeTagIds.map(id => `tagIds = ${Number(id)}`).join(' AND '));
    return {
        search,
        page,
        limit,
        filters,
        facets: ['isNsfw', 'tagIds'],
        sort: ['createdAtStamp:desc'],
        highlight: true,
    };
}

export function normalizeJanitoraiMeiliHit(hit, { imageBase = '', resolveTagNames = () => [] } = {}) {
    const ids = Array.isArray(hit?.tagIds) ? hit.tagIds.map(Number).filter(Number.isFinite) : [];
    const names = resolveTagNames(ids);
    const created = hit?.createdAt || (hit?.createdAtStamp ? new Date(Number(hit.createdAtStamp) * 1000).toISOString() : '');
    const avatar = hit?.avatar && !/^https?:\/\//i.test(hit.avatar) ? `${imageBase}${hit.avatar}` : (hit?.avatar || '');
    return {
        character_id: hit?.id || '',
        name: hit?.name || 'Unknown',
        avatar,
        description: hit?.description || '',
        creator_name: hit?.creatorUsername || hit?.creatorName || hit?.creatorId || '',
        creator_id: hit?.creatorId || '',
        tags: ids.map((id, index) => {
            const name = names[index] || `Tag ${id}`;
            return { id, name, slug: String(name).toLowerCase().replace(/\s+/g, '-') };
        }),
        created_at: created,
        is_nsfw: !!hit?.isNsfw,
        total_tokens: finiteNumber(hit?.totalToken),
        chat_count: 0,
        message_count: 0,
        _listingSource: 'meili',
    };
}

export function normalizeJanitoraiMeiliPage(response, deps = {}) {
    const result = response?.results?.[0] || {};
    const excluded = new Set((deps.excludeTagIds || []).map(Number));
    const hits = (result.hits || []).filter(hit => !(hit.tagIds || []).some(id => excluded.has(Number(id))));
    const page = Number(result.page) || 1;
    const totalPages = Number(result.totalPages) || 1;
    return {
        characters: hits.map(hit => normalizeJanitoraiMeiliHit(hit, deps)),
        page,
        totalPages,
        hasMore: page < totalPages,
    };
}
