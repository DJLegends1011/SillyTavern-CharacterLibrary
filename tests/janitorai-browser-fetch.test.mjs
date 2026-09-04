import assert from 'node:assert/strict';
import test from 'node:test';

let helperCall;
globalThis.window = {
    getSetting(key) {
        if (key === 'janitoraiBrowserMode') return 'managed';
        return '';
    },
    apiRequest: async (endpoint, method, body, options) => {
        helperCall = { endpoint, method, body, options };
        return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, status: 200, body: '{}' }),
        };
    },
};

await import('../modules/core-api.js');
const { browserFetch, fetchJanitoraiCharacter } = await import('../modules/providers/janitorai/janitorai-api.js');

test('browserFetch propagates caller cancellation to the managed helper request', async () => {
    const controller = new AbortController();
    await browserFetch('/characters/aaaaaaaa-1111-4111-8111-111111111111', '', undefined, {
        signal: controller.signal,
    });

    assert.ok(helperCall?.options?.signal instanceof AbortSignal);
    assert.equal('signal' in helperCall.body, false, 'AbortSignal must stay out of the serialized helper body');
    assert.equal(helperCall.options.signal.aborted, false);

    controller.abort();
    assert.equal(helperCall.options.signal.aborted, true, 'aborting the caller must abort the helper request signal');
});

test('character verification carries cancellation through Hampter to the managed helper', async () => {
    helperCall = null;
    const controller = new AbortController();
    const id = 'bbbbbbbb-2222-4222-8222-222222222222';
    await fetchJanitoraiCharacter(id, { signal: controller.signal });

    assert.ok(helperCall?.options?.signal instanceof AbortSignal);
    controller.abort();
    assert.equal(helperCall.options.signal.aborted, true);
});
