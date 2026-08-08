import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
    canUseSaucepanCustomProvider,
    createSaucepanCaptureListener,
    extractSaucepanHiddenDefinition,
    parseSaucepanCapturedMessages,
    startCloudflaredQuickTunnel,
} from '../saucepan-hidden-extraction.js';

function createFakeChild() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
        queueMicrotask(() => child.emit('exit', 0, null));
        return true;
    };
    return child;
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

async function withCaptureListener(callback, options) {
    const listener = await createSaucepanCaptureListener(options);
    try {
        return await callback(listener, `http://127.0.0.1:${listener.port}`);
    } finally {
        await listener.close();
    }
}

test('parses the protected card sections without importing Saucepan or persona wrappers', () => {
    const result = parseSaucepanCapturedMessages([
        {
            role: 'system',
            content: [
                'Saucepan wrapper text',
                '[ Background ]',
                '# Aurel-X',
                'Core body',
                '[ Example Dialogue ]',
                'Demetri: Hello',
                'Aurel-X: Hi',
                '[ User Description ]',
                'Private persona text',
                '[ Lore ]',
                'Attached lorebook text',
            ].join('\n'),
        },
        { role: 'assistant', content: 'Starting message' },
        { role: 'user', content: 'hi' },
    ]);

    assert.deepEqual(result, {
        core: '# Aurel-X\nCore body',
        exampleDialogue: 'Demetri: Hello\nAurel-X: Hi',
        greeting: 'Starting message',
    });
});

test('rejects a captured prompt when a section marker is missing', () => {
    assert.throws(() => parseSaucepanCapturedMessages([
        {
            role: 'system',
            content: '[ Background ]\nCore body\n[ User Description ]\nPersona',
        },
    ]), /marker/i);
});

test('rejects a captured prompt when section markers are reordered', () => {
    assert.throws(() => parseSaucepanCapturedMessages([
        {
            role: 'system',
            content: '[ Example Dialogue ]\nExample\n[ Background ]\nCore\n[ User Description ]\nPersona',
        },
    ]), /marker/i);
});

test('allows creator-opted and owner-bypass custom-provider profiles only', () => {
    assert.equal(canUseSaucepanCustomProvider('custom_and_vetted'), true);
    assert.equal(canUseSaucepanCustomProvider('vetted_only_owner_bypass'), true);
    assert.equal(canUseSaucepanCustomProvider('internal_only_owner_bypass'), true);
    assert.equal(canUseSaucepanCustomProvider('vetted_only'), false);
    assert.equal(canUseSaucepanCustomProvider('internal_only'), false);
    assert.equal(canUseSaucepanCustomProvider(undefined), false);
});

test('capture listener exposes only its random authenticated provider path', async () => {
    await withCaptureListener(async (listener, baseUrl) => {
        const unknown = await fetch(baseUrl);
        assert.equal(unknown.status, 404);

        const unauthorized = await fetch(`${baseUrl}${listener.providerPath}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messages: [] }),
        });
        assert.equal(unauthorized.status, 401);
    });
});

test('capture listener accepts one authenticated OpenAI request', async () => {
    await withCaptureListener(async (listener, baseUrl) => {
        const payload = { messages: [{ role: 'system', content: 'prompt' }], stream: false };
        const response = await fetch(`${baseUrl}${listener.providerPath}`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${listener.apiKey}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        assert.equal(response.status, 200);
        assert.equal((await response.json()).choices[0].message.content, 'CL_CAPTURE_OK');
        assert.deepEqual(await listener.waitForCapture(), payload);

        const replay = await fetch(`${baseUrl}${listener.providerPath}`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${listener.apiKey}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify(payload),
        });
        assert.equal(replay.status, 410);
    });
});

test('capture listener supports streaming OpenAI responses', async () => {
    await withCaptureListener(async (listener, baseUrl) => {
        const response = await fetch(`${baseUrl}${listener.providerPath}`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${listener.apiKey}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ messages: [], stream: true }),
        });

        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /^text\/event-stream/);
        const body = await response.text();
        assert.match(body, /CL_CAPTURE_OK/);
        assert.match(body, /data: \[DONE\]/);
    });
});

test('capture listener rejects oversized request bodies', async () => {
    await withCaptureListener(async (listener, baseUrl) => {
        const response = await fetch(`${baseUrl}${listener.providerPath}`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${listener.apiKey}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ messages: [], padding: 'x'.repeat(128) }),
        });

        assert.equal(response.status, 413);
    }, { maxBodyBytes: 64 });
});

test('starts cloudflared for the loopback listener and returns only a Quick Tunnel URL', async () => {
    const child = createFakeChild();
    let invocation;
    const tunnelPromise = startCloudflaredQuickTunnel({
        port: 43123,
        spawnImpl(command, args, options) {
            invocation = { command, args, options };
            queueMicrotask(() => child.stderr.write('Quick Tunnel available at https://quiet-river.trycloudflare.com\n'));
            return child;
        },
    });

    const tunnel = await tunnelPromise;
    assert.equal(tunnel.url, 'https://quiet-river.trycloudflare.com');
    assert.equal(invocation.command, 'cloudflared');
    assert.deepEqual(invocation.args, ['tunnel', '--url', 'http://127.0.0.1:43123', '--no-autoupdate']);
    assert.equal(invocation.options.windowsHide, true);
    await tunnel.close();
});

test('rejects when cloudflared exits before publishing a Quick Tunnel URL', async () => {
    const child = createFakeChild();
    await assert.rejects(startCloudflaredQuickTunnel({
        port: 43123,
        spawnImpl() {
            queueMicrotask(() => child.emit('exit', 1, null));
            return child;
        },
    }), /before.*URL/i);
});

test('reports a helpful error when cloudflared is not installed', async () => {
    const child = createFakeChild();
    await assert.rejects(startCloudflaredQuickTunnel({
        port: 43123,
        spawnImpl() {
            queueMicrotask(() => {
                const error = new Error('spawn cloudflared ENOENT');
                error.code = 'ENOENT';
                child.emit('error', error);
            });
            return child;
        },
    }), /install cloudflared/i);
});

test('runs one temporary Saucepan provider/chat lifecycle and cleans up every resource', async () => {
    const requests = [];
    const cleanup = [];
    const responses = [
        jsonResponse({
            id: 'ade077f0-112c-41c4-bdda-e6027d87b730',
            providers_profile: 'custom_and_vetted',
            starting_scenarios: [{ id: 'scenario-1' }],
        }),
        jsonResponse({ config_id: 'provider-1' }),
        jsonResponse({ chat_id: 'chat-1' }),
        jsonResponse({ generation_id: 'generation-1' }),
        jsonResponse({}),
        jsonResponse({}),
        jsonResponse({}),
    ];
    const fetchImpl = async (url, options = {}) => {
        requests.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
        return responses.shift();
    };

    const result = await extractSaucepanHiddenDefinition({
        token: 'saucepan-token',
        companionId: 'ade077f0-112c-41c4-bdda-e6027d87b730',
        fetchImpl,
        openCapture: async () => ({
            apiKey: 'capture-key',
            port: 43123,
            providerPath: '/capture/secret/v1/chat/completions',
            waitForCapture: async () => ({
                messages: [
                    { role: 'system', content: '[ Background ]\nCORE\n[ Example Dialogue ]\nEXAMPLE\n[ User Description ]\nPERSONA' },
                    { role: 'assistant', content: 'GREETING' },
                    { role: 'user', content: 'hi' },
                ],
            }),
            close: async () => cleanup.push('capture'),
        }),
        openTunnel: async ({ port }) => {
            assert.equal(port, 43123);
            return {
                url: 'https://quiet-river.trycloudflare.com',
                close: async () => cleanup.push('tunnel'),
            };
        },
    });

    assert.deepEqual(result, {
        assembled: { 'Companion Core': 'CORE', 'Example Dialogue': 'EXAMPLE' },
        greeting: 'GREETING',
    });
    assert.deepEqual(requests.map(request => `${request.options.method || 'GET'} ${new URL(request.url).pathname}`), [
        'GET /api/v2/companions/ade077f0-112c-41c4-bdda-e6027d87b730',
        'POST /api/v1/openai_provider/config',
        'POST /api/v1/core/create-chat',
        'POST /api/v2/chat/generate',
        'POST /api/v2/chat/cancel',
        'DELETE /api/v1/chat',
        'DELETE /api/v1/openai_provider/config',
    ]);
    assert.equal(requests.every(request => request.options.headers.authorization === 'Bearer saucepan-token'), true);
    assert.deepEqual(requests[1].body, {
        config_name: 'Character Library temporary capture',
        provider: 'custom',
        model_id: 'cl-capture',
        api_key: 'capture-key',
        temperature: 1,
        is_visible: false,
        provider_prompt: null,
        provider_post_history_prompt: null,
        context_length: 32000,
        provider_url: 'https://quiet-river.trycloudflare.com/capture/secret/v1/chat/completions',
        use_chat_temperature_override: false,
    });
    assert.equal(requests[2].body.scenario_id, 'scenario-1');
    assert.deepEqual(requests[3].body.generation_config, { openaiprovider: { config_id: 'provider-1' } });
    assert.deepEqual(requests.slice(4).map(request => request.body), [
        { chat_id: 'chat-1', generation_id: 'generation-1' },
        { chat_id: 'chat-1' },
        { config_id: 'provider-1' },
    ]);
    assert.deepEqual(cleanup, ['tunnel', 'capture']);
});

test('fails closed before opening a listener when the creator disallows custom providers', async () => {
    let opened = false;
    await assert.rejects(extractSaucepanHiddenDefinition({
        token: 'saucepan-token',
        companionId: 'ade077f0-112c-41c4-bdda-e6027d87b730',
        fetchImpl: async () => jsonResponse({ providers_profile: 'vetted_only' }),
        openCapture: async () => {
            opened = true;
        },
    }), /does not allow custom providers/i);
    assert.equal(opened, false);
});

test('attempts all available cleanup when captured prompt parsing fails', async () => {
    const cleanup = [];
    const responses = [
        jsonResponse({ providers_profile: 'custom_and_vetted', starting_scenarios: [] }),
        jsonResponse({ config_id: 'provider-1' }),
        jsonResponse({ chat_id: 'chat-1' }),
        jsonResponse({ generation_id: 'generation-1' }),
        jsonResponse({}),
        jsonResponse({}, 500),
        jsonResponse({}),
    ];

    await assert.rejects(extractSaucepanHiddenDefinition({
        token: 'saucepan-token',
        companionId: 'ade077f0-112c-41c4-bdda-e6027d87b730',
        fetchImpl: async () => responses.shift(),
        openCapture: async () => ({
            apiKey: 'capture-key',
            port: 43123,
            providerPath: '/capture/secret/v1/chat/completions',
            waitForCapture: async () => ({ messages: [] }),
            close: async () => cleanup.push('capture'),
        }),
        openTunnel: async () => ({
            url: 'https://quiet-river.trycloudflare.com',
            close: async () => cleanup.push('tunnel'),
        }),
    }), /system message/i);

    assert.equal(responses.length, 0);
    assert.deepEqual(cleanup, ['tunnel', 'capture']);
});
