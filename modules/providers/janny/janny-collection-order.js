function characterCreatedAtMs(character) {
    const rawStamp = Number(character?.createdAtStamp ?? character?.created_at_stamp);
    if (Number.isFinite(rawStamp) && rawStamp > 0) {
        return rawStamp > 1e12 ? rawStamp : rawStamp * 1000;
    }

    const rawDate = character?.createdAt ?? character?.created_at ?? character?.publishedAt ?? character?.published_at;
    const parsed = rawDate ? Date.parse(rawDate) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
}

function stableCharacterKey(character) {
    return `${String(character?.name || '').trim().toLocaleLowerCase()}\u0000${String(character?.id || '')}`;
}

/**
 * Return a display-only copy of a collection's characters.
 * Default order is newest character first. Random mode uses Fisher-Yates so
 * each explicit collection reload can produce a fresh order without mutating
 * cached API data.
 */
export function orderJannyCollectionCharacters(characters, { randomize = false, random = Math.random } = {}) {
    const ordered = Array.isArray(characters) ? [...characters] : [];
    if (randomize) {
        for (let i = ordered.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
        }
        return ordered;
    }

    return ordered.sort((a, b) => {
        const dateDelta = characterCreatedAtMs(b) - characterCreatedAtMs(a);
        if (dateDelta) return dateDelta;
        return stableCharacterKey(a).localeCompare(stableCharacterKey(b));
    });
}
