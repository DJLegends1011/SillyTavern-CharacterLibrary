import * as CoreAPI from './core-api.js';

const debugLog = (...args) => {
    if (CoreAPI.getSetting?.('debugMode')) {
        console.log(...args);
    }
};

let isInitialized = false;
let tagCounts = new Map();       // exact tag name -> carrier count
let activeTab = 'library';
let runInProgress = false;
let runAborted = false;
let showingDupes = false;
let sortMode = 'name';           // 'name' | 'count'

// ========================================
// TAG INDEX
// ========================================

function buildTagIndex() {
    const counts = new Map();
    for (const char of CoreAPI.getAllCharacters() || []) {
        const tags = CoreAPI.getCharacterTags(char);
        const seen = new Set();
        for (const raw of tags) {
            // EXACT stored form: a trimmed key counts carriers the grid jump then cant find.
            const name = asTagName(raw);
            if (!name.trim() || seen.has(name)) continue;
            seen.add(name);
            counts.set(name, (counts.get(name) || 0) + 1);
        }
    }
    tagCounts = counts;
}

// Chars carrying the exact tag name (or any of several names)
function findCarriers(names) {
    const wanted = new Set(Array.isArray(names) ? names : [names]);
    const carriers = [];
    for (const char of CoreAPI.getAllCharacters() || []) {
        const tags = CoreAPI.getCharacterTags(char);
        if (tags.some(t => wanted.has(asTagName(t)))) carriers.push(char);
    }
    return carriers;
}

// Groups of tags that differ only by case/whitespace
function findCaseDupeGroups() {
    const groups = new Map();
    for (const [name, count] of tagCounts) {
        const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ name, count });
    }
    const result = [];
    for (const variants of groups.values()) {
        if (variants.length < 2) continue;
        variants.sort((a, b) => b.count - a.count);
        result.push(variants);
    }
    result.sort((a, b) => b[0].count - a[0].count);
    return result;
}

// Spacers, not append-chunking, so the scrollbar reflects the REAL item count.
function makeVirtualList(container, buildRow, { overscan = 12 } = {}) {
    const state = { items: [], rowH: 0, start: -1, end: -1, raf: 0, remeasured: false };
    const top = document.createElement('div');
    const host = document.createElement('div');
    const bottom = document.createElement('div');
    // Spacers must survive a flex-column container, or they shrink to zero and the
    // scrollbar collapses (the rules list was the live case)
    top.style.flexShrink = '0';
    host.style.flexShrink = '0';
    bottom.style.flexShrink = '0';

    const renderWindow = (force) => {
        const n = state.items.length;
        if (n === 0) return;
        if (!state.rowH) {
            host.innerHTML = '';
            host.appendChild(buildRow(state.items[0], 0));
            state.rowH = host.firstElementChild.getBoundingClientRect().height || 36;
        }
        // The modal opens animated, so the first pass can see a near-zero clientHeight;
        // a minimum window keeps the list populated until the ResizeObserver corrects it
        const viewH = Math.max(container.clientHeight, 240);
        const start = Math.max(0, Math.floor(container.scrollTop / state.rowH) - overscan);
        const end = Math.min(n, Math.ceil((container.scrollTop + viewH) / state.rowH) + overscan);
        if (!force && start === state.start && end === state.end) return;
        state.start = start; state.end = end;
        top.style.height = `${start * state.rowH}px`;
        bottom.style.height = `${(n - end) * state.rowH}px`;
        host.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (let i = start; i < end; i++) frag.appendChild(buildRow(state.items[i], i));
        host.appendChild(frag);
        // The probe can measure mid-animation; verify against a real rendered row once
        // and re-run, or spacer math drifts and deep-scroll windows land misaligned
        if (!state.remeasured && host.firstElementChild) {
            const real = host.firstElementChild.getBoundingClientRect().height;
            if (real && Math.abs(real - state.rowH) > 0.5) {
                state.remeasured = true;
                state.rowH = real;
                renderWindow(true);
                return;
            }
            if (real) state.remeasured = true;
        }
    };

    const ro = new ResizeObserver(() => {
        if (state.items.length === 0) return;
        // A focused row input would be destroyed without firing change (removal fires
        // neither blur nor change); flush it so mid-edit text survives the rebuild
        const focused = document.activeElement;
        if (focused && container.contains(focused) && typeof focused.blur === 'function') focused.blur();
        state.remeasured = false;
        renderWindow(true);
    });
    // One live instance per container: renders recreate the virtualizer, and a stale
    // instance's ResizeObserver would repaint old items over the new ones
    container._virtualList?.destroy();
    ro.observe(container);

    const api = {
        set(items) {
            state.items = items || [];
            state.start = -1; state.end = -1; state.remeasured = false;
            container.innerHTML = '';
            container.scrollTop = 0;
            if (state.items.length === 0) return false;   // caller renders its empty state
            container.appendChild(top);
            container.appendChild(host);
            container.appendChild(bottom);
            container.onscroll = () => {
                if (state.raf) return;
                state.raf = requestAnimationFrame(() => { state.raf = 0; renderWindow(false); });
            };
            renderWindow(true);
            return true;
        },
        refresh() { renderWindow(true); },
        destroy() { ro.disconnect(); },
    };
    container._virtualList = api;
    return api;
}

// Trimmed-lower sort keys: exact-form entries like " female" would otherwise sort to the
// top of A-Z, far from "female"; numeric compare keeps tag2 before tag10
const tagCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

// Static strings only; never route third-party text through this without escaping
function emptyStateHtml(icon, title, hint) {
    return `<div class="cl-empty-state tgm-empty-state">
        <i class="cl-empty-state-icon fa-solid ${icon}"></i>
        <div class="cl-empty-state-title">${title}</div>
        ${hint ? `<div class="cl-empty-state-hint">${hint}</div>` : ''}
    </div>`;
}

// Stored tag arrays occasionally carry non-string junk; every comparison against an
// index key goes through one coercion so a listed tag can always be acted on
const asTagName = (t) => typeof t === 'string' ? t : String(t ?? '');

// Only the tag this run produced: a rename never consented to touching unrelated tags.
function collapseTarget(tags, target) {
    let seen = false;
    return tags.filter(t => t !== target || (!seen && (seen = true)));
}

// ========================================
// BULK RUNS
// ========================================

// Before-tags per carrier, persisted BEFORE the first write so a crash mid-run keeps the undo.
const JOURNAL_FILE = '_cl_tag_run_journal.json';
const JOURNAL_MAX_RUNS = 3;
let _journalCache = null;
let _journalSaving = false;
let _journalSaveQueued = false;
let _journalLoadPromise = null;

async function loadJournal() {
    if (_journalCache) return _journalCache;
    if (_journalLoadPromise) return _journalLoadPromise;
    _journalLoadPromise = (async () => {
        let data = null;
        // Only a definitive read may cache: caching {} on a transient failure destroys on-disk history.
        let definitive = false;
        try {
            const resp = await fetch(`/user/files/${JOURNAL_FILE}`);
            if (resp.ok) {
                definitive = true;
                const text = await resp.text();
                if (text && text.trim()) {
                    const parsed = JSON.parse(text);
                    if (parsed && parsed.version === 1 && Array.isArray(parsed.runs)) data = parsed;
                }
            } else if (resp.status === 404) {
                definitive = true;
            }
        } catch (_) {}
        const journal = data || { version: 1, runs: [] };
        if (definitive) _journalCache = journal;
        _journalLoadPromise = null;
        return journal;
    })();
    return _journalLoadPromise;
}

async function saveJournal() {
    if (!_journalCache) return false;
    if (_journalSaving) { _journalSaveQueued = true; return false; }
    _journalSaving = true;
    let ok = false;
    try {
        const resp = await CoreAPI.apiRequest('/files/upload', 'POST', {
            name: JOURNAL_FILE,
            data: CoreAPI.utf8ToBase64(JSON.stringify(_journalCache)),
        });
        ok = !!resp?.ok;
    } catch (err) {
        console.warn('[TagsManager] Journal save failed:', err?.message || err);
    } finally {
        _journalSaving = false;
        if (_journalSaveQueued) { _journalSaveQueued = false; saveJournal(); }
    }
    return ok;
}

async function recordRunJournal(label, carriers) {
    if (!carriers || carriers.length === 0) return true;
    const journal = await loadJournal();
    journal.runs.push({
        ts: new Date().toISOString(),
        label,
        entries: carriers.map(c => ({ avatar: c.avatar, before: (CoreAPI.getCharacterTags(c) || []).slice() })),
    });
    if (journal.runs.length > JOURNAL_MAX_RUNS) journal.runs.splice(0, journal.runs.length - JOURNAL_MAX_RUNS);
    return saveJournal();
}

async function undoLastRun() {
    if (runInProgress) return;
    const journal = await loadJournal();
    const run = journal.runs[journal.runs.length - 1];
    if (!run) { CoreAPI.showToast('No bulk run to undo', 'info'); return; }
    const beforeByAvatar = new Map(run.entries.map(e => [e.avatar, e.before]));
    const carriers = (CoreAPI.getAllCharacters() || []).filter(c => beforeByAvatar.has(c.avatar));
    const missing = run.entries.length - carriers.length;
    const when = new Date(run.ts).toLocaleString();
    const undoContent = [
        { type: 'stats', items: [
            { icon: 'fa-solid fa-clock-rotate-left', label: 'restores', value: cardCount(carriers.length) },
            { icon: 'fa-solid fa-calendar', label: 'from', value: when },
        ] },
        { type: 'note', text: 'The undo itself is journaled, so it can be undone again.' },
    ];
    if (missing) undoContent.splice(1, 0, { type: 'note', tone: 'warning', text: `${missing.toLocaleString()} character(s) from that run are no longer in the library and will be skipped.` });
    const ok = await CoreAPI.showConfirm({
        title: 'Undo last bulk run',
        message: `Restore the previous tags, reverting "${run.label}"?`,
        confirmLabel: 'Restore tags',
        danger: true,
        content: undoContent,
    });
    if (!ok) return;
    await runBulkTagWrite({
        label: 'Restoring tags',
        journalLabel: `Undo: ${run.label}`,
        carriers,
        // Copies, not the journal's own arrays: the in-memory sync would otherwise alias them
        mutate: (tags, char) => (beforeByAvatar.get(char.avatar) || []).slice(),
    });
}

function updateUndoButton() {
    const btn = document.getElementById('tgmUndoBtn');
    if (!btn) return;
    loadJournal().then(journal => {
        const run = journal.runs[journal.runs.length - 1];
        btn.classList.toggle('hidden', !run);
        if (run) btn.title = `Undo last bulk run: "${run.label}" (${run.entries.length.toLocaleString()} characters, ${new Date(run.ts).toLocaleString()})`;
    });
}

/**
 * Sequential tag rewrite over carriers via the writeCardFields primitive: no per-char ST
 * notify, one refresh at the end (batch-transfer restore precedent for bulk card writes).
 * mutate(tags) returns the new array, or null to skip the character.
 * Resolves true only when the run COMPLETED (callers gate filter reconciliation on it;
 * an aborted run leaves stragglers carrying the old tag, so the filter must stay).
 */
async function runBulkTagWrite({ label, journalLabel, carriers, mutate }) {
    if (runInProgress) return false;
    runInProgress = true;
    runAborted = false;

    // Journal BEFORE the first write; a failed save gets an explicit informed-consent gate
    const journalOk = await recordRunJournal(journalLabel || label, carriers);
    if (!journalOk) {
        const proceed = await CoreAPI.showConfirm({
            title: 'Undo journal unavailable',
            message: 'The undo journal could not be saved to SillyTavern.',
            confirmLabel: 'Run without undo',
            danger: true,
            content: [
                { type: 'note', tone: 'danger', text: 'Running now means this operation has NO undo.' },
            ],
        });
        if (!proceed) {
            // Drop the phantom entry so a later successful save cant persist a run that never ran
            _journalCache?.runs?.pop();
            runInProgress = false;
            return false;
        }
    }

    const bar = document.getElementById('tgmProgress');
    const fill = document.getElementById('tgmProgressFill');
    const text = document.getElementById('tgmProgressText');
    bar.classList.remove('hidden');
    setActionsDisabled(true);

    let done = 0, failed = 0;
    for (let i = 0; i < carriers.length; i++) {
        if (runAborted) break;
        const char = carriers[i];
        try {
            const current = CoreAPI.getCharacterTags(char);
            const next = mutate(current, char);
            if (next && JSON.stringify(next) !== JSON.stringify(current)) {
                // Surgical: only the tags ride the wire, so nothing else on the card can be touched
                const result = await CoreAPI.writeCardFields(char, { tags: next }, { surgical: true });
                if (result?.ok) done++; else failed++;
            }
        } catch (err) {
            console.error('[TagsManager] write failed for', char?.name, err);
            failed++;
        }
        fill.style.width = `${Math.round(((i + 1) / carriers.length) * 100)}%`;
        text.textContent = `${label}: ${i + 1}/${carriers.length}`;
    }

    // Abort only counts while carriers are still being written, or a finished run reports aborted.
    const wasAborted = runAborted;
    const abortBtn = document.getElementById('tgmAbortBtn');
    if (abortBtn) abortBtn.disabled = true;

    text.textContent = 'Refreshing library...';
    // Force: an unforced refresh reads the host window's in-memory characters, which never
    // saw these writes (no per-char ST notify) and would revert the grid to pre-run state
    try { await CoreAPI.refreshCharacters(true); } catch (_) {}

    bar.classList.add('hidden');
    fill.style.width = '0%';
    setActionsDisabled(false);
    if (abortBtn) abortBtn.disabled = false;
    runInProgress = false;

    if (wasAborted) {
        CoreAPI.showToast(`${label} aborted (${done} updated before stop)`, 'warning');
    } else if (failed > 0) {
        CoreAPI.showToast(`${label}: ${done} updated, ${failed} failed`, 'warning');
    } else {
        CoreAPI.showToast(`${label}: ${done} character(s) updated`, 'success');
    }

    // A zero-write run's journal entry equals current state; keeping it would let
    // repeated no-op undos cycle entries and evict REAL history from the run cap
    if (done === 0 && carriers.length > 0) {
        _journalCache?.runs?.pop();
        saveJournal();
    }

    buildTagIndex();
    // The run changed tag data, so cached rule impacts (and the carrier list Apply Now
    // reads from them) are stale
    rulesImpactCache = null;
    // Re-render the ACTIVE pane: the blanket re-enable above would otherwise arm controls
    // whose disabled state is semantic (first/last rule chevrons, empty-pick footer button)
    switchTab(activeTab);
    return !wasAborted;
}

function setActionsDisabled(disabled) {
    const modal = document.getElementById('tagsManagerModal');
    modal?.querySelectorAll('button, input').forEach(el => {
        if (el.id === 'tgmAbortBtn' || el.id === 'tgmCloseBtn') return;
        el.disabled = disabled;
    });
}

// ========================================
// OPERATIONS
// ========================================

async function renameTag(tag, newNameRaw) {
    const newName = String(newNameRaw ?? '').trim();
    if (!newName || newName === tag) return;

    const carriers = findCarriers(tag);
    if (carriers.length === 0) { CoreAPI.showToast('No characters carry this tag anymore', 'info'); return; }

    // Renaming onto ANY existing distinct tag is a merge, case variants included.
    const existingTarget = [...tagCounts.keys()].find(t =>
        t !== tag && t.toLowerCase() === newName.toLowerCase());
    const isMerge = !!existingTarget;
    const finalName = isMerge ? existingTarget : newName;

    const stats = [{ icon: 'fa-solid fa-tags', label: 'rewrites', value: cardCount(carriers.length) }];
    if (isMerge) stats.push({ icon: 'fa-solid fa-arrow-right-to-bracket', label: 'into', value: `${finalName} (${(tagCounts.get(existingTarget) || 0).toLocaleString()} existing)` });
    const ok = await CoreAPI.showConfirm({
        title: isMerge ? 'Merge tag' : 'Rename tag',
        message: isMerge ? `Merge "${tag}" into "${finalName}"?` : `Rename "${tag}" to "${finalName}"?`,
        danger: true,
        content: [
            { type: 'stats', items: stats },
            { type: 'note', text: 'Previous tags are journaled; the toolbar Undo reverts this run.' },
        ],
    });
    if (!ok) return;

    const completed = await runBulkTagWrite({
        label: isMerge ? 'Merging' : 'Renaming',
        journalLabel: `${isMerge ? 'Merge' : 'Rename'} "${tag}" to "${finalName}"`,
        carriers,
        mutate: (tags) => collapseTarget(tags.map(t => asTagName(t) === tag ? finalName : t), finalName),
    });
    if (completed) CoreAPI.renameActiveTagFilter(tag, finalName);
}

async function deleteTag(tag) {
    const carriers = findCarriers(tag);
    if (carriers.length === 0) { CoreAPI.showToast('No characters carry this tag anymore', 'info'); return; }

    const ok = await CoreAPI.showConfirm({
        title: 'Delete tag',
        message: `Remove "${tag}" from every character that carries it?`,
        danger: true,
        content: [
            { type: 'stats', items: [{ icon: 'fa-solid fa-tags', label: 'carried by', value: cardCount(carriers.length) }] },
            { type: 'note', text: 'Previous tags are journaled; the toolbar Undo reverts this run.' },
        ],
    });
    if (!ok) return;

    const completed = await runBulkTagWrite({
        label: 'Deleting',
        journalLabel: `Delete "${tag}"`,
        carriers,
        mutate: (tags) => tags.filter(t => asTagName(t) !== tag),
    });
    if (completed) CoreAPI.renameActiveTagFilter(tag, null);
}

const cardCount = (n) => `${n.toLocaleString()} ${n === 1 ? 'card' : 'cards'}`;

// One rule per distinct lowered form covers every case variant (matching is case-insensitive)
function addAliasRulesFor(variants, canonical) {
    const rules = getRules();
    const existing = new Set(rules.map(r => (r.match || '').trim().toLowerCase()).filter(Boolean));
    // The engine trims replace values at compile, so store the trimmed form: a padded
    // keeper would otherwise map future imports to a twin the merge just cleaned up
    const cleanReplace = canonical.trim();
    let added = 0, updated = 0;
    for (const form of new Set(variants.map(v => v.name.trim().toLowerCase()))) {
        if (existing.has(form)) {
            // A pre-existing rule mapping this form ELSEWHERE would silently override the
            // merge confirm's promise; the just-made explicit choice wins over the old rule
            const rule = rules.find(r => (r.match || '').trim().toLowerCase() === form);
            if (rule && (rule.replace || '').trim() !== cleanReplace) { rule.replace = cleanReplace; updated++; }
            continue;
        }
        // The canonical's own form still earns a rule: it re-cases future imports of any variant
        rules.push({ match: form, replace: cleanReplace });
        existing.add(form);
        added++;
    }
    if (added > 0 || updated > 0) {
        saveRules(rules);
        const parts = [];
        if (added > 0) parts.push(`added ${added}`);
        if (updated > 0) parts.push(`updated ${updated}`);
        const msg = parts.join(' and ');
        CoreAPI.showToast(`Import rules: ${msg} mapping to "${canonical}"`, 'success');
    } else {
        CoreAPI.showToast('A matching import rule already exists', 'info');
    }
}

async function mergeGroup(variants, canonical) {
    // Only chars carrying a non-canonical variant need a rewrite
    const others = variants.map(v => v.name).filter(n => n !== canonical);
    const carriers = findCarriers(others);
    const choice = await CoreAPI.showConfirm({
        title: 'Merge case duplicates',
        message: `Merge ${others.map(n => `"${n}"`).join(', ')} into "${canonical}"?`,
        confirmLabel: 'Merge',
        extraLabel: 'Merge + Add Import Rule',
        danger: true,
        content: [
            { type: 'stats', items: [{ icon: 'fa-solid fa-tags', label: 'rewrites', value: cardCount(carriers.length) }] },
            { type: 'note', text: 'Previous tags are journaled; the toolbar Undo reverts this run.' },
            { type: 'text', text: `"Merge + Add Import Rule" also maps these variants to "${canonical}" on future imports.` },
        ],
    });
    if (!choice) return;
    if (choice === 'extra') addAliasRulesFor(variants, canonical);

    const wanted = new Set(others);
    const completed = await runBulkTagWrite({
        label: 'Merging',
        journalLabel: `Merge ${others.length} variant(s) into "${canonical}"`,
        carriers,
        mutate: (tags) => collapseTarget(tags.map(t => wanted.has(asTagName(t)) ? canonical : t), canonical),
    });
    if (completed) others.forEach(v => CoreAPI.renameActiveTagFilter(v, canonical));
}

/**
 * Advisory per-rule attribution for the badges and the apply preview. Walks tags in the
 * same order the engine does (trim, optional strip, first matching rule); the WRITE path
 * only ever goes through CoreAPI.applyTagAliases.
 */
function computeRuleImpact() {
    const rules = getRules();
    const stripOn = CoreAPI.getSetting('tagAliasStripDecor') === true;
    const capOn = CoreAPI.getSetting('tagAliasCapitalize') === true;
    const compiled = CoreAPI.compileTagAliasRules(rules);
    const perRule = rules.map(() => new Set());
    const stripChars = new Set();
    const trimChars = new Set();
    const capChars = new Set();
    const cleanupChars = new Set();
    const affected = [];

    for (const char of CoreAPI.getAllCharacters() || []) {
        const tags = CoreAPI.getCharacterTags(char);
        if (tags.length === 0) continue;
        const next = CoreAPI.applyTagAliases(tags);
        const changed = next !== tags && JSON.stringify(next) !== JSON.stringify(tags);
        if (changed) affected.push(char);

        // The engine also trims, drops empties and merges case-duplicates whenever it runs;
        // attribute that separately so the apply preview's total is fully accounted for
        if (JSON.stringify(CoreAPI.normalizeTagArray(tags)) !== JSON.stringify(tags)) {
            trimChars.add(char.avatar);
            if (changed) cleanupChars.add(char.avatar);
        }

        for (const raw of tags) {
            const trimmed = String(raw ?? '').trim();
            const tag = stripOn ? CoreAPI.stripTagDecoration(trimmed) : trimmed;
            if (stripOn && tag !== trimmed) stripChars.add(char.avatar);
            if (!tag) continue;
            const entry = CoreAPI.matchTagAliasRule(compiled, tag);
            if (entry) {
                perRule[entry.index].add(char.avatar);
            } else if (capOn) {
                const first = [...tag][0];
                if (first !== first.toUpperCase()) capChars.add(char.avatar);
            }
        }
    }
    return {
        perRule: perRule.map(s => s.size),
        stripChars: stripChars.size,
        trimChars: trimChars.size,
        capChars: capChars.size,
        cleanupChars: cleanupChars.size,
        affected,
    };
}

// Impact scans the whole library; cache per data-state so rules-search keystrokes reuse it
let rulesImpactCache = null;
function getRuleImpact() {
    if (!rulesImpactCache) rulesImpactCache = computeRuleImpact();
    return rulesImpactCache;
}

async function applyRulesToLibrary() {
    const impact = getRuleImpact();
    if (impact.affected.length === 0) {
        CoreAPI.showToast('No characters are affected by the current rules', 'info');
        return;
    }

    const rules = getRules();
    // Blocks escape internally, so lines carry RAW rule text
    const lines = [];
    rules.forEach((rule, i) => {
        if (!rule.match || impact.perRule[i] === 0) return;
        const to = rule.replace ? `"${rule.replace}"` : '(dropped)';
        lines.push(`"${rule.match}" → ${to}   (${impact.perRule[i].toLocaleString()} chars)`);
    });
    if (impact.stripChars > 0) lines.push(`Emoji/decoration strip   (${impact.stripChars.toLocaleString()} chars)`);
    if (CoreAPI.getSetting('tagAliasCapitalize') === true && impact.capChars > 0) {
        lines.push(`First-letter capitalization   (${impact.capChars.toLocaleString()} chars)`);
    }
    if (impact.cleanupChars > 0) lines.push(`Whitespace & duplicate-tag cleanup   (${impact.cleanupChars.toLocaleString()} chars)`);
    const shown = lines.slice(0, 12);
    if (lines.length > 12) shown.push(`and ${lines.length - 12} more`);
    const overlapNote = lines.length > 1 ? ' Counts overlap when a character is affected by more than one line.' : '';

    const ok = await CoreAPI.showConfirm({
        title: 'Apply rules to library',
        confirmLabel: 'Rewrite tags',
        danger: true,
        content: [
            { type: 'list', items: shown },
            { type: 'stats', items: [{ icon: 'fa-solid fa-users', label: 'rewrites', value: cardCount(impact.affected.length) }] },
            { type: 'note', text: `Previous tags are journaled (toolbar Undo reverts the run); imports keep applying these rules automatically.${overlapNote}` },
        ],
    });
    if (!ok) return;

    const completed = await runBulkTagWrite({
        label: 'Applying rules',
        journalLabel: 'Apply import rules to library',
        carriers: impact.affected,
        mutate: (tags) => CoreAPI.applyTagAliases(tags),
    });
    if (completed) CoreAPI.reconcileTagFiltersWithAliases();
}

// ========================================
// LIBRARY TAB (windowed list)
// ========================================

function renderLibraryTab() {
    const searchInput = document.getElementById('tgmSearchInput');
    const countEl = document.getElementById('tgmTagTotal');
    if (countEl) countEl.textContent = `${tagCounts.size.toLocaleString()} tags`;

    // Context chrome: the dupe chip exists only while dupes exist, the sort toggle only
    // in the flat list (the review view has its own fixed order)
    const dupeGroups = findCaseDupeGroups();
    const chip = document.getElementById('tgmDupeChip');
    if (chip) {
        chip.classList.toggle('hidden', dupeGroups.length === 0);
        chip.classList.toggle('active', showingDupes);
        chip.querySelector('span').textContent = dupeGroups.length.toLocaleString();
        chip.title = showingDupes
            ? 'Back to all tags'
            : `Review ${dupeGroups.length.toLocaleString()} groups of case/whitespace duplicates`;
    }
    const sortBtn = document.getElementById('tgmSortBtn');
    if (sortBtn) {
        sortBtn.classList.toggle('hidden', showingDupes);
        sortBtn.querySelector('i').className =
            sortMode === 'name' ? 'fa-solid fa-arrow-down-a-z' : 'fa-solid fa-arrow-down-wide-short';
        sortBtn.title = sortMode === 'name' ? 'Sorted A-Z. Click to sort by most used' : 'Sorted by most used. Click to sort A-Z';
    }
    updateUndoButton();

    if (showingDupes) {
        renderDupeGroups(dupeGroups, searchInput?.value || '');
        return;
    }

    const content = document.getElementById('tgmTagList');
    if (!content) return;

    const entries = [...tagCounts.keys()].map(t => ({ t, key: t.trim().toLowerCase() }));
    entries.sort(sortMode === 'name'
        ? (a, b) => tagCollator.compare(a.key, b.key) || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)
        : (a, b) => (tagCounts.get(b.t) - tagCounts.get(a.t)) || tagCollator.compare(a.key, b.key));
    const sortedTags = entries.map(e => e.t);

    const buildRow = (tag) => {
        const row = document.createElement('div');
        row.className = 'tgm-row';

        const label = document.createElement('span');
        label.className = 'tgm-row-name';
        label.textContent = tag;
        label.title = tag;

        const count = document.createElement('span');
        count.className = 'tgm-row-count';
        count.textContent = tagCounts.get(tag) || 0;

        const actions = document.createElement('span');
        actions.className = 'tgm-row-actions';
        actions.innerHTML = `
            <button class="tgm-icon-btn" data-act="rename" title="Rename tag"><i class="fa-solid fa-pen"></i></button>
            <button class="tgm-icon-btn" data-act="filter" title="Show in grid"><i class="fa-solid fa-magnifying-glass"></i></button>
            <button class="tgm-icon-btn tgm-danger" data-act="delete" title="Delete tag from all characters"><i class="fa-solid fa-trash"></i></button>`;

        actions.querySelector('[data-act="rename"]').addEventListener('click', () => startInlineRename(row, tag));
        actions.querySelector('[data-act="filter"]').addEventListener('click', () => {
            CoreAPI.filterLibraryByTag(tag);
            closeModal();
        });
        actions.querySelector('[data-act="delete"]').addEventListener('click', () => deleteTag(tag));

        // Rows rebuilt mid-run must come up disabled, or a click silently aborts the run.
        if (runInProgress) actions.querySelectorAll('button').forEach(b => { b.disabled = true; });

        row.appendChild(label);
        row.appendChild(count);
        row.appendChild(actions);
        return row;
    };

    const virtual = makeVirtualList(content, (tag) => buildRow(tag));

    const renderList = (filterText = '') => {
        const lowerFilter = filterText.toLowerCase();
        const matchedTags = !lowerFilter ? sortedTags : sortedTags.filter(t => t.toLowerCase().includes(lowerFilter));
        if (!virtual.set(matchedTags)) {
            content.innerHTML = emptyStateHtml('fa-magnifying-glass', 'No tags match', 'Try a different search.');
        }
    };

    renderList(searchInput?.value || '');

    if (searchInput) {
        searchInput.oninput = () => {
            if (showingDupes) renderLibraryTab();
            else renderList(searchInput.value);
        };
    }
}

function startInlineRename(row, tag) {
    if (runInProgress) return;
    const label = row.querySelector('.tgm-row-name');
    if (!label || row.querySelector('.tgm-rename-input')) return;

    const input = document.createElement('input');
    input.type = 'search';
    input.autocomplete = 'one-time-code';
    input.className = 'cl-input tgm-rename-input';
    input.value = tag;

    let finished = false;
    const finish = (commit) => {
        if (finished) return;
        finished = true;
        input.replaceWith(label);
        if (commit && input.value.trim() && input.value.trim() !== tag) {
            renameTag(tag, input.value);
        }
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(false));

    label.replaceWith(input);
    input.focus();
    input.select();
}

function renderDupeGroups(groups, filterText = '') {
    const content = document.getElementById('tgmTagList');
    if (!content) return;
    content.onscroll = null;
    content.innerHTML = '';

    const lowerFilter = filterText.trim().toLowerCase();
    if (lowerFilter) {
        groups = groups.filter(variants => variants.some(v => v.name.toLowerCase().includes(lowerFilter)));
    }

    if (groups.length === 0) {
        if (lowerFilter) {
            content.innerHTML = emptyStateHtml('fa-magnifying-glass', 'No duplicate groups match', 'Try a different search.');
        } else {
            // All merged: drop back to the flat list instead of stranding an empty review
            showingDupes = false;
            renderLibraryTab();
        }
        return;
    }

    const hint = document.createElement('div');
    hint.className = 'tgm-hint tgm-dupes-hint';
    hint.textContent = 'Click the variant to keep; the others merge into it.';
    content.appendChild(hint);

    for (const variants of groups) {
        const groupEl = document.createElement('div');
        groupEl.className = 'tgm-dupe-group';

        for (const v of variants) {
            const pill = document.createElement('button');
            pill.className = 'cl-tag tgm-dupe-pill';
            pill.innerHTML = `${CoreAPI.escapeHtml(v.name)} <span class="tgm-row-count">${v.count}</span>`;
            pill.title = `Merge the other variant(s) into "${v.name}"`;
            pill.addEventListener('click', () => mergeGroup(variants, v.name));
            groupEl.appendChild(pill);
        }

        content.appendChild(groupEl);
    }
}

// ========================================
// BATCH TAB (character picker)
// ========================================

let pickedAvatars = new Set();

function updatePickFooter() {
    const n = pickedAvatars.size;
    const countEl = document.getElementById('tgmPickCount');
    if (countEl) countEl.textContent = n ? `${n.toLocaleString()} selected` : 'None selected';
    const openBtn = document.getElementById('tgmPickOpenBtn');
    if (openBtn) openBtn.disabled = n === 0;
}

function seedPicked(chars) {
    pickedAvatars = new Set((chars || []).map(c => c.avatar).filter(Boolean));
    renderBatchTab();
}

function renderBatchTab() {
    const all = CoreAPI.getAllCharacters() || [];
    const selected = CoreAPI.getSelectedCharacters() || [];
    const filtered = CoreAPI.getCurrentCharacters() || [];

    const seedSel = document.getElementById('tgmPickSeedSelection');
    if (seedSel) {
        seedSel.disabled = selected.length === 0;
        seedSel.querySelector('span').textContent = selected.length.toLocaleString();
    }
    const seedFilt = document.getElementById('tgmPickSeedFilter');
    if (seedFilt) {
        seedFilt.disabled = filtered.length === 0;
        seedFilt.querySelector('span').textContent = filtered.length.toLocaleString();
    }

    const content = document.getElementById('tgmPickList');
    const searchInput = document.getElementById('tgmPickSearch');
    if (!content) return;

    const buildRow = (char) => {
        const row = document.createElement('label');
        row.className = 'tgm-pick-row';

        const check = document.createElement('input');
        check.type = 'checkbox';
        check.dataset.avatar = char.avatar;
        check.checked = pickedAvatars.has(char.avatar);
        if (runInProgress) check.disabled = true;

        const img = document.createElement('img');
        img.className = 'tgm-pick-avatar';
        img.loading = 'lazy';
        // ST's built-in thumbnail: always available, right-sized for a 28px render
        img.src = CoreAPI.getCharacterAvatarStThumbUrl(char.avatar);
        img.alt = '';

        const name = document.createElement('span');
        name.className = 'tgm-pick-name';
        name.textContent = CoreAPI.getCharacterName(char) || char.avatar;
        name.title = 'Open character details';
        name.addEventListener('click', (e) => {
            // preventDefault stops the wrapping label from toggling the checkbox
            e.preventDefault();
            e.stopPropagation();
            CoreAPI.openCharModalElevated(char);
        });

        const creator = document.createElement('span');
        creator.className = 'tgm-pick-creator';
        creator.textContent = char.data?.creator || '';

        row.appendChild(check);
        row.appendChild(img);
        row.appendChild(name);
        row.appendChild(creator);
        return row;
    };

    // Virtualized like the tag list; libraries reach 5 digits of characters
    const virtual = makeVirtualList(content, (char) => buildRow(char));
    let matched = all;

    const renderList = (filterText = '') => {
        const lowerFilter = filterText.toLowerCase().trim();
        matched = !lowerFilter ? all
            : all.filter(c => (c._lowerName || '').includes(lowerFilter) || (c._lowerCreator || '').includes(lowerFilter));
        if (!virtual.set(matched)) {
            content.innerHTML = emptyStateHtml('fa-magnifying-glass', 'No characters match', 'Try a different search.');
        }
    };

    renderList(searchInput?.value || '');

    if (searchInput) searchInput.oninput = () => renderList(searchInput.value);

    // All/None act on what the picker search currently shows
    const allBtn = document.getElementById('tgmPickAllBtn');
    if (allBtn) allBtn.onclick = () => {
        matched.forEach(c => c.avatar && pickedAvatars.add(c.avatar));
        renderBatchTab();
    };
    const noneBtn = document.getElementById('tgmPickNoneBtn');
    if (noneBtn) noneBtn.onclick = () => {
        pickedAvatars.clear();
        renderBatchTab();
    };

    updatePickFooter();
}

function openBatchEditor(chars) {
    if (!chars || chars.length === 0) return;
    // Close first: the two modals' DOM order (and so their paint order) depends on which
    // module lazy-loaded first, so stacking them is not deterministic
    closeModal();
    CoreAPI.getModule('batch-tagging')?.openModal?.(chars);
}

// ========================================
// RULES TAB
// ========================================

// Session working array for the rules tab: rows write into it by identity and the whole
// array persists, so virtual-windowed rows and store indexes can never disagree
let rulesWorking = [];
// Live error state by rule index: rows rebuilt by the virtualizer on scroll-back read
// this instead of a render-time snapshot, so a fixed regex doesnt re-show its old mark
let rulesErrorByIndex = new Map();

function getRules() {
    const rules = CoreAPI.getSetting('tagAliasRules');
    if (!Array.isArray(rules)) return [];
    // Fresh copies: the stored array can BE the DEFAULT_SETTINGS reference, so in-place edits pollute it.
    return rules
        .filter(r => r && typeof r === 'object')
        .map(r => ({
            match: typeof r.match === 'string' ? r.match : '',
            replace: typeof r.replace === 'string' ? r.replace : '',
        }));
}

function saveRules(rules) {
    CoreAPI.setSetting('tagAliasRules', rules);
    rulesImpactCache = null;
    updateRuleTest();
}

function renderRulesTab() {
    const stripToggle = document.getElementById('tgmStripDecor');
    if (stripToggle) stripToggle.checked = CoreAPI.getSetting('tagAliasStripDecor') === true;
    const trimToggle = document.getElementById('tgmTrimSpaces');
    if (trimToggle) trimToggle.checked = CoreAPI.getSetting('tagAliasTrimSpaces') === true;
    const capToggle = document.getElementById('tgmCapitalize');
    if (capToggle) capToggle.checked = CoreAPI.getSetting('tagAliasCapitalize') === true;

    const list = document.getElementById('tgmRulesList');
    const header = document.getElementById('tgmRulesHeader');
    const searchInput = document.getElementById('tgmRuleSearch');
    if (!list) return;
    rulesWorking = getRules();

    if (rulesWorking.length === 0) {
        if (header) header.classList.add('hidden');
        list.onscroll = null;
        list.innerHTML = emptyStateHtml('fa-filter', 'No rules yet', 'Add a rule below; imports apply the whole list automatically.');
        refreshToggleImpacts(getRuleImpact());
        updateRuleTest();
        return;
    }
    if (header) header.classList.remove('hidden');

    const compiled = CoreAPI.compileTagAliasRules(rulesWorking);
    rulesErrorByIndex = new Map(compiled.list.filter(e => e.error).map(e => [e.index, e.error]));
    refreshToggleImpacts(getRuleImpact());

    const filter = (searchInput?.value || '').trim().toLowerCase();
    const items = rulesWorking
        .map((rule, i) => ({ rule, i }))
        .filter(({ rule }) => !filter
            || rule.match.toLowerCase().includes(filter)
            || rule.replace.toLowerCase().includes(filter));

    // Reordering a FILTERED view is ambiguous (moving past hidden neighbors), so the
    // chevrons only render on the unfiltered list
    const reorderable = !filter;
    const virtual = makeVirtualList(list, ({ rule, i }) => buildRuleRow(rule, i, reorderable));
    if (!virtual.set(items)) {
        list.innerHTML = emptyStateHtml('fa-magnifying-glass', 'No rules match', 'Try a different search.');
    }

    if (searchInput) searchInput.oninput = () => renderRulesTab();

    updateRuleTest();
}

function buildRuleRow(rule, i, reorderable) {
    const row = document.createElement('div');
    row.className = 'tgm-rule-row';
    row.dataset.ruleIdx = i;
    // Read impact/error from live module state, not a render-time closure: the virtualizer
    // rebuilds scrolled-back rows long after the render that queued them
    const impactN = getRuleImpact().perRule[i] || 0;
    const err = rulesErrorByIndex.get(i);
    row.innerHTML = `
        <input type="search" autocomplete="one-time-code" class="cl-input tgm-rule-match${err ? ' tgm-rule-error' : ''}" placeholder="tag to match, or /regex/" title="${err ? CoreAPI.escapeHtml('Invalid regex: ' + err) : 'The incoming tag to match: exact (case-insensitive), or /pattern/ regex; the replacement may use $1 groups'}" value="${CoreAPI.escapeHtml(rule.match)}">
        <i class="fa-solid fa-arrow-right tgm-rule-arrow"></i>
        <input type="search" autocomplete="one-time-code" class="cl-input tgm-rule-replace" placeholder="(drop tag)" title="What the tag becomes; leave empty to drop it entirely" value="${CoreAPI.escapeHtml(rule.replace)}">
        <span class="tgm-rule-impact" title="Characters in your library this rule currently matches">${rule.match ? impactN.toLocaleString() : ''}</span>
        <span class="tgm-rule-btns">${reorderable ? `
            <button class="tgm-icon-btn" data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
            <button class="tgm-icon-btn" data-act="down" title="Move down" ${i === rulesWorking.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>` : ''}
            <button class="tgm-icon-btn tgm-danger" data-act="remove" title="Remove rule"><i class="fa-solid fa-xmark"></i></button>
        </span>`;

    const matchInput = row.querySelector('.tgm-rule-match');
    const replaceInput = row.querySelector('.tgm-rule-replace');
    const persist = () => {
        if (!rulesWorking[i]) return;
        // In place: the virtualizer holds these same objects, so a rebuilt row reads current values.
        rulesWorking[i].match = matchInput.value.trim();
        rulesWorking[i].replace = replaceInput.value.trim();
        saveRules(rulesWorking);
        const compiledOne = CoreAPI.compileTagAliasRules([rulesWorking[i]]);
        const rowErr = compiledOne.list[0]?.error;
        if (rowErr) rulesErrorByIndex.set(i, rowErr); else rulesErrorByIndex.delete(i);
        matchInput.classList.toggle('tgm-rule-error', !!rowErr);
        matchInput.title = rowErr
            ? 'Invalid regex: ' + rowErr
            : 'The incoming tag to match: exact (case-insensitive), or /pattern/ regex; the replacement may use $1 groups';
        refreshRuleImpacts();
    };
    matchInput.addEventListener('change', persist);
    replaceInput.addEventListener('change', persist);
    // Index clamps stay load-bearing: a bulk run's blanket re-enable can arm the
    // markup-disabled first/last chevrons
    row.querySelector('[data-act="up"]')?.addEventListener('click', () => {
        if (i <= 0 || i >= rulesWorking.length) return;
        [rulesWorking[i - 1], rulesWorking[i]] = [rulesWorking[i], rulesWorking[i - 1]];
        saveRules(rulesWorking);
        renderRulesTab();
    });
    row.querySelector('[data-act="down"]')?.addEventListener('click', () => {
        if (i < 0 || i >= rulesWorking.length - 1) return;
        [rulesWorking[i + 1], rulesWorking[i]] = [rulesWorking[i], rulesWorking[i + 1]];
        saveRules(rulesWorking);
        renderRulesTab();
    });
    row.querySelector('[data-act="remove"]').addEventListener('click', () => {
        if (i < 0 || i >= rulesWorking.length) return;
        rulesWorking.splice(i, 1);
        saveRules(rulesWorking);
        renderRulesTab();
    });
    // Mid-run rebuilt rows stay locked: an edit landing while Apply to Library runs would
    // rewrite the remaining carriers under a DIFFERENT ruleset than the finished ones
    if (runInProgress) row.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
    return row;
}

// In-place badge refresh so a mid-edit rebuild cant steal focus from the next input
function refreshRuleImpacts() {
    rulesImpactCache = null;
    const impact = getRuleImpact();
    document.querySelectorAll('#tgmRulesList .tgm-rule-row').forEach(row => {
        const idx = Number(row.dataset.ruleIdx);
        const badge = row.querySelector('.tgm-rule-impact');
        if (badge) badge.textContent = rulesWorking[idx]?.match ? (impact.perRule[idx] || 0).toLocaleString() : '';
    });
    refreshToggleImpacts(impact);
}

function refreshToggleImpacts(impact) {
    const setBadge = (id, on, n) => {
        const el = document.getElementById(id);
        if (el) el.textContent = (on && n > 0) ? `${n.toLocaleString()} chars affected` : '';
    };
    setBadge('tgmStripImpact', CoreAPI.getSetting('tagAliasStripDecor') === true, impact.stripChars);
    setBadge('tgmTrimImpact', CoreAPI.getSetting('tagAliasTrimSpaces') === true, impact.trimChars);
    setBadge('tgmCapImpact', CoreAPI.getSetting('tagAliasCapitalize') === true, impact.capChars);
}

function updateRuleTest() {
    const input = document.getElementById('tgmRuleTestInput');
    const out = document.getElementById('tgmRuleTestOut');
    if (!input || !out) return;
    const value = input.value.trim();
    if (!value) { out.textContent = ''; return; }
    const mapped = CoreAPI.applyTagAliases([value]);
    out.textContent = mapped.length === 0 ? '(dropped)' : mapped[0];
    out.classList.toggle('tgm-dropped', mapped.length === 0);
}

// ========================================
// MODAL SHELL
// ========================================

function switchTab(tab) {
    activeTab = tab;
    const modal = document.getElementById('tagsManagerModal');
    modal.querySelectorAll('.tgm-tab').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.tab === tab));
    modal.querySelectorAll('.tgm-pane').forEach(pane =>
        pane.classList.toggle('hidden', pane.dataset.tab !== tab));

    if (tab === 'library') renderLibraryTab();
    else if (tab === 'batch') renderBatchTab();
    else renderRulesTab();
}

export function openModal(tab) {
    if (!isInitialized) {
        console.error('[TagsManager] Module not initialized');
        return;
    }
    buildTagIndex();
    // Tag edits made outside the manager (batch tagging, detail modal) since the last
    // open invalidate any cached rule impacts
    rulesImpactCache = null;
    showingDupes = false;
    // Continuity: an active grid selection is the obvious starting point for the picker
    pickedAvatars = new Set((CoreAPI.getSelectedCharacters() || []).map(c => c.avatar).filter(Boolean));
    document.getElementById('tagsManagerModal').classList.add('visible');
    switchTab(tab || activeTab || 'library');
}

function closeModal() {
    if (runInProgress) runAborted = true;
    // Flush a focused rule input's pending change FIRST: hiding the modal blurs it and
    // the late change event would otherwise write against post-prune indexes
    const modal = document.getElementById('tagsManagerModal');
    const active = document.activeElement;
    if (modal && active && modal.contains(active)) active.blur();
    // An abandoned blank Add Rule row would otherwise sit in settings forever (harmless to
    // the engine, which skips blank matches, but junk state)
    const rules = getRules();
    const pruned = rules.filter(r => r.match.trim() || r.replace.trim());
    if (pruned.length !== rules.length) saveRules(pruned);
    modal?.classList.remove('visible');
}

function setupEventListeners() {
    const modal = document.getElementById('tagsManagerModal');
    document.getElementById('tgmCloseBtn')?.addEventListener('click', closeModal);
    modal?.addEventListener('click', (e) => {
        // A stray backdrop tap must not abort a multi-thousand-carrier run; the Abort
        // button and the X are the deliberate stops
        if (e.target.id === 'tagsManagerModal' && !runInProgress) closeModal();
    });
    modal?.querySelectorAll('.tgm-tab').forEach(btn =>
        btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

    document.getElementById('tgmAbortBtn')?.addEventListener('click', () => { runAborted = true; });
    document.getElementById('tgmUndoBtn')?.addEventListener('click', undoLastRun);
    document.getElementById('tgmDupeChip')?.addEventListener('click', () => {
        showingDupes = !showingDupes;
        renderLibraryTab();
    });
    document.getElementById('tgmSortBtn')?.addEventListener('click', () => {
        sortMode = sortMode === 'name' ? 'count' : 'name';
        renderLibraryTab();
    });

    // One delegate on the static list container; rows are transient (rebuilt with the
    // scroll window) so per-row listeners would be lost
    document.getElementById('tgmPickList')?.addEventListener('change', (e) => {
        const avatar = e.target?.dataset?.avatar;
        if (!avatar) return;
        if (e.target.checked) pickedAvatars.add(avatar);
        else pickedAvatars.delete(avatar);
        updatePickFooter();
    });
    document.getElementById('tgmPickSeedSelection')?.addEventListener('click', () =>
        seedPicked(CoreAPI.getSelectedCharacters()));
    document.getElementById('tgmPickSeedFilter')?.addEventListener('click', () =>
        seedPicked(CoreAPI.getCurrentCharacters()));
    document.getElementById('tgmPickOpenBtn')?.addEventListener('click', () => {
        const picked = (CoreAPI.getAllCharacters() || []).filter(c => pickedAvatars.has(c.avatar));
        openBatchEditor(picked);
    });

    const wireAliasToggle = (id, settingKey) => {
        document.getElementById(id)?.addEventListener('change', (e) => {
            CoreAPI.setSetting(settingKey, e.target.checked === true);
            rulesImpactCache = null;
            updateRuleTest();
            refreshRuleImpacts();
        });
    };
    wireAliasToggle('tgmStripDecor', 'tagAliasStripDecor');
    wireAliasToggle('tgmTrimSpaces', 'tagAliasTrimSpaces');
    wireAliasToggle('tgmCapitalize', 'tagAliasCapitalize');
    document.getElementById('tgmAddRuleBtn')?.addEventListener('click', () => {
        // A new row must be visible and focusable: clear the filter, jump to the bottom
        const searchInput = document.getElementById('tgmRuleSearch');
        if (searchInput) searchInput.value = '';
        rulesWorking = getRules();
        rulesWorking.push({ match: '', replace: '' });
        saveRules(rulesWorking);
        renderRulesTab();
        const list = document.getElementById('tgmRulesList');
        if (list) list.scrollTop = list.scrollHeight;
        requestAnimationFrame(() => requestAnimationFrame(() => {
            const inputs = document.querySelectorAll('#tgmRulesList .tgm-rule-match');
            inputs[inputs.length - 1]?.focus();
        }));
    });
    document.getElementById('tgmRuleTestInput')?.addEventListener('input', updateRuleTest);
    document.getElementById('tgmApplyRulesBtn')?.addEventListener('click', applyRulesToLibrary);
}

function injectModal() {
    const modalHtml = `
    <div id="tagsManagerModal" class="cl-modal">
        <div class="cl-modal-content tgm-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-tags"></i> Tags Manager</h3>
                <button id="tgmCloseBtn" class="cl-modal-close"><i class="fa-solid fa-xmark"></i></button>
            </div>

            <div class="tgm-tabs">
                <button class="tgm-tab active" data-tab="library" title="Browse, rename, merge and delete the tags in your library"><i class="fa-solid fa-list"></i> Library Tags</button>
                <button class="tgm-tab" data-tab="batch" title="Add or remove tags on many characters at once"><i class="fa-solid fa-object-group"></i> Batch Tagging</button>
                <button class="tgm-tab" data-tab="rules" title="Automatically rewrite or drop tags when importing from providers"><i class="fa-solid fa-filter"></i> Import Rules</button>
            </div>

            <div class="cl-modal-body tgm-body">
                <div class="tgm-pane" data-tab="library">
                    <div class="tgm-toolbar">
                        <input type="search" id="tgmSearchInput" class="cl-input" placeholder="Search tags..." autocomplete="one-time-code" title="Filter the tag list (also filters the duplicate review)">
                        <button id="tgmSortBtn" class="tgm-icon-btn tgm-tool-btn"><i class="fa-solid fa-arrow-down-a-z"></i></button>
                        <button id="tgmUndoBtn" class="tgm-icon-btn tgm-tool-btn hidden" title="Undo last bulk run"><i class="fa-solid fa-clock-rotate-left"></i></button>
                        <button id="tgmDupeChip" class="tgm-dupe-chip hidden"><i class="fa-solid fa-triangle-exclamation"></i> <span></span> dupes</button>
                        <span id="tgmTagTotal" class="tgm-total" title="Unique tags across your library"></span>
                    </div>
                    <div id="tgmTagList" class="tgm-list"></div>
                </div>

                <div class="tgm-pane hidden" data-tab="batch">
                    <div class="tgm-toolbar">
                        <input type="search" id="tgmPickSearch" class="cl-input" placeholder="Search characters..." autocomplete="one-time-code" title="Filter by character or creator name">
                        <button id="tgmPickAllBtn" class="tgm-icon-btn tgm-tool-btn" title="Select every character the search currently shows"><i class="fa-solid fa-check-double"></i></button>
                        <button id="tgmPickNoneBtn" class="tgm-icon-btn tgm-tool-btn" title="Clear the selection"><i class="fa-solid fa-ban"></i></button>
                        <button id="tgmPickSeedSelection" class="tgm-seed-chip" title="Use the characters selected in the grid"><i class="fa-solid fa-square-check"></i> Grid selection <span></span></button>
                        <button id="tgmPickSeedFilter" class="tgm-seed-chip" title="Use every character in the grid's current search/filter results"><i class="fa-solid fa-filter"></i> Grid filter <span></span></button>
                    </div>
                    <div id="tgmPickList" class="tgm-list"></div>
                    <div class="tgm-pick-footer">
                        <span id="tgmPickCount" class="tgm-total"></span>
                        <button id="tgmPickOpenBtn" class="cl-btn cl-btn-primary" title="Open the batch tag editor for the selected characters"><i class="fa-solid fa-tags"></i> Edit Tags...</button>
                    </div>
                </div>

                <div class="tgm-pane hidden" data-tab="rules">
                    <div class="tgm-hint-banner">
                        <i class="fa-solid fa-circle-info"></i>
                        <span>Rules rewrite tags arriving from <strong>provider imports</strong>, top to bottom, first match wins. Match exactly (case-insensitive) or with <strong>/regex/</strong> (the replacement may use <strong>$1</strong> groups); an empty replacement drops the tag. While anything here is active, imports also get whitespace trimmed and duplicates merged. Local files are never rewritten.</span>
                    </div>
                    <div class="tgm-alias-toggles">
                        <label class="tgm-strip-toggle" title="Removes emoji and decorations on import, e.g. a fire-emoji Female tag becomes just Female">
                            <input type="checkbox" id="tgmStripDecor">
                            Strip emoji and decoration from imported tags
                            <span id="tgmStripImpact" class="tgm-rule-impact"></span>
                        </label>
                        <label class="tgm-strip-toggle" title="Trims stray whitespace on imported tags and merges the duplicates that creates, even with no rules defined">
                            <input type="checkbox" id="tgmTrimSpaces">
                            Clean whitespace on imported tags
                            <span id="tgmTrimImpact" class="tgm-rule-impact"></span>
                        </label>
                        <label class="tgm-strip-toggle" title="Capitalizes the first letter of imported tags; tags produced by a rule keep the rule's exact casing">
                            <input type="checkbox" id="tgmCapitalize">
                            Capitalize the first letter of imported tags
                            <span id="tgmCapImpact" class="tgm-rule-impact"></span>
                        </label>
                    </div>
                    <div class="tgm-toolbar">
                        <input type="search" id="tgmRuleSearch" class="cl-input" placeholder="Search rules..." autocomplete="one-time-code" title="Filter rules by match or replacement text (reordering is available on the unfiltered list)">
                    </div>
                    <div id="tgmRulesHeader" class="tgm-rule-header hidden"><span>When a tag matches</span><span></span><span>it becomes</span><span></span></div>
                    <div id="tgmRulesList" class="tgm-rules-list"></div>
                    <div class="tgm-rules-actions">
                        <button id="tgmAddRuleBtn" class="cl-btn cl-btn-secondary" title="Rules apply top to bottom; the first matching rule wins"><i class="fa-solid fa-plus"></i> Add Rule</button>
                        <button id="tgmApplyRulesBtn" class="cl-btn cl-btn-primary" title="Run the ruleset once over every character already in the library"><i class="fa-solid fa-bolt"></i> Apply to Library Now</button>
                    </div>
                    <div class="tgm-rule-test" title="Preview what the rules would do to a tag">
                        <i class="fa-solid fa-flask tgm-rule-test-icon"></i>
                        <input type="search" id="tgmRuleTestInput" class="cl-input" placeholder="Test a tag..." autocomplete="one-time-code">
                        <i class="fa-solid fa-arrow-right tgm-rule-arrow"></i>
                        <span id="tgmRuleTestOut"></span>
                    </div>
                </div>
            </div>

            <div id="tgmProgress" class="tgm-progress hidden">
                <div class="tgm-progress-track"><div id="tgmProgressFill" class="tgm-progress-fill"></div></div>
                <span id="tgmProgressText"></span>
                <button id="tgmAbortBtn" class="cl-btn cl-btn-danger" title="Stop after the character currently being written">Abort</button>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

export function init() {
    if (isInitialized) {
        console.warn('[TagsManager] Already initialized');
        return;
    }

    injectModal();
    setupEventListeners();

    // Tier 8; the global Escape is capture-phase, so close() cancels an active rename first.
    window.registerOverlay?.({
        id: 'tagsManagerModal',
        tier: 8,
        close: () => {
            const rename = document.querySelector('#tagsManagerModal .tgm-rename-input');
            if (rename) { rename.blur(); return; }
            closeModal();
        },
        visible: (el) => el.classList.contains('visible'),
    });

    isInitialized = true;
    debugLog('[TagsManager] Module initialized');
}

export default {
    init,
    openModal
};
