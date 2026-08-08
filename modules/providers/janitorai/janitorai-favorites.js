export function normalizeJanitoraiId(value) {
    return value == null ? '' : String(value).trim().toLowerCase();
}

export function chooseJanitoraiSource({ favorites } = {}) {
    return favorites ? 'favorites' : 'hampter';
}

export function shouldRetainJanitoraiFavoriteResults({ source, code, waitingRoom = false } = {}) {
    return source === 'favorites'
        && (waitingRoom || code === 'HAMPTER_RATE_LIMITED' || code === 'HAMPTER_BLOCKED');
}

export function isJanitoraiFavoriteAuthError(code) {
    return code === 'HAMPTER_LOGIN_REQUIRED' || code === 'HAMPTER_TOKEN_EXPIRED';
}

export function emptyJanitoraiFavoriteBrowseState() {
    return {
        characters: [],
        favoritesPage: 1,
        favoritesHasMore: true,
        hasMore: true,
        totalPages: 0,
        rendered: 0,
    };
}

export function matchesJanitoraiFavoriteCreator(hit, creator) {
    return !creator?.id || normalizeJanitoraiId(hit?.creator_id) === normalizeJanitoraiId(creator.id);
}

export function readPath(root, path) {
    return (path || []).reduce((value, key) => value == null ? undefined : value[key], root);
}

export function extractFavoriteSeed(root, paths) {
    const out = new Set();
    for (const path of paths || []) {
        const value = readPath(root, path);
        const rows = Array.isArray(value) ? value : [];
        for (const row of rows) {
            const id = normalizeJanitoraiId(typeof row === 'object' ? (row?.id ?? row?.character_id) : row);
            if (id) out.add(id);
        }
    }
    return [...out];
}

export function normalizeFavoriteState(payload, { statePath, countPath } = {}) {
    const favorited = readPath(payload, statePath || []);
    if (typeof favorited !== 'boolean') return null;
    const rawCount = countPath?.length ? readPath(payload, countPath) : null;
    const count = rawCount === null || rawCount === undefined || rawCount === ''
        ? null
        : (Number.isFinite(Number(rawCount)) ? Math.max(0, Number(rawCount)) : null);
    return { favorited, count };
}

/** Builds the account-only favorites listing path accepted by JanitorAI's character API. */
export function buildJanitoraiFavoritesPath({ page = 1, mode = 'all', sort = 'latest', search = '', tagIds = [] } = {}) {
    const params = new URLSearchParams({ page: String(page), favorites: 'true', mode, sort });
    if (search) params.set('search', search);
    for (const id of tagIds) params.append('tag_id[]', String(id));
    return `/characters?${params}`;
}

/** Normalizes page metadata from the favorites listing without trusting optional server fields. */
export function normalizeFavoritePageMeta(payload, requestedPage, fallbackSize) {
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const page = Number(payload?.page) || requestedPage;
    const pageSize = Number(payload?.size) || fallbackSize;
    const total = Number(payload?.total) || 0;
    return {
        total,
        page,
        pageSize,
        hasMore: total > 0 ? page * pageSize < total : rows.length === pageSize,
    };
}

export function isJanitoraiLoadCurrent({ capturedToken, currentToken, capturedSource, currentSource, active }) {
    return !!active && capturedToken === currentToken && capturedSource === currentSource;
}

export function isJanitoraiSelectionCurrent({ capturedToken, currentToken, capturedId, selectedId }) {
    return capturedToken === currentToken && normalizeJanitoraiId(capturedId) === normalizeJanitoraiId(selectedId);
}

export class JanitoraiFavoriteCache {
    constructor() { this.clear(); }

    clear(identity = '') {
        this.identity = String(identity || '');
        this.ids = new Set();
        this.negativeIds = new Set();
        this.complete = false;
        this.loadedAt = 0;
    }

    syncIdentity(identity) {
        const next = String(identity || '');
        if (next === this.identity) return false;
        this.clear(next);
        return true;
    }

    seed(ids) {
        for (const value of ids || []) {
            const id = normalizeJanitoraiId(value);
            if (id) {
                this.ids.add(id);
                this.negativeIds.delete(id);
            }
        }
    }

    replace(ids, loadedAt = Date.now()) {
        this.ids.clear();
        this.negativeIds.clear();
        this.seed(ids);
        this.complete = true;
        this.loadedAt = loadedAt;
    }

    get(value) {
        const id = normalizeJanitoraiId(value);
        if (!id) return undefined;
        if (this.ids.has(id)) return true;
        if (this.negativeIds.has(id)) return false;
        return this.complete ? false : undefined;
    }

    set(value, favorited) {
        const id = normalizeJanitoraiId(value);
        if (!id) return;
        if (favorited) {
            this.ids.add(id);
            this.negativeIds.delete(id);
        } else {
            this.ids.delete(id);
            this.negativeIds.add(id);
        }
    }
}
