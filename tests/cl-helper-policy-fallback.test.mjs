import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// A cl-helper installed before the three-file bundle self-updates only package.json and
// index.js, so this index.js can land on disk with no janny-browser-policy.js beside it.
// That must degrade JannyAI, never the plugin: JanitorAI, DataCat, thumbnails and the
// self-update route all have to keep serving.
const bundle = new URL('../extras/cl-helper/', import.meta.url);
const scratch = mkdtempSync(join(tmpdir(), 'cl-helper-no-policy-'));
for (const name of ['package.json', 'index.js']) {
    copyFileSync(new URL(name, bundle), join(scratch, name));
}

function silently(run) {
    const saved = { log: console.log, warn: console.warn, error: console.error };
    Object.assign(console, { log() {}, warn() {}, error() {} });
    return Promise.resolve().then(run).finally(() => Object.assign(console, saved));
}

// Express router double: record every verb the helper registers, keyed "VERB /path".
function routerDouble(routes) {
    const router = { use() {} };
    for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']) {
        router[verb] = (path, ...rest) => routes.set(`${verb.toUpperCase()} ${path}`, rest.at(-1));
    }
    return router;
}

const routes = new Map();

let helper = null;
let loadError = null;
try {
    helper = await silently(() => import(pathToFileURL(join(scratch, 'index.js')).href));
    await silently(() => helper.init(routerDouble(routes)));
} catch (error) {
    loadError = error;
} finally {
    rmSync(scratch, { recursive: true, force: true });
}

async function call(key, body = {}) {
    let status = 200;
    let data;
    await routes.get(key)({ body, headers: {}, user: {} }, {
        status(value) { status = value; return this; },
        json(value) { data = value; },
    });
    return { status, data };
}

test('a helper missing janny-browser-policy.js still loads', () => {
    assert.equal(loadError, null, `helper failed to load: ${loadError?.message}`);
    assert.equal(typeof helper.init, 'function');
});

test('every non-Janny route still registers without the Janny policy module', () => {
    for (const key of [
        'GET /health', 'POST /self-update',
        'POST /janitorai-browser-fetch', 'POST /janitorai-browser-session',
        'POST /janitorai-browser-test', 'POST /janitorai-managed/start',
        'POST /dc-init', 'GET /dc-proxy/*', 'POST /dc-extract', 'GET /dc-session',
        'GET /gallery-thumb/:folder/:file', 'GET /avatar-thumb/:file',
        'POST /botbooru-login', 'GET /ct-proxy/*', 'GET /civitai-proxy/:host/*', 'GET /pixiv-proxy/*',
        'POST /janitorai-extract', 'POST /janitorai-recover',
    ]) assert.ok(routes.has(key), `missing ${key}`);
});

test('health still answers while JannyAI is degraded', async () => {
    const { status, data } = await call('GET /health');
    assert.equal(status, 200);
    assert.equal(data.ok, true);
});

test('Janny routes answer a well-formed unavailable error instead of vanishing', async () => {
    for (const key of [
        'POST /jannyai-browser-fetch', 'POST /jannyai-browser-session',
        'POST /jannyai-browser-session-status', 'POST /jannyai-browser-refresh-session',
        'POST /jannyai-browser-logout', 'POST /jannyai-browser-test',
        'POST /jannyai-managed/start', 'POST /jannyai-managed/stop',
        'GET /jannyai-managed/status',
    ]) {
        assert.ok(routes.has(key), `missing ${key}`);
        const { status, data } = await call(key);
        assert.equal(status, 503, `${key} status`);
        assert.equal(data.ok, false, `${key} ok`);
        assert.match(data.error, /janny-browser-policy\.js is missing/);
        assert.match(data.error, /package\.json, index\.js and janny-browser-policy\.js/);
    }
    assert.equal((await call('GET /jannyai-managed/status')).data.running, false);
});

test('the shipped bundle resolves its policy and registers the real Janny routes', async () => {
    const complete = new Map();
    const real = await import('../extras/cl-helper/index.js');
    await silently(() => real.init(routerDouble(complete)));
    assert.ok(complete.has('POST /jannyai-browser-fetch'));
    // The real route validates its body; the stub answers 503 without looking at it.
    let status = 200;
    await complete.get('POST /jannyai-browser-fetch')({ body: {} }, {
        status(value) { status = value; return this; }, json() {},
    });
    assert.notEqual(status, 503);
});
