import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {};
globalThis.document = {
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
};

await import('../modules/core-api.js');
const { BrowseView } = await import('../modules/providers/browse-view.js');

test('BrowseView keeps the placeholder visible until the remote image decodes', async () => {
    let finishDecode;
    class FakePreloader {
        constructor() {
            this.decoding = '';
            this.fetchPriority = '';
            this._src = '';
        }

        set src(value) {
            this._src = value;
        }

        get src() {
            return this._src;
        }

        decode() {
            return new Promise(resolve => {
                finishDecode = resolve;
            });
        }

        addEventListener() {}
    }
    globalThis.Image = FakePreloader;

    const listeners = { load: [], error: [] };
    const img = {
        dataset: {},
        src: 'placeholder.svg',
        fetchPriority: 'low',
        style: {},
        complete: false,
        naturalWidth: 0,
        naturalHeight: 0,
        closest() { return null; },
        addEventListener(type, listener) {
            listeners[type].push(listener);
        },
        removeEventListener() {},
    };

    BrowseView.loadImage(img, 'https://image.example/card.webp');

    assert.equal(img.src, 'placeholder.svg');
    assert.equal(img.dataset.loadingSrc, 'https://image.example/card.webp');

    finishDecode();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(img.src, 'https://image.example/card.webp');
    for (const listener of listeners.load) listener();
    assert.equal(img.dataset.loaded, '1');
    assert.equal(img.dataset.loadingSrc, undefined);
});
