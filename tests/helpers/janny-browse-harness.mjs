import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { collectionEntryCharacterId, collectionEntryMatchesCharacter } from '../../modules/providers/janny/janny-collection-membership.js';
import { orderJannyCollectionCharacters } from '../../modules/providers/janny/janny-collection-order.js';

const source = readFileSync(new URL('../../modules/providers/janny/janny-browse.js', import.meta.url), 'utf8');
export const flush = () => new Promise(resolve => setImmediate(resolve));
export const ready = { browser: true, active: true, cloudflare: false, reason: '', code: '' };
export const failure = code => Object.assign(new Error('Synthetic transport error'), { code });
export function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

// Execute the complete production module with only its DOM, base view and service
// boundaries supplied. run() accesses its real lexical state/handlers, not replicas.
export function browseHarness(overrides = {}) {
    const elements = new Map(), toasts = [], settingsOpened = [], handlers = new Map();
    function el(id) {
        if (!elements.has(id)) {
            const classes = new Set();
            elements.set(id, {
                id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, dataset: {},
                classList: {
                    add: (...names) => names.forEach(n => classes.add(n)),
                    remove: (...names) => names.forEach(n => classes.delete(n)),
                    contains: n => classes.has(n),
                    toggle: (n, force = !classes.has(n)) => force ? classes.add(n) : classes.delete(n),
                },
                setAttribute(name, value) { this[name] = value; },
                querySelector() { return null; }, querySelectorAll() { return []; },
                addEventListener() {}, scrollIntoView() {}, focus() {},
                insertAdjacentHTML(_position, html) { this.innerHTML += html; },
            });
        }
        return elements.get(id);
    }
    class BrowseView {
        constructor() { this._lookup = { byProviderId: new Set() }; }
        init() {} activate() {} buildLocalLibraryLookup() {} observeImages() {}
        _registerDropdownDismiss() {}
        updateLoadMoreVisibility() {} isCharPossibleMatch() { return false; }
        static adjustPortraitPosition() {} static closeAvatarViewer() {}
        static wireTitleScroll() {}
    }
    const CoreAPI = {
        onElement: (id, type, fn) => handlers.set(`${id}:${type}`, fn),
        showToast: (...args) => toasts.push(args), debugLog() {},
        escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        getSetting() {}, getProviderExcludeTags: () => [], setSetting() {}, debounce: fn => fn,
        renderSkeletonGrid() {}, resetBrowseSectionCollapseState() {},
        setBrowseAltGreetings() {}, cleanupCreatorNotesContainer() {},
        formatRichText: s => s, safePurify: s => s, renderCardHtmlSecure() {},
        openSettingsToSection: (section, callback) => { settingsOpened.push(section); callback?.(); return true; },
        checkCharacterForDuplicatesAsync: async () => [], showConfirm: async () => true,
        ...overrides.CoreAPI,
    };
    const context = vm.createContext({
        window: {}, document: { getElementById: id => elements.get(id) || null, querySelectorAll: () => [], addEventListener() {} },
        console: { warn() {}, error() {} }, requestAnimationFrame() {},
        BrowseView, CoreAPI, TAG_MAP: {}, JANNY_SITE_BASE: 'https://jannyai.com', JANNY_IMAGE_BASE: 'https://image.test/',
        IMG_PLACEHOLDER: '', BROWSE_PURIFY_CONFIG: {}, formatNumber: String,
        slugify: s => s.toLowerCase(), stripHtml: s => s || '', resolveTagNames: () => [],
        skeletonLines: () => 'Loading...', deferCall: (el, fn) => fn(), deferRender: (el, fn) => { el.innerHTML = fn(); },
        collectionEntryCharacterId, collectionEntryMatchesCharacter, orderJannyCollectionCharacters,
        probeJannyAccount: async () => ({ ...ready }),
        // Fail-closed default: no browser session is installed unless a test says otherwise,
        // so a 401 reads as a real rejection rather than a duplicate-add no-op.
        jannySessionStatus: async () => ({ active: false, email: '', expMs: 0, hasRefresh: false, refreshable: false }),
        fetchJannyBookmarks: async () => [], fetchJannyCollections: async () => [],
        fetchJannyCollectionCharacters: async () => [],
        addJannyBookmarks: async () => [], removeJannyBookmarks: async () => [],
        addJannyCharacterToCollection: async () => ({}), removeJannyCharacterFromCollection: async () => ({}),
        updateJannyCollection: async () => ({}), deleteJannyCollection: async () => ({}),
        isJanitorBridgeAvailable: () => false, warmJanitorClearance: async () => {},
        ...overrides, CoreAPI,
    });
    vm.runInContext(source.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\r?\n/gm, '').replace('export default jannyBrowseView;', ''), context);
    const run = code => vm.runInContext(code, context);
    const seedAccount = () => run(`
        jannyAccountStatus = { browser: true, active: true, cloudflare: false, reason: '', code: '' };
        jannySelectedChar = { id: 'old-character', name: 'Old character' };
        jannyBookmarkIds = new Set(['old-character']); jannyBookmarksLoaded = true;
        jannyBookmarkTotalCount = 220; jannyBookmarkLimitToastShown = true;
        jannyOwnedCollections = [{ id: 'old-collection', name: 'Old private collection', characterCount: 1 }];
        jannyOwnedCollectionsLoaded = true;
        jannyModalCollectionIds = new Set(['old-collection']);
        jannyModalCollectionChecksLoadedFor = 'old-character';
    `);
    return { context, run, el, elements, toasts, settingsOpened, handlers, window: context.window, seedAccount };
}
