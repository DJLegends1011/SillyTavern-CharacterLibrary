import test from 'node:test';
import assert from 'node:assert/strict';

function makeFakeWindow() {
    const listeners = [];
    const win = {
        location: { origin: 'http://127.0.0.1:8001' },
        parent: null,
        addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
        postMessage(data, _origin) {
            queueMicrotask(() => {
                for (const fn of [...listeners]) fn({ data, origin: win.location.origin });
            });
        },
    };
    win.parent = win;
    return win;
}

test('refresh keeps an already detected Janny bridge available if a later ping is missed', async () => {
    globalThis.window = makeFakeWindow();
    const tag = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const { initJannyBridge, isJannyBridgeAvailable, refreshJannyBridgeAvailability } =
        await import(`../modules/providers/janny/janny-bridge.js?refresh_parity=${tag}`);

    initJannyBridge();
    window.postMessage({ source: 'cl-janny-bridge', type: 'ready' }, window.location.origin);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(isJannyBridgeAvailable(), true);

    assert.equal(await refreshJannyBridgeAvailability(), true);
    assert.equal(isJannyBridgeAvailable(), true);
});

