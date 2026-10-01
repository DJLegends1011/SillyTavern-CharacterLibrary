// Pure JannyAI collection model helpers: no DOM, no CoreAPI, so both the browse view and
// Node tests can import them directly.

export const COLLECTION_COVER_LIMIT = 4;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const CHARACTER_URL_RE = new RegExp(`/characters/(${UUID})(?:_[^/?#\\s]+)?`, 'i');
const CHARACTER_ID_RE = new RegExp(`^(${UUID})$`, 'i');
const AVATAR_KEYS = ['avatar', 'avatarUrl', 'image', 'imageUrl', 'image_url', 'botAvatar', 'profilePicture', 'profile_picture'];
const COVER_POOLS = ['coverCharacters', 'images', 'previewImages', 'previewCharacters', 'collectionCharacters', 'characters', 'members'];

function unwrapCharacter(item) {
    const raw = item?.character || item?.characters || item;
    return raw?.character || raw;
}

function avatarOf(item) {
    if (typeof item === 'string') return item;
    const c = unwrapCharacter(item);
    for (const source of [c, item?.character || item?.characters, item]) {
        for (const key of AVATAR_KEYS) {
            if (source?.[key]) return source[key];
        }
    }
    return '';
}

/**
 * Collection and bookmark endpoints return characters bare or inside relation wrappers;
 * flatten either into the shape the Janny browse card expects.
 */
export function normalizeJannyCharacter(item) {
    const c = unwrapCharacter(item);
    if (!c) return null;
    const id = c.id || c.characterId || c.character_id || item?.characterId || item?.character_id || '';
    if (!id) return null;
    return {
        ...c,
        id,
        name: c.name || c.title || 'Unknown',
        avatar: avatarOf(c),
        description: c.description || c.creatorNotes || c.tagline || '',
        tagIds: c.tagIds || c.tag_ids || [],
        totalToken: c.totalToken || c.total_tokens || c.token_counts?.total_tokens || 0,
        creatorUsername: c.creatorUsername || c.creator_username || c.user?.username || c.creator?.username || '',
    };
}

/** The collection's embedded member list, when the endpoint included one. */
export function embeddedEntries(collection) {
    if (Array.isArray(collection?.collectionCharacters)) return collection.collectionCharacters;
    if (Array.isArray(collection?.characters)) return collection.characters;
    return null;
}

/** Number of characters in a collection, or null when the listing didn't say. */
export function collectionCount(collection) {
    const entries = embeddedEntries(collection);
    if (entries) return entries.length;
    const raw = collection?.characterCount ?? collection?._count?.collectionCharacters;
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

export function isCollectionPrivate(collection) {
    const raw = collection?.isPrivate ?? collection?.private ?? collection?.is_private;
    if (raw === undefined || raw === null || raw === '') return false;
    if (typeof raw === 'boolean') return raw;
    return ['true', 'yes', '1', 'private'].includes(String(raw).toLowerCase());
}

/** Up to `limit` distinct cover image sources, from whichever pool the listing filled. */
export function collectionCoverSources(collection, limit = COLLECTION_COVER_LIMIT) {
    const out = [];
    for (const key of COVER_POOLS) {
        const pool = collection?.[key];
        if (!Array.isArray(pool)) continue;
        for (const item of pool) {
            const src = avatarOf(item);
            if (src && !out.includes(src)) out.push(src);
            if (out.length >= limit) return out;
        }
    }
    return out;
}

/** A character UUID from a pasted JannyAI character URL or a bare id, else ''. */
export function parseJannyCharacterId(value) {
    const text = String(value || '').trim();
    const match = text.match(CHARACTER_URL_RE) || text.match(CHARACTER_ID_RE);
    return match ? match[1] : '';
}

