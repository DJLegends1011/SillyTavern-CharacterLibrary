import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { assertJannyPageOrigin } from '../../extras/cl-helper/index.js';
import { JANNY_ORIGIN, validateJannyBrowserRequest, validateJannyFinalUrl } from '../../extras/cl-helper/janny-browser-policy.js';

// Run the actual helper handler and its injected browser fetch script. Only the
// browser connection/page and remote response are fake; validation stays real.
export function createJannyHelperHarness(replies) {
    const helper = readFileSync(new URL('../../extras/cl-helper/index.js', import.meta.url), 'utf8');
    const source = helper.slice(helper.indexOf('function registerJannyaiBrowserRoutes('),
        helper.indexOf('function registerJanitoraiBrowserRoutes('));
    const routes = new Map();
    const requests = [];
    const page = {
        evaluate: async script => runInNewContext(script, {
            location: { href: 'https://jannyai.com/' },
            fetch: async (url, init) => {
                requests.push({ url, init: JSON.parse(JSON.stringify(init)) });
                const reply = replies.shift();
                assert.ok(reply, 'Missing synthetic browser response');
                return { status: reply.status, url: reply.finalUrl, text: async () => reply.body ?? '' };
            },
        }),
    };
    runInNewContext(source + '\nregisterJannyaiBrowserRoutes(router);', {
        router: { post: (path, handler) => routes.set(path, handler), get() {} },
        JANNY_ORIGIN, validateJannyBrowserRequest, validateJannyFinalUrl, assertJannyPageOrigin,
        resolveBrowserEndpoint: async () => 'http://browser.test:9222',
        getJannyWarmPage: async () => ({ page }),
        closeJannyWarmPage: async () => {},
    });
    return {
        requests,
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
