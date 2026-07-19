/**
 * Janny collection endpoints have returned both direct characters and relation
 * wrappers such as { character: { character: { id } } }. Walk the known
 * wrapper keys so every collection surface agrees about membership.
 */
export function collectionEntryCharacterId(entry) {
    if (typeof entry === 'string') return entry;
    let current = entry;
    for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
        const id = current.id || current.characterId || current.character_id;
        if (id) return String(id);
        const nested = current.character || current.characters;
        if (!nested || nested === current) break;
        current = nested;
    }
    return '';
}

export function collectionEntryMatchesCharacter(entry, characterId) {
    const id = collectionEntryCharacterId(entry);
    return !!id && id === String(characterId || '');
}
