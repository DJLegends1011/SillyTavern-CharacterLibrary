import test from 'node:test';
import assert from 'node:assert/strict';

const settingWrites = [];
globalThis.window = {
    setSetting(key, value) {
        settingWrites.push([key, value]);
    },
};

const session = await import('../modules/providers/janny/janny-session.js');

function b64url(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function makeJannyJwt(overrides = {}) {
    const claims = {
        sub: 'test-user',
        email: 'reader@example.test',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: 'https://eenzcbluoctduymzksoq.supabase.co/auth/v1',
        ...overrides,
    };
    return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.synthetic-signature`;
}

function encodedCookie(accessToken, refreshToken) {
    const value = `base64-${Buffer.from(JSON.stringify({ access_token: accessToken, refresh_token: refreshToken })).toString('base64url')}`;
    const middle = Math.ceil(value.length / 2);
    return `Cookie: sb-eenzcbluoctduymzksoq-auth-token.0=${value.slice(0, middle)}; sb-eenzcbluoctduymzksoq-auth-token.1=${value.slice(middle)}`;
}

function installHooks(overrides = {}) {
    const calls = { setSession: [], status: 0, refresh: 0, logout: 0 };
    session.setJannySessionBrowserHooks({
        async setSession(...args) {
            calls.setSession.push(args);
            return { ok: true };
        },
        async status() {
            calls.status += 1;
            return { active: true, email: 'reader@example.test', expMs: 2_000_000_000_000, hasRefresh: true, refreshable: true };
        },
        async refresh() {
            calls.refresh += 1;
            return { active: true, email: 'reader@example.test', expMs: 2_000_000_100_000, hasRefresh: true, refreshable: true };
        },
        async logout() {
            calls.logout += 1;
            return { ok: true, cleared: ['sb-eenzcbluoctduymzksoq-auth-token'] };
        },
        ...overrides,
    });
    return calls;
}

test('complete pasted session is installed once and returns only redacted browser status', async () => {
    settingWrites.length = 0;
    const accessToken = makeJannyJwt();
    const refreshToken = 'synthetic-refresh-value';
    const calls = installHooks({
        async status() {
            calls.status += 1;
            return {
                active: true,
                email: 'reader@example.test',
                expMs: 2_000_000_000_000,
                hasRefresh: true,
                refreshable: true,
                access_token: accessToken,
                refresh_token: refreshToken,
            };
        },
    });

    const result = await session.jannySetSession(encodedCookie(accessToken, refreshToken));

    assert.deepEqual(calls.setSession, [[accessToken, refreshToken]]);
    assert.equal(calls.status, 1);
    assert.deepEqual(result, {
        ok: true,
        active: true,
        email: 'reader@example.test',
        expMs: 2_000_000_000_000,
        hasRefresh: true,
        refreshable: true,
    });
    assert.deepEqual(settingWrites, [['jannyToken', null], ['jannyRefreshToken', null]]);
    assert.equal(JSON.stringify({ result, settingWrites }).includes(accessToken), false);
    assert.equal(JSON.stringify({ result, settingWrites }).includes(refreshToken), false);
});

test('bare future JWT installs without renewal capability', async () => {
    settingWrites.length = 0;
    const accessToken = makeJannyJwt();
    const calls = installHooks({
        async status() {
            calls.status += 1;
            return { active: true, email: 'reader@example.test', expMs: 2_000_000_000_000, hasRefresh: false, refreshable: false };
        },
    });

    const result = await session.jannySetSession(accessToken);

    assert.deepEqual(calls.setSession, [[accessToken, '']]);
    assert.equal(calls.refresh, 0);
    assert.deepEqual(result, {
        ok: true,
        active: true,
        email: 'reader@example.test',
        expMs: 2_000_000_000_000,
        hasRefresh: false,
        refreshable: false,
    });
});

test('wrong issuer is rejected before any browser operation', async () => {
    settingWrites.length = 0;
    const calls = installHooks();

    const result = await session.jannySetSession(makeJannyJwt({ iss: 'https://other-project.supabase.co/auth/v1' }));

    assert.deepEqual(result, { ok: false, error: 'That token belongs to a different site, not JannyAI.' });
    assert.deepEqual(calls, { setSession: [], status: 0, refresh: 0, logout: 0 });
    assert.deepEqual(settingWrites, []);
});

test('expired bare JWT is rejected before any browser operation', async () => {
    settingWrites.length = 0;
    const calls = installHooks();

    const result = await session.jannySetSession(makeJannyJwt({ exp: 1 }));

    assert.deepEqual(result, { ok: false, error: 'That JannyAI login token has expired. Copy a fresh complete session.' });
    assert.deepEqual(calls, { setSession: [], status: 0, refresh: 0, logout: 0 });
    assert.deepEqual(settingWrites, []);
});

test('expired complete session gets exactly one browser recovery and succeeds after rotation', async () => {
    settingWrites.length = 0;
    const accessToken = makeJannyJwt({ exp: 1 });
    const refreshToken = 'synthetic-rotation-input';
    const calls = installHooks({
        async status() {
            calls.status += 1;
            return { active: false, email: 'reader@example.test', expMs: 1000, hasRefresh: true, refreshable: true };
        },
        async refresh() {
            calls.refresh += 1;
            return { active: true, email: 'reader@example.test', expMs: 2_000_000_100_000, hasRefresh: true, refreshable: true };
        },
    });

    const result = await session.jannySetSession(encodedCookie(accessToken, refreshToken));

    assert.deepEqual(calls.setSession, [[accessToken, refreshToken]]);
    assert.equal(calls.status, 1);
    assert.equal(calls.refresh, 1);
    assert.deepEqual(result, {
        ok: true,
        active: true,
        email: 'reader@example.test',
        expMs: 2_000_000_100_000,
        hasRefresh: true,
        refreshable: true,
    });
    assert.deepEqual(settingWrites, [['jannyToken', null], ['jannyRefreshToken', null]]);
});

test('inactive browser recovery does not count as successful installation', async () => {
    settingWrites.length = 0;
    const calls = installHooks({
        async status() {
            calls.status += 1;
            return { active: false, email: '', expMs: 1000, hasRefresh: true, refreshable: true };
        },
        async refresh() {
            calls.refresh += 1;
            return { active: false, email: '', expMs: 1000, hasRefresh: true, refreshable: true };
        },
    });

    const result = await session.jannySetSession(encodedCookie(makeJannyJwt({ exp: 1 }), 'synthetic-refresh-value'));

    assert.equal(calls.refresh, 1);
    assert.deepEqual(result, {
        ok: false,
        error: 'JannyAI browser session is not active.',
        active: false,
        email: '',
        expMs: 1000,
        hasRefresh: true,
        refreshable: true,
    });
    assert.deepEqual(settingWrites, []);
});

test('session status strips credentials and never writes them to settings', async () => {
    settingWrites.length = 0;
    const calls = installHooks({
        async status() {
            calls.status += 1;
            return {
                active: true,
                email: 'reader@example.test',
                expMs: 2_000_000_000_000,
                hasRefresh: true,
                refreshable: true,
                token: 'synthetic-browser-token',
                refreshToken: 'synthetic-browser-refresh',
            };
        },
    });

    assert.deepEqual(await session.jannySessionStatus(), {
        active: true,
        email: 'reader@example.test',
        expMs: 2_000_000_000_000,
        hasRefresh: true,
        refreshable: true,
    });
    assert.equal(calls.status, 1);
    assert.deepEqual(settingWrites, []);
});

test('concurrent recovery calls share one browser navigation', async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const calls = installHooks({
        async refresh() {
            calls.refresh += 1;
            return pending;
        },
    });

    const recoveries = [session.jannyRecoverSession(), session.jannyRecoverSession(), session.jannyRecoverSession()];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.refresh, 1);
    finish({ active: true, email: 'reader@example.test', expMs: 2_000_000_100_000, hasRefresh: true, refreshable: true });

    const results = await Promise.all(recoveries);
    assert.equal(calls.refresh, 1);
    assert.deepEqual(results, Array(3).fill({
        active: true,
        email: 'reader@example.test',
        expMs: 2_000_000_100_000,
        hasRefresh: true,
        refreshable: true,
    }));
});

test('logout clears legacy settings once and returns no credential fields', async () => {
    settingWrites.length = 0;
    const calls = installHooks({
        async logout() {
            calls.logout += 1;
            return {
                ok: true,
                cleared: ['sb-eenzcbluoctduymzksoq-auth-token'],
                token: 'must-not-return',
                refreshToken: 'must-not-return-either',
            };
        },
    });

    const result = await session.jannyLogout();

    assert.equal(calls.logout, 1);
    assert.deepEqual(settingWrites, [['jannyToken', null], ['jannyRefreshToken', null]]);
    assert.deepEqual(result, { ok: true, cleared: ['sb-eenzcbluoctduymzksoq-auth-token'] });
});
