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

test('janny bridge uses its own message tags (no cross-talk with the janitor bridge)', () => {
    assert.match(src, /'character-library-janny'/);
    assert.match(src, /'cl-janny-bridge'/);
    assert.doesNotMatch(src, /'cl-janitor-bridge'/);
});

test('janny bridge allowlists the account + public collection surface', () => {
    for (const marker of [
        '/api/bookmark',
        '/api/get-characters',
        '/api/collections/mine',
        '/collections/form/add-collection',
        '/collections/form/edit-collection',
        '/collections/form/delete-collection',
        'collectors',
    ]) {
        assert.ok(src.includes(marker), `missing allowlist marker: ${marker}`);
    }
});

test('janny bridge keeps the security guards', () => {
    assert.match(src, /e\.origin !== location\.origin/);
    assert.match(src, /finalUrl/);
});

test('janny bridge can run inside Character Library embedded mode', () => {
    const metadata = src.slice(0, src.indexOf('// ==/UserScript=='));
    assert.match(metadata, /@version\s+1\.0\.1/);
    assert.doesNotMatch(metadata, /@noframes/);
    assert.match(src, /embedded iframe/);
});

test('janny bridge activates only on trusted local/LAN hosts (CSRF gate)', () => {
    assert.ok(src.includes('isTrustedHost'), 'missing trusted-host gate');
    assert.ok(src.includes('192.168.0.0/16'), 'missing private-LAN range');
    assert.ok(src.includes('link-local'), 'missing link-local range');
    assert.ok(
        src.includes('!isTrustedHost(location.hostname) || !isCLPage'),
        'activation must require a trusted host AND the CL marker',
    );
});

function executeUserscript({ pathname, hasMarker }) {
    const messages = [];
    const listeners = [];
    const location = { origin: 'http://127.0.0.1:8001', hostname: '127.0.0.1', pathname };
    const window = {
        addEventListener(type, handler) {
            if (type === 'message') listeners.push(handler);
        },
        postMessage(message, targetOrigin) {
            messages.push({ message, targetOrigin });
        },
    };
    const context = {
        console: { debug() {} },
        document: { querySelector: () => hasMarker ? {} : null },
        location,
        window,
        URL,
    };

    vm.runInNewContext(src, context);
    return { listeners, messages, origin: location.origin };
}

test('actual userscript starts and announces inside the embedded Character Library frame', () => {
    const run = executeUserscript({
        pathname: '/scripts/extensions/third-party/SillyTavern-CharacterLibrary/app/library.html',
        hasMarker: true,
    });
    assert.equal(run.listeners.length, 1);
    assert.equal(run.messages.length, 1);
    assert.equal(run.messages[0].message.source, 'cl-janny-bridge');
    assert.equal(run.messages[0].message.type, 'ready');
});

test('actual userscript stays dormant on the top-level SillyTavern page', () => {
    const run = executeUserscript({ pathname: '/', hasMarker: false });
    assert.equal(run.listeners.length, 0);
    assert.equal(run.messages.length, 0);
});
