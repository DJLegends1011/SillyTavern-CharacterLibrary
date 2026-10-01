/**
 * Restore the collection's membership order after fetching character details, which can arrive
 * in a different order. Never sort by name/date or shuffle. Unlisted characters retain
 * their relative order at the end; without member ids, preserve the supplied member order.
 * Returns a separate array so cached API results are not mutated.
 */
export function orderJannyCollectionCharacters(characters, ids = []) {
    const ordered = Array.isArray(characters) ? [...characters] : [];
    const ranks = new Map();
    for (const id of ids) {
        const key = String(id);
        if (!ranks.has(key)) ranks.set(key, ranks.size);
    }
    const rank = character => ranks.get(String(character?.id)) ?? ranks.size;
    return ordered.sort((a, b) => rank(a) - rank(b));
}
