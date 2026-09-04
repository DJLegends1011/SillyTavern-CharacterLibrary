const JANITOR_UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function normalizeUuid(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return JANITOR_UUID_RE.test(normalized) ? normalized : null;
}

export function scanJannyMigrationRows(characters, {
    extensionsReady = () => true,
    getName = char => char?.name || char?.avatar || 'Unknown',
} = {}) {
    const rows = [];
    let notChecked = 0;

    for (const char of characters || []) {
        if (!extensionsReady(char)) {
            notChecked++;
            continue;
        }
        const janny = char?.data?.extensions?.jannyai;
        if (!janny?.id) continue;

        const resolved = normalizeUuid(janny.id);
        const existingRaw = char?.data?.extensions?.janitorai?.id;
        const existing = existingRaw ? (normalizeUuid(existingRaw) || String(existingRaw).trim()) : null;
        let bucket = 'unresolvable';
        if (resolved && existing) bucket = existing !== resolved ? 'conflict' : 'already';
        else if (resolved) bucket = 'ready';

        rows.push({
            avatar: char.avatar,
            name: getName(char) || char.name || char.avatar,
            bucket,
            resolved,
            existing,
            existingNamespace: char?.data?.extensions?.janitorai || null,
            locked: !!char?.data?.extensions?.update_locked,
            pageName: janny.pageName || null,
            tagline: janny.tagline || null,
        });
    }

    return { rows, notChecked };
}

/**
 * Verify and migrate one JannyAI link to the first-party JanitorAI namespace.
 * External reads and writes are injected so the decision logic stays testable.
 */
export async function migrateJannyRow(row, {
    verify,
    write,
    read,
    signal,
    now = () => new Date().toISOString(),
    removeSource = false,
    deleteValue = null,
}) {
    const resolved = normalizeUuid(row?.resolved);
    if (!row || !['ready', 'already'].includes(row.bucket) || !resolved) {
        return { status: 'not-actionable' };
    }
    if (signal?.aborted) return { status: 'cancelled' };

    let detail;
    try {
        detail = await verify(resolved, { signal });
    } catch (error) {
        if (signal?.aborted) return { status: 'cancelled' };
        return { status: 'unverified', error };
    }
    if (signal?.aborted) return { status: 'cancelled' };
    if (detail === null) return { status: 'missing' };
    const verifiedId = normalizeUuid(detail?.id || detail?.character_id);
    if (verifiedId !== resolved) {
        return { status: 'identity-mismatch' };
    }

    // The modal scan is only a preview. Re-read immediately before writing so a
    // slow verification pass cannot overwrite links edited after the modal opened.
    const live = typeof read === 'function' ? read(row.avatar) : null;
    const liveExtensions = live?.data?.extensions || live?.extensions || null;
    if (typeof read === 'function') {
        if (normalizeUuid(liveExtensions?.jannyai?.id) !== resolved) {
            return { status: 'stale-source' };
        }
        const liveJanitorRaw = liveExtensions?.janitorai?.id;
        if (liveJanitorRaw && normalizeUuid(liveJanitorRaw) !== resolved) {
            return { status: 'stale-conflict' };
        }
    }
    if (signal?.aborted) return { status: 'cancelled' };

    const existing = liveExtensions?.janitorai
        || (typeof read !== 'function' ? row.existingNamespace : null)
        || null;
    const destinationExists = normalizeUuid(existing?.id) === resolved;
    const pageName = typeof detail?.name === 'string' && detail.name.trim()
        ? detail.name
        : row.pageName;
    const sourceTagline = typeof detail?.description === 'string' && detail.description.trim()
        ? detail.description
        : (typeof detail?.tagline === 'string' && detail.tagline.trim() ? detail.tagline : row.tagline);
    const updates = {};
    if (!destinationExists) {
        updates['extensions.janitorai.id'] = resolved;
        updates['extensions.janitorai.linkedAt'] = now();
    }
    if (!existing?.pageName && pageName) updates['extensions.janitorai.pageName'] = pageName;
    if (!existing?.tagline && sourceTagline) updates['extensions.janitorai.tagline'] = sourceTagline;
    if (removeSource) updates['extensions.jannyai'] = deleteValue;

    if (Object.keys(updates).length === 0) return { status: 'already' };
    if (signal?.aborted) return { status: 'cancelled' };

    const ok = await write(row.avatar, updates);
    if (!ok) return { status: 'write-failed' };
    if (destinationExists) return { status: removeSource ? 'cleaned' : 'already' };
    return { status: 'migrated' };
}
