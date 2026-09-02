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

function makeAccessToken(length = 16_384) {
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

    await helper.injectJannySession(page, accessToken, 'r'.repeat(16_384));
    const cookies = await page.cookies([JANNY_ORIGIN]);

    assert.ok(cookies.filter(cookie => cookie.name.startsWith(`${JANNY_AUTH_COOKIE}.`)).length > 8);
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
        [JANNY_AUTH_COOKIE],
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
    const stored = JSON.parse(Buffer.from(
        decodeURIComponent(cookies[0].value).slice('base64-'.length), 'base64').toString('utf8'));

    // The writer falls back to its bounded one-hour expiry; the reader must not honour the
    // float either, or the two sides disagree about when the session dies.
    assert.notEqual(stored.expires_at, 2_000_000_000);
    assert.equal(helper.readJannyBrowserSession(cookies).expMs, 0);
    assert.equal(helper.readJannyBrowserSession(cookies).active, true);
});
