import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { browseHarness } from './helpers/janny-browse-harness.mjs';

const html = readFileSync(new URL('../app/library.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../app/library.js', import.meta.url), 'utf8');

// Execute the actual settings regions; fake only DOM and external-service boundaries.
// The unrelated gallery and its thousands of listeners need not load for these tests.
class Element {
    constructor(id = '') {
        this.id = id;
        this.value = '';
        this.type = id === 'settingsJannyToken' ? 'password' : 'text';
        this.innerHTML = '';
        this.textContent = '';
        this.disabled = false;
        this.listeners = {};
        const classes = new Set();
        this.classList = {
            add: name => classes.add(name), remove: name => classes.delete(name),
            contains: name => classes.has(name),
            toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
        };
        this._customSelect = { update() {} };
    }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    closest() { return this.row ||= new Element(); }
    querySelector() { return this.label ||= new Element(); }
    async dispatch(name) {
        const event = { target: this, preventDefault() {} };
        await this[`on${name}`]?.(event);
        for (const listener of this.listeners[name] || []) await listener(event);
        await flush();
    }
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const activeStatus = { active: true, email: 'reader@example.test', expMs: 2000000000000, hasRefresh: true, refreshable: true };

async function harness(overrides = {}) {
    const elements = new Map();
    for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, new Element(id));
    const settings = { janitoraiBrowserMode: 'managed', janitoraiBrowserEndpoint: null };
    const writes = [], calls = [], toasts = [], installs = [];
    const window = {
        jannySessionStatus: async () => { calls.push(['session-status']); return { ...activeStatus }; },
        jannySetSession: async raw => { installs.push(raw); return { ok: true, ...activeStatus }; },
        jannyLogout: async () => ({ ok: true, cleared: ['sb-eenzcbluoctduymzksoq-auth-token.0'] }),
        jannyTestBrowserEndpoint: async endpoint => {
            calls.push(['test', endpoint]);
            return { ok: true, checks: [{ key: 'cloudflare', label: 'JannyAI Cloudflare', ok: true, detail: 'Ready' }] };
        },
        ...overrides,
    };
    const context = vm.createContext({
        document: { getElementById: id => elements.get(id) || null }, window,
        getSetting: key => settings[key], setSetting: (key, value) => { writes.push([key, value]); settings[key] = value; },
        apiRequest: async (path, method, body) => {
            calls.push([path, method, body]);
            return { ok: true, status: 200, json: async () => ({ ok: true, running: true, browser: 'Chrome', binary: '/chrome', idleStopMinutes: 10 }) };
        },
        showToast: (...args) => toasts.push(args),
        escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
        updateJanitoraiStatus() {},
    });
    const declarations = js.slice(js.indexOf('    const jannySettingsRefreshBtn ='), js.indexOf('    const minScoreSlider ='));
    const accountStart = js.indexOf('    async function refreshJannySettingsAccountStatus()');
    const start = js.lastIndexOf('    // JannyAI', accountStart);
    const end = js.indexOf('    // Open modal', accountStart);
    assert.ok(start >= 0 && end > start, 'Janny settings region must be available');
    const janitorStart = js.indexOf("    const janitoraiEndpointInput = document.getElementById('settingsJanitoraiBrowserEndpoint')");
    const janitorEnd = js.indexOf('    if (janitoraiBrowserLoginBtn) {', janitorStart);
    vm.runInContext(declarations + js.slice(start, end) + js.slice(janitorStart, janitorEnd), context);
    await flush();
    return { settings, writes, calls, toasts, installs, window, context, el: id => elements.get(id) };
}

for (const action of ['saveJannyTokenBtn', 'clearJannyTokenBtn']) {
    test(`${action} clears real browse account caches after success`, async () => {
        const browse = browseHarness(); browse.seedAccount();
        const h = await harness({ jannyInvalidateAccountCache: browse.window.jannyInvalidateAccountCache });
        h.el('settingsJannyToken').value = 'synthetic-session';
        await h.el(action).dispatch('click');
        assert.equal(browse.run('jannyBookmarkIds.size + jannyOwnedCollections.length + jannyModalCollectionIds.size'), 0);
        assert.equal(browse.run('jannyBookmarksLoaded || jannyOwnedCollectionsLoaded'), false);
    });
}

test('refresh detecting an inactive browser session invalidates browse account data', async () => {
    const browse = browseHarness(); browse.seedAccount();
    const h = await harness({ jannyInvalidateAccountCache: browse.window.jannyInvalidateAccountCache, jannySessionStatus: async () => ({ active: false }) });
    await h.el('jannySettingsRefreshBtn').dispatch('click');
    assert.equal(browse.run('jannyBookmarkIds.size + jannyOwnedCollections.length'), 0);
});

for (const [action, boundary] of [['saveJannyTokenBtn', 'jannySetSession'], ['clearJannyTokenBtn', 'jannyLogout']]) {
    test(`${action} also clears old caches after uncertain browser failure without claiming success`, async () => {
        const browse = browseHarness(); browse.seedAccount();
        const h = await harness({ jannyInvalidateAccountCache: browse.window.jannyInvalidateAccountCache, [boundary]: async () => { throw new Error('Synthetic failure'); } });
        h.el('settingsJannyToken').value = 'synthetic-session';
        await h.el(action).dispatch('click');
        assert.equal(browse.run('jannyBookmarkIds.size + jannyOwnedCollections.length'), 0);
        assert.equal(h.toasts.some(([, type]) => type === 'success'), false);
    });
}

test('Janny writes shared browser settings and both sections re-read them on expansion', async () => {
    const h = await harness();
    const mode = h.el('settingsJannyBrowserMode');
    assert.ok(mode, 'Janny mode control exists');
    assert.equal(mode.value, 'managed');
    assert.equal(h.el('settingsJannyBrowserEndpoint').classList.contains('cl-hidden'), true);
    mode.value = 'endpoint';
    await mode.dispatch('change');
    assert.equal(h.settings.janitoraiBrowserMode, 'endpoint');
    assert.equal(h.el('jannyManagedStatusRow').classList.contains('cl-hidden'), true);
    assert.equal(h.el('saveJannyTokenBtn').disabled, true);
    h.el('settingsJannyBrowserEndpoint').value = ' http://browser.test:9222 ';
    await h.el('settingsJannyBrowserEndpoint').dispatch('change');
    assert.equal(h.settings.janitoraiBrowserEndpoint, 'http://browser.test:9222');
    assert.equal(h.el('saveJannyTokenBtn').disabled, false);
    h.el('settingsJanitoraiSection').open = true;
    await h.el('settingsJanitoraiSection').dispatch('toggle');
    assert.equal(h.el('settingsJanitoraiBrowserMode').value, 'endpoint');
    assert.equal(h.el('settingsJanitoraiBrowserEndpoint').value, 'http://browser.test:9222');
    h.el('settingsJanitoraiBrowserEndpoint').value = 'http://other.test:9222';
    await h.el('settingsJanitoraiBrowserEndpoint').dispatch('change');
    h.el('settingsJannySection').open = true;
    await h.el('settingsJannySection').dispatch('toggle');
    assert.equal(h.el('settingsJannyBrowserEndpoint').value, 'http://other.test:9222');
    h.el('settingsJanitoraiBrowserMode').value = 'managed';
    await h.el('settingsJanitoraiBrowserMode').dispatch('change');
    await h.el('settingsJannySection').dispatch('toggle');
    assert.equal(mode.value, 'managed');
    assert.equal(h.el('jannyEndpointHintRow').classList.contains('cl-hidden'), true);
    assert.ok(h.writes.every(([key]) => ['janitoraiBrowserMode', 'janitoraiBrowserEndpoint'].includes(key)));
});

test('Janny Start/Stop/Status use Janny helper routes while Janitor routes stay unchanged', async () => {
    const h = await harness();
    assert.ok(h.el('jannyManagedStartBtn'), 'Janny start button exists');
    await h.el('jannyManagedStartBtn').dispatch('click');
    await h.el('jannyManagedStopBtn').dispatch('click');
    for (const [action, method] of [['start', 'POST'], ['stop', 'POST'], ['status', 'GET']]) {
        assert.ok(h.calls.some(([path, verb]) => path === `/plugins/cl-helper/jannyai-managed/${action}` && verb === method));
    }
    assert.match(h.el('jannyManagedStatus').innerHTML, /Running \(Chrome\)/);
    await h.el('janitoraiManagedStartBtn').dispatch('click');
    assert.ok(h.calls.some(([path]) => path === '/plugins/cl-helper/janitorai-managed/start'));
});

test('Janny Test measures its own provider in both modes and escapes check details', async () => {
    const h = await harness();
    assert.ok(h.el('testJannyBrowserBtn'), 'Janny test button exists');
    await h.el('testJannyBrowserBtn').dispatch('click');
    assert.deepEqual(h.calls.find(([path]) => path === 'test'), ['test', '']);
    assert.match(h.el('jannyBrowserChecks').innerHTML, /JannyAI Cloudflare/);
    h.settings.janitoraiBrowserMode = 'endpoint';
    h.el('settingsJannyBrowserEndpoint').value = ' http://janny.test:9222 ';
    h.window.jannyTestBrowserEndpoint = async endpoint => {
        h.calls.push(['test', endpoint]);
        return { ok: false, checks: [{ label: '<img src=x>', detail: '<script>bad</script>', ok: false, optional: true }] };
    };
    await h.el('testJannyBrowserBtn').dispatch('click');
    assert.deepEqual(h.calls.findLast(([path]) => path === 'test'), ['test', 'http://janny.test:9222']);
    assert.equal(h.settings.janitoraiBrowserEndpoint, 'http://janny.test:9222');
    assert.match(h.el('jannyBrowserChecks').innerHTML, /warn/);
    assert.doesNotMatch(h.el('jannyBrowserChecks').innerHTML, /<img|<script>/);
    assert.equal(h.el('testJannyBrowserBtn').disabled, false);
});

test('Refresh awaits redacted account status and shows identity, expiry and renewal', async () => {
    const h = await harness();
    await h.el('jannySettingsRefreshBtn').dispatch('click');
    const account = h.el('jannySettingsAccountStatus');
    assert.match(account.textContent + account.innerHTML, /reader@example\.test/);
    assert.match(h.el('jannySettingsAccountHint').textContent, /2033/);
    assert.match(h.el('jannySettingsAccountHint').textContent, /renew/i);
    h.window.jannySessionStatus = async () => ({ ...activeStatus, hasRefresh: false, refreshable: false });
    await h.el('jannySettingsRefreshBtn').dispatch('click');
    assert.match(h.el('jannySettingsAccountHint').textContent, /cannot renew|non-renewable/i);
    assert.equal(h.writes.length, 0);
});

test('Save Login transfers once, clears/remasks input and never saves credentials', async () => {
    const h = await harness();
    const input = h.el('settingsJannyToken');
    input.value = ' one-time-test-cookie ';
    await h.el('toggleJannyTokenVisibility').dispatch('click');
    assert.equal(input.type, 'text');
    await h.el('saveJannyTokenBtn').dispatch('click');
    assert.deepEqual(h.installs, ['one-time-test-cookie']);
    assert.equal(input.value, '');
    assert.equal(input.type, 'password');
    assert.equal(h.writes.length, 0);
    assert.ok(h.toasts.some(([message, type]) => /browser/i.test(message) && type === 'success'));
    assert.doesNotMatch(JSON.stringify(h.toasts), /one-time-test-cookie/);
});

test('failed install clears one-time input without claiming login or echoing rejected data', async () => {
    const h = await harness({ jannySetSession: async () => { throw new Error('secret-cookie-value'); } });
    h.el('settingsJannyToken').value = 'secret-cookie-value';
    await h.el('saveJannyTokenBtn').dispatch('click');
    assert.equal(h.el('settingsJannyToken').value, '');
    assert.equal(h.el('saveJannyTokenBtn').disabled, false);
    assert.equal(h.toasts.some(([, type]) => type === 'success'), false);
    assert.doesNotMatch(JSON.stringify(h.toasts), /secret-cookie-value/);
    assert.equal(h.writes.length, 0);
});

test('Log Out waits for browser cleanup, reports it separately and keeps Cloudflare checks', async () => {
    const h = await harness();
    let finish;
    h.window.jannyLogout = () => new Promise(resolve => { finish = resolve; });
    const checks = h.el('jannyBrowserChecks');
    assert.ok(checks, 'Janny checks exist');
    checks.innerHTML = 'Cloudflare ready';
    const pending = h.el('clearJannyTokenBtn').dispatch('click');
    await flush();
    assert.equal(h.toasts.length, 0);
    finish({ ok: true, cleared: ['sb-eenzcbluoctduymzksoq-auth-token.0'] });
    await pending;
    assert.ok(h.toasts.some(([message]) => /browser.*cookie.*(?:clear|cleanup)/i.test(message)));
    assert.equal(checks.innerHTML, 'Cloudflare ready');
    h.window.jannyLogout = async () => ({ ok: false, error: 'cleanup failed' });
    h.toasts.length = 0;
    await h.el('clearJannyTokenBtn').dispatch('click');
    assert.ok(h.toasts.some(([message, type]) => /cleanup|cookie/i.test(message) && ['warning', 'error'].includes(type)));
    assert.equal(h.toasts.some(([, type]) => type === 'success'), false);
    assert.equal(h.writes.length, 0);
});

test('separate Janny settings expose browser and one-time account controls', () => {
    const section = html.slice(html.indexOf('id="settingsJannySection"'), html.indexOf('<!-- JanitorAI provider settings -->'));
    for (const id of [
        'jannyBrowserPluginBanner', 'jannyBrowserFields', 'settingsJannyBrowserMode',
        'jannyManagedRow', 'jannyManagedStatusRow', 'jannyManagedStatus',
        'jannyManagedStartBtn', 'jannyManagedStopBtn', 'jannyEndpointHintRow',
        'settingsJannyBrowserEndpoint', 'testJannyBrowserBtn', 'jannyBrowserChecks',
        'jannySettingsAccountStatus',
        'jannySettingsRefreshBtn',
        'jannySettingsAccountHint',
        'jannySettingsOpenJannyLink',
        'jannyRandomizeCollectionCards',
        'settingsJannyToken',
        'toggleJannyTokenVisibility',
        'saveJannyTokenBtn',
        'clearJannyTokenBtn',
    ]) {
        assert.ok(section.includes(`id="${id}"`), `missing #${id} in the Janny section`);
    }
    assert.doesNotMatch(section, /id="(?:settingsJanitorai|janitorai)/);
    assert.match(section, /Step 1: Browser/);
    assert.match(section, /Step 2: Account Login/);
    assert.match(section, /sb-eenzcbluoctduymzksoq-auth-token\.0/);
    assert.match(section, /type="password" id="settingsJannyToken"/);
    assert.doesNotMatch(section, /type="email"|autocomplete="current-password"/);
    assert.ok(!/cl-janny-bridge\.user\.js/.test(html), 'obsolete userscript instructions are removed');
    assert.ok(!/clJannyBridge|bridge\.refresh|getValidJannyToken/.test(js), 'settings do not use the obsolete userscript');
});

test('desktop and mobile styles include Janny status/action rows', () => {
    const desktop = readFileSync(new URL('../app/library.css', import.meta.url), 'utf8');
    const mobile = readFileSync(new URL('../app/library-mobile.css', import.meta.url), 'utf8');
    assert.ok(/#janitoraiManagedStatusRow,\s*#jannyManagedStatusRow\s*\{/.test(desktop));
    assert.ok(/html\.cl-mobile #janitoraiManagedStatusRow,\s*html\.cl-mobile #jannyManagedStatusRow\s*\{/.test(mobile));
    assert.ok(/html\.cl-mobile #janitoraiManagedStatusRow \.settings-action-btn,\s*html\.cl-mobile #jannyManagedStatusRow \.settings-action-btn\s*\{/.test(mobile));
});

test('Janny collection randomization is saved and defaults to latest order', () => {
    assert.match(js, /jannyRandomizeCollectionCards: false/);
    assert.match(js, /jannyRandomizeCollectionCardsCheckbox\.checked = getSetting\('jannyRandomizeCollectionCards'\) === true/);
    assert.match(js, /jannyRandomizeCollectionCards: jannyRandomizeCollectionCardsCheckbox/);
    assert.match(html, /Off by default: collection cards are sorted by newest character first/);
});

test('opening the settings modal re-reads shared configuration for both sections', async () => {
    const h = await harness();
    const start = js.indexOf('    settingsBtn.onclick = () => {', js.indexOf('async function refreshJannySettingsAccountStatus'));
    const end = js.indexOf("        const civitaiApiKeyInput =", start);
    const prefix = js.slice(start, end);
    // Exercise the real open-handler prefix, before the unrelated settings panels are loaded.
    for (const [, name] of prefix.matchAll(/if \((\w+)\)/g)) {
        if (name !== 'jannyRandomizeCollectionCardsCheckbox') h.context[name] = new Element();
    }
    Object.assign(h.context, {
        settingsBtn: new Element(), chubTokenInput: new Element(), rememberTokenCheckbox: new Element(),
        renderCtSessionTimer() {},
    });
    vm.runInContext(prefix + '\n};', h.context);
    h.settings.janitoraiBrowserMode = 'endpoint';
    h.settings.janitoraiBrowserEndpoint = 'http://reopened.test:9222';
    await h.context.settingsBtn.dispatch('click');
    for (const provider of ['Janny', 'Janitorai']) {
        assert.equal(h.el(`settings${provider}BrowserMode`).value, 'endpoint');
        assert.equal(h.el(`settings${provider}BrowserEndpoint`).value, 'http://reopened.test:9222');
    }
});

test('Janny browser controls participate in the helper availability check', async () => {
    const h = await harness();
    const start = js.indexOf('        checkClHelperPlugin(');
    const end = js.indexOf(').then(available =>', start);
    for (const [, name] of js.slice(start, end).matchAll(/\b(\w+(?:Banner|Fields))\b(?!')/g)) {
        h.context[name] ||= new Element(name);
    }
    let checked;
    h.context.checkClHelperPlugin = (...args) => { checked = args; };
    vm.runInContext(js.slice(start, end) + ');', h.context);
    const index = checked.indexOf(h.el('jannyBrowserPluginBanner'));
    assert.ok(index >= 0, 'Janny helper banner is checked');
    assert.equal(checked[index + 1], h.el('jannyBrowserFields'));
});

test('unavailable or expired browser status never falls back to legacy saved credentials', async () => {
    const h = await harness();
    h.settings.jannyToken = 'legacy-secret';
    h.window.jannySessionStatus = async () => { throw new Error('private helper failure'); };
    await h.el('jannySettingsRefreshBtn').dispatch('click');
    assert.match(h.el('jannySettingsAccountStatus').textContent, /unavailable/i);
    assert.doesNotMatch(h.el('jannySettingsAccountHint').textContent, /private helper failure|legacy-secret/);
    h.window.jannySessionStatus = async () => ({ ...activeStatus, active: false, expMs: 1600000000000, hasRefresh: false, refreshable: false });
    await h.el('jannySettingsRefreshBtn').dispatch('click');
    assert.equal(h.el('jannySettingsAccountStatus').className, 'settings-status-badge inactive');
    assert.match(h.el('jannySettingsAccountHint').textContent, /2020/);
    assert.equal(h.writes.length, 0);
});

test('older account reads cannot overwrite newer redacted status', async () => {
    const h = await harness();
    let resolveOld;
    h.window.jannySessionStatus = () => new Promise(resolve => { resolveOld = resolve; });
    const pending = h.el('jannySettingsRefreshBtn').dispatch('click');
    await flush();
    h.window.jannySessionStatus = async () => ({ ...activeStatus, email: 'new-reader@example.test' });
    await h.el('jannySettingsRefreshBtn').dispatch('click');
    resolveOld({ ...activeStatus, email: 'old-reader@example.test' });
    await pending;
    assert.match(h.el('jannySettingsAccountStatus').textContent, /new-reader@example.test/);
});

test('a rejected install or unavailable logout never reports success', async () => {
    const h = await harness({ jannySetSession: async () => ({ ok: false, error: 'input-secret' }), jannyLogout: undefined });
    h.el('settingsJannyToken').value = 'input-secret';
    await h.el('saveJannyTokenBtn').dispatch('click');
    assert.equal(h.el('settingsJannyToken').value, '');
    await h.el('clearJannyTokenBtn').dispatch('click');
    assert.doesNotMatch(JSON.stringify(h.toasts), /Local JannyAI login cleared/);
    assert.equal(h.toasts.some(([, type]) => type === 'success'), false);
    assert.doesNotMatch(JSON.stringify(h.toasts), /input-secret/);
    assert.equal(h.writes.length, 0);
});

test('initial settings setup does not query account cookies and start a browser for MeiliSearch', async () => {
    const h = await harness();
    assert.equal(h.calls.some(([path]) => path === 'session-status'), false);
    assert.ok(h.calls.some(([path]) => path === '/plugins/cl-helper/jannyai-managed/status'));
    h.el('settingsJannySection').open = true;
    await h.el('settingsJannySection').dispatch('toggle');
    assert.equal(h.calls.some(([path]) => path === 'session-status'), true);
});

test('Janny Test rejects an empty external endpoint and renders transport failure', async () => {
    const h = await harness();
    h.settings.janitoraiBrowserMode = 'endpoint';
    await h.el('testJannyBrowserBtn').dispatch('click');
    assert.equal(h.calls.some(([path]) => path === 'test'), false);
    h.el('settingsJannyBrowserEndpoint').value = 'http://unavailable.test:9222';
    h.window.jannyTestBrowserEndpoint = async () => { throw new Error('JannyAI browser endpoint is unavailable.'); };
    await h.el('testJannyBrowserBtn').dispatch('click');
    assert.match(h.el('jannyBrowserChecks').innerHTML, /endpoint is unavailable/);
    assert.equal(h.el('testJannyBrowserBtn').disabled, false);
});
