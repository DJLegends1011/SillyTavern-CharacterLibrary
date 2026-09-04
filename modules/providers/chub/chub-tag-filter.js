// Chub search returns (and filters against) at most 15 topics. Details contain
// the full list. Keep only topics in this bounded cache, never card definitions.
const SEARCH_TOPIC_LIMIT = 15;
const CACHE_MAX = 256;
const CACHE_TTL = 5 * 60 * 1000;
const CONCURRENCY = 4;

const normalize = tag => tag.trim().toLowerCase();
const validTopics = topics => Array.isArray(topics) && topics.every(tag => typeof tag === 'string');

/** fetchTopics(fullPath, signal) must return the complete topics array or throw. */
export function createChubTagFilter(fetchTopics) {
    const cache = new Map();

    return {
        clear() { cache.clear(); },

        async filter(characters, excludedTags, { signal } = {}) {
            signal?.throwIfAborted();
            const excluded = new Set(excludedTags.filter(tag => typeof tag === 'string').map(normalize).filter(Boolean));
            if (!excluded.size) return { characters, uncheckedCount: 0 };

            const matches = topics => topics.some(tag => excluded.has(normalize(tag)));
            const pending = new Map();
            const results = new Array(characters.length);
            let nextIndex = 0;
            let uncheckedCount = 0;

            const fullTopics = (character) => {
                const path = (character.fullPath || character.full_path || '').replace(/^characters\//, '');
                if (!path) throw new Error('Missing character path');
                const key = path.toLowerCase();
                const revision = character.lastActivityAt || character.last_activity_at || '';
                const cached = cache.get(key);
                if (cached && cached.revision === revision && Date.now() - cached.time < CACHE_TTL) {
                    cache.delete(key);
                    cache.set(key, cached);
                    return cached.topics;
                }
                if (!pending.has(key)) {
                    pending.set(key, (async () => {
                        const topics = await fetchTopics(path, signal);
                        signal?.throwIfAborted();
                        if (!validTopics(topics)) throw new Error('Missing full character tags');
                        cache.delete(key);
                        cache.set(key, { topics, revision, time: Date.now() });
                        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
                        return topics;
                    })());
                }
                return pending.get(key);
            };

            const worker = async () => {
                while (nextIndex < characters.length) {
                    signal?.throwIfAborted();
                    const index = nextIndex++;
                    const character = characters[index];
                    let topics = character.topics;
                    if (validTopics(topics) && matches(topics)) continue;
                    // Fewer than 15 topics are complete; more than 15 already came
                    // from a full-data endpoint. Exactly 15 may have been truncated.
                    if (!validTopics(topics) || topics.length === SEARCH_TOPIC_LIMIT) {
                        try {
                            topics = await fullTopics(character);
                        } catch (error) {
                            signal?.throwIfAborted();
                            if (error.name === 'AbortError') throw error;
                            // Never show an unverified card as though it passed the filter.
                            // Do not cache failures, so refresh can retry them.
                            uncheckedCount++;
                            continue;
                        }
                    }
                    signal?.throwIfAborted();
                    if (!matches(topics)) results[index] = { ...character, topics };
                }
            };
            await Promise.all(Array.from({ length: Math.min(CONCURRENCY, characters.length) }, worker));
            return { characters: results.filter(Boolean), uncheckedCount };
        },
    };
}
