import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../extras/cl-janny-bridge.user.js', import.meta.url), 'utf8');

test('janny bridge userscript is scoped to jannyai.com only', () => {
    assert.match(src, /@connect\s+jannyai\.com/);
    assert.doesNotMatch(src, /janitorai\.com/);
    assert.match(src, /https:\/\/jannyai\.com/);
});

test('janny bridge uses its own message tags and allowlists the account surface', () => {
    assert.match(src, /'character-library-janny'/);
    assert.match(src, /'cl-janny-bridge'/);
    for (const marker of [
        '/api/bookmark', '/api/get-characters', '/api/collections/mine',
        '/collections/form/add-collection', '/collections/form/edit-collection',
        '/collections/form/delete-collection', 'collectors',
    ]) assert.ok(src.includes(marker), `missing allowlist marker: ${marker}`);
});

test('janny bridge uses a top-page relay so remote Firefox mobile hosts work', () => {
    const metadata = src.slice(0, src.indexOf('// ==/UserScript=='));
    assert.match(metadata, /@version\s+2\.1\.0/);
    assert.match(metadata, /@match\s+\*:\/\/\*\/\*/);
    assert.match(metadata, /@noframes/);
    assert.doesNotMatch(src, /isTrustedHost/);
    assert.doesNotMatch(src, /if \(!isCLPage\) return/);
    assert.match(src, /e\.source \|\| window/);
});

test('janny bridge keeps same-origin and response guards', () => {
    assert.match(src, /e\.origin !== location\.origin/);
    assert.match(src, /finalUrl/);
});

function executeUserscript({ pathname, hasMarker, gmRequest, hostname = '127.0.0.1', origin = 'http://127.0.0.1:8001' }) {
    const messages = [];
    const listeners = [];
    const location = { origin, hostname, pathname };
    const window = {
        addEventListener(type, handler) { if (type === 'message') listeners.push(handler); },
        postMessage(message, targetOrigin) { messages.push({ message, targetOrigin }); },
    };
    const context = {
        console: { debug() {} },
        document: { querySelector: () => hasMarker ? {} : null },
        location, window, URL, GM_xmlhttpRequest: gmRequest,
    };
    vm.runInNewContext(src, context);
    return { listeners, messages, origin: location.origin };
}

test('actual userscript starts on a remote Colab-style top page without a CL marker', () => {
    const run = executeUserscript({
        pathname: '/',
        hasMarker: false,
        hostname: 'random-id.trycloudflare.com',
        origin: 'https://random-id.trycloudflare.com',
    });
    assert.equal(run.listeners.length, 1);
    assert.equal(run.messages.length, 1);
    assert.equal(run.messages[0].message.source, 'cl-janny-bridge');
    assert.equal(run.messages[0].message.type, 'ready');
});

test('actual Janny request forwards the pasted bearer token and Janny cookie partition', () => {
    let requestDetails = null;
    const run = executeUserscript({
        pathname: '/scripts/extensions/third-party/SillyTavern-CharacterLibrary/app/library.html',
        hasMarker: true,
        hostname: 'random-id.trycloudflare.com',
        origin: 'https://random-id.trycloudflare.com',
        gmRequest: (details) => { requestDetails = details; },
    });
    run.listeners[0]({
        origin: run.origin,
        data: {
            source: 'character-library-janny', type: 'fetch', id: 'probe',
            method: 'GET', url: 'https://jannyai.com/api/bookmark', authToken: 'mobile-login-token',
        },
    });
    assert.equal(requestDetails.method, 'GET');
    assert.equal(requestDetails.headers.Authorization, 'Bearer mobile-login-token');
    assert.equal(requestDetails.cookiePartition.topLevelSite, 'https://jannyai.com');
});

test('top-page userscript answers a ping back into the requesting Character Library iframe', () => {
    const run = executeUserscript({ pathname: '/', hasMarker: false, hostname: 'public.example', origin: 'https://public.example' });
    const iframeMessages = [];
    const iframeWindow = { postMessage(message, targetOrigin) { iframeMessages.push({ message, targetOrigin }); } };
    run.listeners[0]({
        origin: run.origin,
        source: iframeWindow,
        data: { source: 'character-library-janny', type: 'ping' },
    });
    assert.equal(iframeMessages.length, 1);
    assert.equal(iframeMessages[0].message.source, 'cl-janny-bridge');
    assert.equal(iframeMessages[0].message.type, 'ready');
    assert.equal(iframeMessages[0].targetOrigin, run.origin);
});
