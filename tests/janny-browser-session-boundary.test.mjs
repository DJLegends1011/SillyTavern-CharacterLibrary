import test from 'node:test';
import assert from 'node:assert/strict';
import {
    JANNY_AUTH_COOKIE,
    JANNY_ORIGIN,
} from '../extras/cl-helper/janny-browser-policy.js';

const helper = await import('../extras/cl-helper/index.js');

function b64url(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function makeAccessToken(length = 3800) {
    const prefix = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
        email: 'reader@example.test',
        exp: 2_000_000_000,
    })}.`;
    return prefix + 's'.repeat(length - prefix.length);
}

class MemoryPage {
    constructor(cookies = []) {
        this.cookieJar = new Map();
        for (const cookie of cookies) this.store(cookie);
    }

    key(cookie) {
        return `${cookie.name}|${cookie.domain || 'jannyai.com'}|${cookie.path || '/'}`;
    }

    store(cookie) {
        this.cookieJar.set(this.key(cookie), {
            domain: 'jannyai.com',
            path: '/',
            ...cookie,
        });
    }

    snapshot() {
        return [...this.cookieJar.values()].map(cookie => ({ ...cookie }));
    }

    async allCookies() {
        const result = await this.send('Storage.getCookies');
        return result.cookies || [];
    }

    async cookies(urls) {
        assert.deepEqual(urls, [JANNY_ORIGIN]);
        const url = new URL(urls[0]);
        return this.snapshot().filter(cookie => {
            const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
            const domainMatches = url.hostname === domain || url.hostname.endsWith(`.${domain}`);
            const path = cookie.path || '/';
            const pathMatches = url.pathname === path
                || (url.pathname.startsWith(path) && (path.endsWith('/') || url.pathname[path.length] === '/'));
            return domainMatches && pathMatches;
        });
    }

    async send(method, payload) {
        if (method === 'Storage.getCookies') {
            assert.equal(payload, undefined);
            return { cookies: this.snapshot() };
        }
        if (method === 'Network.deleteCookies') {
            this.cookieJar.delete(this.key(payload));
            return {};
        }
        if (method === 'Network.setCookie') {
            this.store(payload);
            return { success: true };
        }
        throw new Error(`Unexpected page method: ${method}`);
    }
}

test('maximum accepted session round-trips through helper installation and redacted reading', async () => {
    const page = new MemoryPage();
    const accessToken = makeAccessToken();

    await helper.injectJannySession(page, accessToken, 'r'.repeat(3800));
    const cookies = await page.cookies([JANNY_ORIGIN]);

    assert.deepEqual(cookies.map(cookie => cookie.name), ['sb-access-token', 'sb-refresh-token']);
    assert.equal(cookies[0].value, accessToken);
    assert.deepEqual(helper.readJannyBrowserSession(cookies), {
        active: true,
        email: 'reader@example.test',
        expMs: 2_000_000_000_000,
        hasRefresh: true,
        refreshable: true,
    });
});

test('session replacement removes path-scoped Janny chunks without touching Cloudflare or foreign cookies', async () => {
    const page = new MemoryPage([
        { name: `${JANNY_AUTH_COOKIE}.0`, value: 'stale-head' },
        { name: `${JANNY_AUTH_COOKIE}.8`, value: 'stale-middle' },
        { name: `${JANNY_AUTH_COOKIE}.99`, value: 'stale-tail', domain: '.jannyai.com', path: '/auth' },
        { name: `${JANNY_AUTH_COOKIE}.42`, value: 'foreign-account-cookie', domain: 'other.example' },
        { name: 'cf_clearance', value: 'clearance-value' },
        { name: '__cf_bm', value: 'browser-value' },
        { name: 'unrelated', value: 'keep-me' },
    ]);

    await helper.injectJannySession(page, makeAccessToken(512), '');
    const cookies = await page.allCookies();

    assert.deepEqual(
        cookies.filter(cookie => String(cookie.domain).replace(/^\./, '') === 'jannyai.com')
            .filter(cookie => cookie.name === JANNY_AUTH_COOKIE || cookie.name.startsWith(`${JANNY_AUTH_COOKIE}.`))
            .map(cookie => cookie.name),
        [],
    );
    assert.deepEqual(
        cookies.filter(cookie => ['cf_clearance', '__cf_bm', 'unrelated', `${JANNY_AUTH_COOKIE}.42`].includes(cookie.name))
            .map(cookie => [cookie.name, cookie.value, cookie.domain]),
        [
            [`${JANNY_AUTH_COOKIE}.42`, 'foreign-account-cookie', 'other.example'],
            ['cf_clearance', 'clearance-value', 'jannyai.com'],
            ['__cf_bm', 'browser-value', 'jannyai.com'],
            ['unrelated', 'keep-me', 'jannyai.com'],
        ],
    );
});

test('a float exp claim is ignored identically when writing and when reading the session', async () => {
    const header = b64url({ alg: 'HS256', typ: 'JWT' });
    const accessToken = `${header}.${b64url({ email: 'reader@example.test', exp: 2_000_000_000.5 })}.signature`;
    const page = new MemoryPage();

    await helper.injectJannySession(page, accessToken, '');
    const cookies = await page.cookies([JANNY_ORIGIN]);

    // The writer falls back to its bounded one-hour expiry; the reader must not honour the
    // float either, or the two sides disagree about when the session dies.
    assert.notEqual(cookies[0].expires, 2_000_000_000);
    assert.equal(helper.readJannyBrowserSession(cookies).expMs, 0);
    assert.equal(helper.readJannyBrowserSession(cookies).active, true);
});

test('chunk-only installations migrate once to the native cookies used by Janny account routes', async () => {
    const token = makeAccessToken(512);
    const value = 'base64-' + Buffer.from(JSON.stringify({ access_token: token, refresh_token: 'refresh-old' })).toString('base64url');
    const page = new MemoryPage([
        { name: `${JANNY_AUTH_COOKIE}.0`, value: value.slice(0, 200) },
        { name: `${JANNY_AUTH_COOKIE}.1`, value: value.slice(200) },
        { name: 'cf_clearance', value: 'keep' },
    ]);
    await helper.migrateJannyBrowserSession(page);
    const cookies = await page.cookies([JANNY_ORIGIN]);
    assert.equal(cookies.find(cookie => cookie.name === 'sb-access-token').value, token);
    assert.equal(cookies.find(cookie => cookie.name === 'sb-refresh-token').value, 'refresh-old');
    assert.ok(!cookies.some(cookie => cookie.name.startsWith(JANNY_AUTH_COOKIE)));
    assert.equal(cookies.find(cookie => cookie.name === 'cf_clearance').value, 'keep');
    await helper.migrateJannyBrowserSession(page);
    assert.deepEqual(await page.cookies([JANNY_ORIGIN]), cookies);
});

test('native refresh rotation wins over stale chunks, including an incomplete native session', async () => {
    const stale = 'base64-' + Buffer.from(JSON.stringify({ access_token: makeAccessToken(512), refresh_token: 'stale' })).toString('base64url');
    const page = new MemoryPage([
        { name: JANNY_AUTH_COOKIE, value: stale },
        { name: 'sb-refresh-token', value: 'rotated' },
    ]);
    assert.deepEqual(helper.readJannyBrowserSession(await page.cookies([JANNY_ORIGIN])),
        { active: false, email: '', expMs: 0, hasRefresh: true, refreshable: true });
    await helper.migrateJannyBrowserSession(page);
    assert.deepEqual((await page.cookies([JANNY_ORIGIN])).map(cookie => cookie.name), ['sb-refresh-token']);
});

test('oversized native cookies are rejected before altering the installed login', async () => {
    const page = new MemoryPage([{ name: 'sb-access-token', value: makeAccessToken(512) }]);
    const before = page.snapshot();
    await assert.rejects(helper.injectJannySession(page, makeAccessToken(3801), 'refresh'));
    assert.deepEqual(page.snapshot(), before);
});

test('a malformed native access token is never reported active', () => {
    assert.equal(helper.readJannyBrowserSession([{ name: 'sb-access-token', value: 'not-a-jwt' }]).active, false);
});

test('a failed second cookie write preserves the source and removes the incomplete pair', async () => {
    const value = 'base64-' + Buffer.from(JSON.stringify({ access_token: makeAccessToken(512), refresh_token: 'refresh' })).toString('base64url');
    const page = new MemoryPage([{ name: JANNY_AUTH_COOKIE, value }]);
    const send = page.send.bind(page);
    page.send = async (method, cookie) => method === 'Network.setCookie' && cookie.name === 'sb-refresh-token'
        ? { success: false } : send(method, cookie);
    await assert.rejects(helper.migrateJannyBrowserSession(page), /installation failed/);
    assert.deepEqual((await page.cookies([JANNY_ORIGIN])).map(cookie => [cookie.name, cookie.value]), [[JANNY_AUTH_COOKIE, value]]);
});

test('installation removes old domain-scoped native cookies alongside the previous chunk format', async () => {
    const page = new MemoryPage([
        { name: 'sb-access-token', value: 'stale', domain: '.jannyai.com' },
        { name: 'sb-refresh-token', value: 'stale', domain: '.jannyai.com' },
    ]);
    await helper.injectJannySession(page, makeAccessToken(512), 'refresh');
    assert.ok((await page.allCookies()).every(cookie => cookie.domain === 'jannyai.com'));
    assert.equal((await page.allCookies()).length, 2);
});
