import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { migrateJannyRow, scanJannyMigrationRows } from '../modules/providers/janny/janny-link-migration.js';

const html = readFileSync(new URL('../app/library.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../app/library.js', import.meta.url), 'utf8');

class Element {
    constructor(id = '') {
        this.id = id;
        this.innerHTML = '';
        this.textContent = '';
        this.disabled = false;
        this.checked = false;
        this.listeners = {};
        const classes = new Set();
        this.classList = {
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            contains: name => classes.has(name),
        };
    }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    querySelector() { return null; }
    async dispatch(name) {
        const event = { target: this, preventDefault() {} };
        await this[`on${name}`]?.(event);
        for (const listener of this.listeners[name] || []) await listener(event);
    }
}

function harness({ detail, fetchCharacter, removeSource = false } = {}) {
    const elements = new Map();
    for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, new Element(id));
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const allCharacters = [{
        avatar: 'janny.png',
        name: 'Janny survivor',
        data: { extensions: { jannyai: { id, pageName: 'Janny survivor', tagline: 'Mirror copy' } } },
    }];
    const writes = [];
    const window = {
        scanJannyMigrationRows,
        migrateJannyRow,
        janitoraiFetchCharacter: fetchCharacter || (async () => detail),
        applyCardFieldUpdates: async (...args) => { writes.push(args); return true; },
        ProviderRegistry: {
            rebuildAllBrowseLookups() {},
            refreshActiveBrowseBadges() {},
        },
        registerOverlay() {},
    };
    const context = vm.createContext({
        window,
        document: { getElementById: key => elements.get(key) || null },
        allCharacters,
        extensionsReady: () => true,
        getCharacterName: char => char.name,
        getCharacterAvatarStThumbUrl: avatar => `/thumbnail/${avatar}`,
        escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        showToast() {},
        activeChar: null,
        isCharModalDirty: () => false,
        performSearch() {},
        ST_UNSET_SENTINEL: '__DELETE__',
        CSS: { escape: value => String(value) },
        setTimeout: fn => { fn(); return 0; },
        Promise,
        AbortController,
    });
    const start = js.indexOf('    // ── JannyAI -> JanitorAI batch re-link');
    const end = js.indexOf('    // ── End JannyAI -> JanitorAI batch re-link', start);
    assert.ok(start >= 0 && end > start, 'Janny migration settings handler must exist');
    vm.runInContext(js.slice(start, end), context);
    const remove = elements.get('jannyRelinkRemoveOld');
    assert.ok(remove, 'Janny removal option must exist');
    remove.checked = removeSource;
    return { elements, writes, el: key => elements.get(key) };
}

test('the settings migration keeps a Janny-only card when JanitorAI returns 404', async () => {
    const h = harness({ detail: null });
    await h.el('migrateJannyLinksBtn').dispatch('click');
    assert.equal(h.el('jannyRelinkModal').classList.contains('visible'), true);
    await h.el('jannyRelinkRunBtn').dispatch('click');
    assert.deepEqual(h.writes, []);
    assert.match(h.el('jannyRelinkProgress').textContent, /kept on JannyAI/i);
    assert.equal(h.el('jannyRelinkSelCount').textContent, '0 selected');
});

test('the settings migration adds a verified JanitorAI link without removing Janny by default', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const h = harness({ detail: { id, name: 'Janitor survivor' } });
    await h.el('migrateJannyLinksBtn').dispatch('click');
    await h.el('jannyRelinkRunBtn').dispatch('click');
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0][1]['extensions.janitorai.id'], id);
    assert.equal('extensions.jannyai' in h.writes[0][1], false);
});

test('cancelling while JanitorAI verification is pending prevents the write', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let release;
    let started;
    const startedPromise = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const h = harness({
        fetchCharacter: async (_id, { signal } = {}) => {
            started();
            await pending;
            if (signal?.aborted) throw signal.reason;
            return { id, name: 'Janitor survivor' };
        },
    });
    await h.el('migrateJannyLinksBtn').dispatch('click');
    const run = h.el('jannyRelinkRunBtn').dispatch('click');
    await startedPromise;
    await h.el('jannyRelinkCancelBtn').dispatch('click');
    release();
    await run;

    assert.deepEqual(h.writes, []);
    assert.match(h.el('jannyRelinkProgress').textContent, /^Stopped\./);
});
