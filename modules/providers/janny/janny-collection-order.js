/**
 * Return a display-only copy of a collection's characters.
 * Default keeps JannyAI's own order (the order the collection page lists them). Random mode
 * uses Fisher-Yates so each explicit collection reload can produce a fresh order without
 * mutating cached API data.
 */
export function orderJannyCollectionCharacters(characters, { randomize = false, random = Math.random } = {}) {
    const ordered = Array.isArray(characters) ? [...characters] : [];
    if (!randomize) return ordered;
    for (let i = ordered.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    }
    return ordered;
}

/**
 * Put fetched characters back in the order of `ids`. /api/get-characters answers in its own
 * order, so a collection page's character order only survives if it is re-applied here.
 * Characters the ids don't mention keep their relative order at the end.
 */
export function orderByIds(characters, ids) {
    const rank = new Map((Array.isArray(ids) ? ids : []).map((id, i) => [String(id), i]));
    const list = Array.isArray(characters) ? characters : [];
    return list
        .map((c, i) => ({ c, i, r: rank.has(String(c?.id)) ? rank.get(String(c.id)) : Infinity }))
        .sort((a, b) => (a.r - b.r) || (a.i - b.i))
        .map(x => x.c);
}
