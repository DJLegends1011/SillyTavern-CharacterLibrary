import CoreAPI from './core-api.js';

// ========================================
// MEDIA DOWNLOAD QUEUE
// Serial background runner for post-import media localization. Jobs wrap
// downloadCharacterMedia one character at a time; the pending list survives
// reloads via a Files-API mirror and resumes in self-scan mode (the pipeline
// re-scans fields and re-discovers the provider link from the card, so only
// avatar + folder + phases need to persist).
// ========================================

const QUEUE_FILE = '_cl_media_dl_queue.json';
const STORAGE_VERSION = 1;

let jobs = [];              // rich in-memory jobs, FIFO by enqueue order
let working = false;
let abortController = null;
let loaded = false;
let saving = false;
let saveQueued = false;
let _loadingPromise = null;

const listeners = new Set();
let _lastNotify = 0;
let _notifyTimer = 0;

// Import flows pass ST's import response file_name, which has NO extension,
// while every live char.avatar carries .png. The queue keys jobs by avatar
// (live lookups, completed-set checks, deletion eviction), so normalize at
// the boundary; this also heals entries persisted before the fix.
function canonicalAvatar(avatar) {
    const a = String(avatar || '');
    if (!a) return a;
    return /\.png$/i.test(a) ? a : `${a}.png`;
}

// ========================================
// FILE I/O
// ========================================

async function fileUpload(name, data) {
    const base64 = CoreAPI.utf8ToBase64(JSON.stringify(data));
    const resp = await CoreAPI.apiRequest('/files/upload', 'POST', { name, data: base64 });
    if (!resp.ok) {
        const err = await resp.text().catch(() => resp.statusText);
        throw new Error(`Queue file upload failed (${resp.status}): ${err}`);
    }
    return resp.json();
}

async function fileRead(name) {
    try {
        const resp = await fetch(`/user/files/${name}`, { cache: 'no-store' });
        if (!resp.ok) return null;
        const text = await resp.text();
        if (!text || !text.trim()) return null;
        return JSON.parse(text);
    } catch {
        return null;
    }
}

// ========================================
// PERSISTENCE
// Only pending/active survive a reload; done/failed are session-visible only.
// Active resumes as pending (hash dedupe makes the re-run skip finished files).
// ========================================

function serializeQueue() {
    return {
        version: STORAGE_VERSION,
        jobs: jobs
            .filter(j => j.state === 'pending' || j.state === 'active')
            .map(j => ({ avatar: j.avatar, name: j.name, folderName: j.folderName, phases: j.phases })),
    };
}

async function saveQueueFile() {
    // First write may land before the boot read finished; complete the read
    // first so we never clobber a file we havent seen
    if (!loaded) await loadQueueFile();
    if (saving) {
        saveQueued = true;
        return;
    }
    saving = true;
    try {
        const data = serializeQueue();
        await fileUpload(QUEUE_FILE, data);
        CoreAPI.debugLog(`[MediaDLQueue] Saved queue file (${data.jobs.length} entries)`);
    } catch (e) {
        console.error('[MediaDLQueue] Save failed:', e.message);
    } finally {
        saving = false;
        if (saveQueued) {
            saveQueued = false;
            saveQueueFile();
        }
    }
}

let _persistedEntries = null;

async function loadQueueFile() {
    if (loaded) return _persistedEntries || [];
    if (_loadingPromise) return _loadingPromise;
    _loadingPromise = (async () => {
        const data = await fileRead(QUEUE_FILE);
        loaded = true;
        _loadingPromise = null;
        _persistedEntries = (data && data.version === STORAGE_VERSION && Array.isArray(data.jobs)) ? data.jobs : [];
        return _persistedEntries;
    })();
    return _loadingPromise;
}

// ========================================
// CHANGE NOTIFICATION (throttled; progress ticks fire per file)
// ========================================

function notify(immediate = false) {
    const fire = () => {
        _lastNotify = Date.now();
        for (const cb of listeners) {
            try { cb(); } catch (e) { console.error('[MediaDLQueue] listener failed:', e); }
        }
    };
    if (immediate || Date.now() - _lastNotify > 150) {
        clearTimeout(_notifyTimer);
        _notifyTimer = 0;
        fire();
    } else if (!_notifyTimer) {
        _notifyTimer = setTimeout(() => { _notifyTimer = 0; fire(); }, 150);
    }
}

export function onQueueChange(cb) {
    if (typeof cb === 'function') listeners.add(cb);
    return () => listeners.delete(cb);
}

// ========================================
// QUEUE OPERATIONS
// ========================================

/**
 * Add a background download job. Rich payloads (import flows) carry the
 * pre-extracted URL lists + provider override; minimal payloads (resume)
 * run the pipeline in self-scan mode.
 * @param {Object} payload - { avatar, name, folderName, phases, embeddedUrls?,
 *   lorebookUrls?, galleryPageUrls?, providerOverride?, pseudoChar? }
 */
export function enqueueJob(payload) {
    if (!payload?.avatar || !payload.folderName) return false;
    const avatar = canonicalAvatar(payload.avatar);
    // Re-import of the same character supersedes its queued/failed job
    const existing = jobs.findIndex(j => j.avatar === avatar && j.state !== 'active' && j.state !== 'done');
    if (existing !== -1) jobs.splice(existing, 1);
    const pseudoChar = payload.pseudoChar ? { ...payload.pseudoChar, avatar } : undefined;
    jobs.push({
        avatar,
        name: payload.name || avatar,
        folderName: payload.folderName,
        phases: payload.phases || undefined,
        embeddedUrls: payload.embeddedUrls,
        lorebookUrls: payload.lorebookUrls,
        galleryPageUrls: payload.galleryPageUrls,
        providerOverride: payload.providerOverride,
        pseudoChar,
        state: 'pending',
        progress: { phase: '', done: 0, total: 0 },
        totals: null,
        error: '',
        enqueuedAt: Date.now(),
    });
    saveQueueFile();
    notify(true);
    runNext();
    return true;
}

export function retryJob(avatar) {
    const job = jobs.find(j => j.avatar === avatar && (j.state === 'failed' || j.state === 'aborted'));
    if (!job) return false;
    // Retry runs in self-scan mode: the original URL lists may be stale and
    // the card is in the library by now, so a fresh scan is the safer source
    job.embeddedUrls = undefined;
    job.lorebookUrls = undefined;
    job.galleryPageUrls = undefined;
    job.providerOverride = undefined;
    job.pseudoChar = undefined;
    job.state = 'pending';
    job.error = '';
    job.progress = { phase: '', done: 0, total: 0 };
    saveQueueFile();
    notify(true);
    runNext();
    return true;
}

export function removeJob(avatar) {
    const job = jobs.find(j => j.avatar === avatar);
    if (!job) return false;
    if (job.state === 'active') {
        abortController?.abort();
        return true; // worker finalizes it as aborted; caller can remove after
    }
    jobs = jobs.filter(j => j !== job);
    saveQueueFile();
    notify(true);
    return true;
}

export function abortCurrentJob() {
    abortController?.abort();
}

export function clearFinishedJobs() {
    jobs = jobs.filter(j => j.state === 'pending' || j.state === 'active');
    notify(true);
}

export function onCharacterDeleted(avatar) {
    const job = jobs.find(j => j.avatar === avatar);
    if (!job) return;
    if (job.state === 'active') abortController?.abort();
    jobs = jobs.filter(j => j !== job);
    saveQueueFile();
    notify(true);
}

export function getQueueState() {
    return {
        active: jobs.find(j => j.state === 'active') || null,
        pending: jobs.filter(j => j.state === 'pending'),
        failed: jobs.filter(j => j.state === 'failed' || j.state === 'aborted'),
        done: jobs.filter(j => j.state === 'done'),
    };
}

// ========================================
// WORKER (strictly serial; the pipeline mutates per-folder dedup state)
// ========================================

async function runNext() {
    if (working) return;
    const job = jobs.find(j => j.state === 'pending');
    if (!job) return;
    working = true;
    job.state = 'active';
    abortController = new AbortController();
    notify(true);

    try {
        // Resolve the live char; rich import jobs fall back to their pseudoChar
        // (the import loop builds one before the library refresh lands)
        const char = CoreAPI.getAllCharacters().find(c => c.avatar === job.avatar) || job.pseudoChar;
        if (!char) throw new Error('Character not found in library');

        const result = await CoreAPI.downloadCharacterMedia(char, job.folderName, {
            embeddedUrls: job.embeddedUrls,
            lorebookUrls: job.lorebookUrls,
            galleryPageUrls: job.galleryPageUrls,
            providerOverride: job.providerOverride,
            phases: job.phases,
            signal: abortController.signal,
            onPhaseStart: (phase, ctx) => {
                job.progress.phase = phase;
                job.progress.done = 0;
                job.progress.total = ctx?.count || 0;
                notify();
            },
            onProgress: (phase, current, total) => {
                job.progress.phase = phase;
                job.progress.done = current;
                job.progress.total = total;
                notify();
            },
        });

        job.totals = result?.totals || null;
        if (result?.aborted) {
            job.state = 'aborted';
            job.error = 'Cancelled';
        } else if (result?.incomplete || (result?.totals?.errors || 0) > 0) {
            job.state = 'failed';
            job.error = `${result?.totals?.errors || 0} download error(s)`;
        } else {
            job.state = 'done';
            CoreAPI.markMediaLocalizationComplete(job.avatar);
        }
    } catch (e) {
        job.state = 'failed';
        job.error = e?.message || 'Download failed';
        console.error('[MediaDLQueue] Job failed:', job.avatar, e);
    } finally {
        working = false;
        abortController = null;
        saveQueueFile();
        notify(true);
        runNext();
    }
}

// ========================================
// RESUME
// ========================================

async function resumePersistedJobs() {
    const persisted = await loadQueueFile();
    CoreAPI.debugLog(`[MediaDLQueue] Resume check: ${persisted.length} persisted entr${persisted.length === 1 ? 'y' : 'ies'}`);
    if (!persisted.length) return;
    const completed = CoreAPI.getCompletedMediaLocalizations() || new Set();
    const all = CoreAPI.getAllCharacters();
    let resumed = 0;
    for (const entry of persisted) {
        if (!entry?.avatar || !entry.folderName) {
            CoreAPI.debugLog('[MediaDLQueue] Resume skip (malformed entry):', JSON.stringify(entry));
            continue;
        }
        const avatar = canonicalAvatar(entry.avatar);
        if (completed.has?.(avatar)) {
            CoreAPI.debugLog('[MediaDLQueue] Resume skip (already completed):', avatar);
            continue;
        }
        if (!all.some(c => c.avatar === avatar)) {
            CoreAPI.debugLog('[MediaDLQueue] Resume skip (character not found):', avatar);
            continue;
        }
        if (jobs.some(j => j.avatar === avatar)) continue;
        jobs.push({
            avatar,
            name: entry.name || avatar,
            folderName: entry.folderName,
            phases: entry.phases || undefined,
            state: 'pending',
            progress: { phase: '', done: 0, total: 0 },
            totals: null,
            error: '',
            enqueuedAt: Date.now(),
        });
        resumed++;
    }
    if (resumed > 0) {
        CoreAPI.debugLog(`[MediaDLQueue] Resumed ${resumed} persisted job(s)`);
        notify(true);
        runNext();
    } else {
        // Stale file (everything finished or got deleted); rewrite it empty
        saveQueueFile();
    }
}

// ========================================
// NOTIFICATIONS SECTION
// ========================================

const PHASE_LABELS = {
    embedded: 'Embedded media',
    lorebook: 'Lorebook media',
    providerGallery: 'Provider gallery',
    extGallery: 'External galleries',
};

function sectionStatus() {
    const s = getQueueState();
    const activeCount = (s.active ? 1 : 0) + s.pending.length;
    if (activeCount > 0) {
        return {
            visible: true,
            level: 'activity',
            icon: 'fa-solid fa-download',
            title: `Downloading media in background (${activeCount} job${activeCount === 1 ? '' : 's'})`,
        };
    }
    if (s.failed.length > 0) {
        return {
            visible: true,
            level: 'warning',
            badge: s.failed.length,
            title: `${s.failed.length} background media download${s.failed.length === 1 ? '' : 's'} failed`,
        };
    }
    // Recently finished jobs stay reviewable until cleared
    return { visible: s.done.length > 0, level: 'none', title: 'Background media downloads' };
}

function renderSection(el) {
    if (!el) return;
    const esc = CoreAPI.escapeHtml;
    const s = getQueueState();
    if (!s.active && !s.pending.length && !s.failed.length && !s.done.length) {
        el.innerHTML = '';
        return;
    }
    const parts = ['<div class="mdq-section">'];
    parts.push('<div class="mdq-header"><i class="fa-solid fa-download"></i><span>Media Downloads</span></div>');

    if (s.active) {
        const p = s.active.progress;
        const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
        const phaseLabel = PHASE_LABELS[p.phase] || 'Preparing';
        const sub = p.total ? `${esc(phaseLabel)} <span class="mdq-job-meta">${p.done}/${p.total} &middot; ${pct}%</span>` : `${esc(phaseLabel)}&hellip;`;
        parts.push(`
            <div class="mdq-job mdq-active">
                <span class="mdq-job-icon"><i class="fa-solid fa-cloud-arrow-down"></i></span>
                <div class="mdq-job-body">
                    <div class="mdq-job-line">
                        <span class="mdq-job-name">${esc(s.active.name)}</span>
                        <button class="mdq-job-btn" data-mdq-abort title="Cancel this download"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div class="mdq-job-sub">${sub}</div>
                    <div class="mdq-progress"><div class="mdq-progress-fill" style="width:${pct}%"></div></div>
                </div>
            </div>`);
    }
    if (s.pending.length > 0) {
        parts.push(`<div class="mdq-pending"><i class="fa-solid fa-hourglass-half"></i> ${s.pending.length} more queued</div>`);
    }
    for (const job of s.failed) {
        parts.push(`
            <div class="mdq-job mdq-failed">
                <span class="mdq-job-icon mdq-job-icon-error"><i class="fa-solid fa-triangle-exclamation"></i></span>
                <div class="mdq-job-body">
                    <div class="mdq-job-line">
                        <span class="mdq-job-name">${esc(job.name)}</span>
                        <span class="mdq-job-actions">
                            <button class="mdq-job-btn" data-mdq-retry="${esc(job.avatar)}" title="Retry"><i class="fa-solid fa-rotate-right"></i></button>
                            <button class="mdq-job-btn" data-mdq-remove="${esc(job.avatar)}" title="Dismiss"><i class="fa-solid fa-xmark"></i></button>
                        </span>
                    </div>
                    <div class="mdq-job-sub mdq-error">${esc(job.error || 'Failed')}</div>
                </div>
            </div>`);
    }
    if (s.done.length > 0) {
        parts.push(`
            <div class="mdq-done-row">
                <span><i class="fa-solid fa-circle-check"></i> ${s.done.length} completed</span>
                <button class="mdq-job-btn" data-mdq-clear title="Clear finished"><i class="fa-solid fa-broom"></i></button>
            </div>`);
    }
    parts.push('</div>');
    el.innerHTML = parts.join('');
}

function wireSectionEvents(el) {
    // One delegated listener on the persistent section node
    el.addEventListener('click', (e) => {
        const abortBtn = e.target.closest('[data-mdq-abort]');
        if (abortBtn) { abortCurrentJob(); return; }
        const retryBtn = e.target.closest('[data-mdq-retry]');
        if (retryBtn) { retryJob(retryBtn.dataset.mdqRetry); return; }
        const removeBtn = e.target.closest('[data-mdq-remove]');
        if (removeBtn) { removeJob(removeBtn.dataset.mdqRemove); return; }
        if (e.target.closest('[data-mdq-clear]')) clearFinishedJobs();
    });
}

function isSectionShowing(el) {
    const dropdown = document.getElementById('notificationsDropdown');
    return !!el && !!dropdown && !dropdown.classList.contains('hidden');
}

// ========================================
// INIT
// ========================================

function init() {
    CoreAPI.registerNotificationSection({
        id: 'media-downloads',
        getStatus: sectionStatus,
        onOpen: (el) => renderSection(el),
    });
    const sectionEl = document.querySelector('#notificationsDropdown [data-notif-section="media-downloads"]');
    if (sectionEl) wireSectionEvents(sectionEl);
    onQueueChange(() => {
        CoreAPI.refreshNotificationsUI();
        if (isSectionShowing(sectionEl)) renderSection(sectionEl);
    });

    // Read the persisted file immediately so saves are never gated on the
    // resume timing below (an import can land before characters finish loading)
    loadQueueFile();

    // Resume needs data.extensions intact (provider gallery discovery reads the
    // link), so under ST lazy loading wait for recovery, not just the char list
    const start = () => {
        if (CoreAPI.isExtensionsRecoveryInProgress()) {
            CoreAPI.debugLog('[MediaDLQueue] Resume deferred until extensions recovery');
            document.addEventListener('cl-extensions-recovered', () => resumePersistedJobs(), { once: true });
        } else {
            resumePersistedJobs();
        }
    };
    if (CoreAPI.getAllCharacters().length > 0) {
        CoreAPI.debugLog('[MediaDLQueue] Characters already loaded at init');
        start();
    } else {
        CoreAPI.debugLog('[MediaDLQueue] Waiting for cl-characters-loaded');
        document.addEventListener('cl-characters-loaded', start, { once: true });
    }
}

export default {
    init,
    enqueueJob,
    retryJob,
    removeJob,
    abortCurrentJob,
    clearFinishedJobs,
    getQueueState,
    onQueueChange,
    onCharacterDeleted,
};
