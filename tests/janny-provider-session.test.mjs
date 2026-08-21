import test from 'node:test';
import assert from 'node:assert/strict';

function b64url(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function makeJannyJwt(overrides = {}) {
    const claims = {
        sub: 'user-1',
        email: 'mobile@example.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: 'https://eenzcbluoctduymzksoq.supabase.co/auth/v1',
        ...overrides,
    };
    return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.signature`;
}

async function loadProvider(settings = {}) {
    globalThis.window = {
        location: { origin: 'http://127.0.0.1:8001' },
        getSetting(key) { return settings[key]; },
        setSetting(key, value) { settings[key] = value; },
        addEventListener() {},
        postMessage() {},
    };
    globalThis.document = {};

    const tag = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const CoreAPI = (await import(`../modules/core-api.js?janny_session=${tag}`)).default;
    const provider = (await import(`../modules/providers/janny/janny-provider.js?janny_session=${tag}`)).default;
    await provider.init(CoreAPI);
    return { settings };
}

test('JannyAI saves a valid pasted login token even when the userscript bridge is absent', async () => {
    const { settings } = await loadProvider();
    const jwt = makeJannyJwt();

    const result = await window.jannySetSession(jwt);

    assert.equal(result.ok, true);
    assert.equal(result.email, 'mobile@example.com');
    assert.equal(settings.jannyToken, jwt);
});

