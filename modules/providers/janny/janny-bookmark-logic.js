// Pure, dependency-free bookmark cap + set logic for JannyAI account sync.
// Kept separate so it is unit-testable under `node --test` without a DOM.

export const JANNY_BOOKMARK_CAP_DEFAULT = 220;

/** Resolve the effective cap from CL settings, clamped to >= 1. */
export function capForSettings(getSetting) {
    const raw = getSetting?.('jannyBookmarkCap');

    // If not set (undefined), use default
    if (raw === undefined) {
        return JANNY_BOOKMARK_CAP_DEFAULT;
    }

    // If set to something, parse it and clamp to >= 1
    const cap = Number(raw);
    if (!Number.isFinite(cap)) {
        return JANNY_BOOKMARK_CAP_DEFAULT;
    }

    return Math.max(1, Math.floor(cap));
}

/** Can we add `addCount` bookmarks without exceeding `cap`? */
export function canAddBookmarks(currentCount, addCount, cap) {
    const headroom = Math.max(0, cap - currentCount);
    if (addCount <= headroom) return { ok: true, allowed: addCount };
    return {
        ok: false,
        allowed: headroom,
        reason: `JannyAI bookmark cap (${cap}) reached; its bookmark page breaks past this. Remove some first.`,
    };
}

/** Mutate `set`: add ids when added=true, delete when added=false. */
export function reconcileBookmarkSet(set, ids, added) {
    for (const id of ids) {
        if (added) set.add(id);
        else set.delete(id);
    }
}
