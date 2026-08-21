export const JANITORAI_MEILI_SORT = 'meili_latest';

function finiteNumber(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function positiveInteger(value, fallback = 1) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function createdAtIso(hit) {
    if (typeof hit?.createdAt === 'string' && !Number.isNaN(Date.parse(hit.createdAt))) {
        return hit.createdAt;
    }
    const rawStamp = hit?.createdAtStamp;
    if (rawStamp === null || rawStamp === undefined || rawStamp === '') return '';
    const stamp = Number(rawStamp);
    if (!Number.isFinite(stamp)) return '';
    const date = new Date(stamp * 1000);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
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
    const created = createdAtIso(hit);
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
    const result = Array.isArray(response?.results) ? (response.results[0] || {}) : {};
    const excluded = new Set((deps.excludeTagIds || []).map(Number));
    const sourceHits = Array.isArray(result.hits) ? result.hits : [];
    const hits = sourceHits.filter(hit => hit && String(hit.id || '').trim()
        && !(Array.isArray(hit.tagIds) ? hit.tagIds : []).some(id => excluded.has(Number(id))));
    const page = positiveInteger(result.page);
    const totalPages = positiveInteger(result.totalPages);
    return {
        characters: hits.map(hit => normalizeJanitoraiMeiliHit(hit, deps)),
        page,
        totalPages,
        hasMore: page < totalPages,
    };
}
