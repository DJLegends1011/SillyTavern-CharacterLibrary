import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { assertJannyPageOrigin } from '../../extras/cl-helper/index.js';
import { JANNY_ORIGIN, validateJannyBrowserRequest, validateJannyFinalUrl } from '../../extras/cl-helper/janny-browser-policy.js';

// Run the actual helper handler and its injected browser fetch script. Only the
// browser connection/page and remote response are fake; validation stays real.
export function createJannyHelperHarness(replies, { document, finalUrl } = {}) {
    const helper = readFileSync(new URL('../../extras/cl-helper/index.js', import.meta.url), 'utf8');
    const source = helper.slice(helper.indexOf('function registerJannyaiBrowserRoutes('),
        helper.indexOf('function registerJanitoraiBrowserRoutes('));
    const routes = new Map();
    const requests = [];
    const navigations = [];
    let currentUrl = 'https://jannyai.com/';
    const page = {
        goto: async url => {
            navigations.push(url);
            currentUrl = finalUrl || url;
        },
        evaluate: async script => runInNewContext(script, {
            location: new URL(currentUrl), document, URL,
            fetch: async (url, init) => {
                requests.push({ url, init: JSON.parse(JSON.stringify(init)) });
                const reply = replies.shift();
                assert.ok(reply, 'Missing synthetic browser response');
                return { status: reply.status, url: reply.finalUrl, text: async () => reply.body ?? '' };
            },
        }),
    };
    const extractor = helper.slice(helper.indexOf('async function waitForJannyDocumentReady('),
        helper.indexOf('// Managed browser'));
    runInNewContext(extractor + source + '\nregisterJannyaiBrowserRoutes(router);', {
        router: { post: (path, handler) => routes.set(path, handler), get() {} },
        JANNY_ORIGIN, validateJannyBrowserRequest, validateJannyFinalUrl, assertJannyPageOrigin,
        resolveBrowserEndpoint: async () => 'http://browser.test:9222',
        getJannyWarmPage: async () => ({ page }),
        closeJannyWarmPage: async () => {},
        CDP_NAV_TIMEOUT: 45000, URL,
    });
    return {
        requests, navigations,
        apiRequest: async (path, method, body) => {
            assert.equal(path, '/plugins/cl-helper/jannyai-browser-fetch');
            assert.equal(method, 'POST');
            let status = 200;
            let data;
            await routes.get('/jannyai-browser-fetch')({ body }, {
                status(value) { status = value; return this; },
                json(value) { data = JSON.parse(JSON.stringify(value)); },
            });
            return { ok: status >= 200 && status < 300, status, json: async () => data };
        },
    };
}

// Small DOM boundary double: selectors are evaluated against explicit island
// attributes; props use the real Astro tuple format and no browser-owned state.
export function jannyCharacterDocument(character, { componentExport = 'CharacterButtons', componentUrl = '', title = 'Demo', marker = false, rawProps, onPropsRead = () => {} } = {}) {
    const encode = value => Array.isArray(value) ? [1, value.map(encode)]
        : [0, value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)])) : value];
    const attrs = {
        'component-export': componentExport, 'component-url': componentUrl,
        props: rawProps ?? JSON.stringify({ character: encode(character), imageUrl: [0, 'https://image.jannyai.com/demo.png'], unrelated: [99, null] }),
    };
    const island = { getAttribute: name => { if (name === 'props') onPropsRead(); return attrs[name] || null; } };
    return {
        readyState: 'complete', title,
        get cookie() { throw new Error('Extractor must not read cookies'); },
        get body() { throw new Error('Extractor must not scan character text for challenges'); },
        querySelector: selector => (marker === 'script' ? selector.includes('script[')
            : marker === 'login' ? selector.includes('password') : marker && /cf-|challenge|turnstile/.test(selector)) ? {} : null,
        querySelectorAll: selector => selector.split(',').some(part => {
            if (!part.includes('astro-island')) return false;
            const match = part.match(/\[(component-export|component-url)(\*?=)"([^"]+)"\]/);
            if (!match) return true;
            const matches = match[2] === '*=' ? attrs[match[1]].includes(match[3]) : attrs[match[1]] === match[3];
            return part.includes(':not(') ? !matches : matches;
        }) ? [island] : [],
    };
}
