import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildJannyPublicRequestHeaders,
    buildFlareSolverrJannyRequest,
    detectJannyCloudflareChallenge,
    isAllowedJannyAccountRequest,
    isJannyCollectionFormPath,
    jannyFamilyOrder,
    parseJannyBookmarkPage,
    parseJannyPublicCollectionsPage,
    parseJannyPublicCollectionDetailPage,
    sanitizeJannyCookieHeader,
    summarizeJannyResponseForClient,
    validateJannyPublicCollectionPath,
    validateJannyPublicCharacterIds,
} from '../extras/cl-helper/janny-account.js';

test('sanitizeJannyCookieHeader accepts a full Cookie header without leaking shape', () => {
    const result = sanitizeJannyCookieHeader('Cookie: session=abc123 ; cf_clearance=clear.value ; __Host-next-auth.csrf-token=token%7Cmore ');

    assert.equal(result.ok, true);
    assert.equal(result.header, 'session=abc123; cf_clearance=clear.value; __Host-next-auth.csrf-token=token%7Cmore');
    assert.deepEqual(result.cookies, [
        { name: 'session', value: 'abc123' },
        { name: 'cf_clearance', value: 'clear.value' },
        { name: '__Host-next-auth.csrf-token', value: 'token%7Cmore' },
    ]);
});

test('sanitizeJannyCookieHeader rejects empty, control-character, and malformed cookies', () => {
    assert.equal(sanitizeJannyCookieHeader('').ok, false);
    assert.equal(sanitizeJannyCookieHeader('session=abc\r\nx-owned: yes').ok, false);
    assert.equal(sanitizeJannyCookieHeader('not-a-cookie').ok, false);
    assert.equal(sanitizeJannyCookieHeader('bad name=value').ok, false);
});

test('detectJannyCloudflareChallenge catches status, headers, and challenge body markers', () => {
    assert.equal(detectJannyCloudflareChallenge({
        status: 403,
        headers: { 'cf-mitigated': 'challenge' },
        body: '<html></html>',
    }), true);

    assert.equal(detectJannyCloudflareChallenge({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g"></script>',
    }), true);

    assert.equal(detectJannyCloudflareChallenge({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"bookmarks":[]}',
    }), false);
});

test('detectJannyCloudflareChallenge ignores the JS-detection script Cloudflare injects into legit pages', () => {
    assert.equal(detectJannyCloudflareChallenge({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<h1>Saved Characters (2)</h1><script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/80a697ecdece/main.js"></script>',
    }), false);

    assert.equal(detectJannyCloudflareChallenge({
        status: 403,
        headers: { 'server': 'nginx' },
        body: '<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>',
    }), true);
});

test('jannyFamilyOrder prefers the last working family and defaults to IPv6 first', () => {
    assert.deepEqual(jannyFamilyOrder(), [6, 4]);
    assert.deepEqual(jannyFamilyOrder(null), [6, 4]);
    assert.deepEqual(jannyFamilyOrder(6), [6, 4]);
    assert.deepEqual(jannyFamilyOrder(4), [4, 6]);
});

test('isAllowedJannyAccountRequest allows only account sync endpoints', () => {
    assert.equal(isAllowedJannyAccountRequest('GET', '/bookmark'), true);
    assert.equal(isAllowedJannyAccountRequest('GET', '/api/bookmark'), true);
    assert.equal(isAllowedJannyAccountRequest('POST', '/api/bookmark'), true);
    assert.equal(isAllowedJannyAccountRequest('DELETE', '/api/bookmark?ids=11111111-1111-4111-8111-111111111111'), true);
    assert.equal(isAllowedJannyAccountRequest('GET', '/api/get-characters?ids=11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222'), true);
    assert.equal(isAllowedJannyAccountRequest('GET', '/api/collections/mine'), true);
    assert.equal(isAllowedJannyAccountRequest('GET', '/api/collections/11111111-1111-4111-8111-111111111111/characters'), true);
    assert.equal(isAllowedJannyAccountRequest('POST', '/api/collections/11111111-1111-4111-8111-111111111111/characters'), true);
    assert.equal(isAllowedJannyAccountRequest('DELETE', '/api/collections/11111111-1111-4111-8111-111111111111/characters?characterId=22222222-2222-4222-8222-222222222222'), true);

    assert.equal(isAllowedJannyAccountRequest('GET', '/api/users/me'), false);
    assert.equal(isAllowedJannyAccountRequest('POST', '/api/collections/../../../characters'), false);
    assert.equal(isAllowedJannyAccountRequest('PUT', '/api/bookmark'), false);
    assert.equal(isAllowedJannyAccountRequest('GET', 'https://evil.example/api/bookmark'), false);
});

test('isAllowedJannyAccountRequest allows collection form POSTs but not the dead JSON create route', () => {
    assert.equal(isAllowedJannyAccountRequest('POST', '/collections/form/add-collection'), true);
    assert.equal(isAllowedJannyAccountRequest('POST', '/collections/form/edit-collection'), true);
    assert.equal(isAllowedJannyAccountRequest('POST', '/collections/form/delete-collection'), true);
    assert.equal(isAllowedJannyAccountRequest('GET', '/collections/form/add-collection'), false);
    assert.equal(isAllowedJannyAccountRequest('POST', '/api/collections'), false);
    assert.equal(isAllowedJannyAccountRequest('POST', '/collections/form/add-collection?x=1'), false);
});

test('isJannyCollectionFormPath recognizes only the form endpoints', () => {
    assert.equal(isJannyCollectionFormPath('/collections/form/add-collection'), true);
    assert.equal(isJannyCollectionFormPath('/collections/form/delete-collection'), true);
    assert.equal(isJannyCollectionFormPath('/api/collections/mine'), false);
    assert.equal(isJannyCollectionFormPath('https://evil.example/collections/form/add-collection'), false);
});

test('parseJannyBookmarkPage extracts count and unique character links', () => {
    const html = `
        <main>
            <h1>Saved Characters (220)</h1>
            <a href="/characters/11111111-1111-4111-8111-111111111111_character-alice">Alice</a>
            <a href="https://jannyai.com/characters/22222222-2222-4222-8222-222222222222_character-bob">Bob</a>
            <a href="/characters/11111111-1111-4111-8111-111111111111_character-alice">Duplicate</a>
        </main>
    `;

    const parsed = parseJannyBookmarkPage(html);
    assert.equal(parsed.totalCount, 220);
    assert.deepEqual(parsed.characterIds, [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
    ]);
    assert.deepEqual(parsed.characterUrls, [
        'https://jannyai.com/characters/11111111-1111-4111-8111-111111111111_character-alice',
        'https://jannyai.com/characters/22222222-2222-4222-8222-222222222222_character-bob',
    ]);
});
test('parseJannyPublicCollectionsPage parses live-style cards with images outside the title anchor', () => {
    const html = `
        <header><a href="https://jannyai.com/"><img src="https://jannyai.com/logo.png" alt="Logo"></a></header>
        <div>
            <div>
                <div>
                    <img src="https://image.jannyai.com/bot-avatars/a1.webp" alt="image">
                    <img src="https://image.jannyai.com/bot-avatars/a2.webp" alt="image">
                    <img src="https://image.jannyai.com/bot-avatars/a3.webp" alt="image">
                    <img src="https://image.jannyai.com/bot-avatars/a4.webp" alt="image">
                    <img src="https://image.jannyai.com/bot-avatars/a5.webp" alt="image">
                </div>
                <div>
                    <a href="https://jannyai.com/collections/11111111-1111-4111-8111-111111111111_mind-control"><h3>Mind Control (82 characters)</h3></a>
                    <p>Last updated: 7/9/2026</p>
                    <p>Bots that are good at mind-control.</p>
                </div>
                <div>
                    <span><img src="https://image.jannyai.com/user-avatars/owner-a.jpg">by <a href="https://jannyai.com/profiles/owner-a">AurelieCatena</a></span>
                    <span><img src="https://img.icons8.com/sticker/view.png" alt="view count"><strong>20572</strong> views</span>
                </div>
            </div>
            <div>
                <div>
                    <img src="https://image.jannyai.com/bot-avatars/b1.webp" alt="image">
                    <img src="https://image.jannyai.com/bot-avatars/b2.webp" alt="image">
                </div>
                <div>
                    <a href="/collections/22222222-2222-4222-8222-222222222222_clickable"><h3>Clickable Bot Catalogs (2 characters)</h3></a>
                    <p>Last updated: 7/8/2026</p>
                    <p>Lists of characters with clickable covers.</p>
                </div>
                <div>
                    <span><img src="https://lh3.googleusercontent.com/a/owner-b=s96-c">by <a href="https://jannyai.com/profiles/owner-b">Archivist</a></span>
                    <span><img src="https://img.icons8.com/sticker/view.png" alt="view count"><strong>11099</strong> views</span>
                </div>
            </div>
        </div>
        <a href="/collections?page=2">Next</a>
    `;

    const parsed = parseJannyPublicCollectionsPage(html);
    assert.equal(parsed.collections.length, 2);
    const [first, second] = parsed.collections;
    assert.equal(first.name, 'Mind Control');
    assert.equal(first.characterCount, 82);
    assert.equal(first.description, 'Bots that are good at mind-control.');
    assert.equal(first.ownerName, 'AurelieCatena');
    assert.equal(first.viewCount, 20572);
    assert.equal(first.updatedAt, '7/9/2026');
    assert.deepEqual(first.images, [
        'https://image.jannyai.com/bot-avatars/a1.webp',
        'https://image.jannyai.com/bot-avatars/a2.webp',
        'https://image.jannyai.com/bot-avatars/a3.webp',
        'https://image.jannyai.com/bot-avatars/a4.webp',
    ]);
    assert.equal(second.name, 'Clickable Bot Catalogs');
    assert.equal(second.characterCount, 2);
    assert.equal(second.description, 'Lists of characters with clickable covers.');
    assert.equal(second.ownerName, 'Archivist');
    assert.equal(second.viewCount, 11099);
    assert.equal(second.updatedAt, '7/8/2026');
    assert.deepEqual(second.images, [
        'https://image.jannyai.com/bot-avatars/b1.webp',
        'https://image.jannyai.com/bot-avatars/b2.webp',
    ]);
    assert.equal(parsed.hasMore, true);
});

test('parseJannyPublicCollectionsPage extracts anchor-wrapped collection cards', () => {
    const html = `
        <main>
            <a class="collection-card" href="/collections/11111111-1111-4111-8111-111111111111_daily-finds">
                <img src="https://image.jannyai.com/bot-avatars/a.webp" alt="">
                <img src="https://image.jannyai.com/bot-avatars/b.webp" alt="">
                <h2>Daily Finds</h2>
                <p>A public list worth browsing.</p>
                <span>12 characters</span>
                <span>by Yuuri</span>
                <span>1.2K views</span>
                <time datetime="2026-07-08">Jul 8, 2026</time>
            </a>
            <a class="collection-card" href="https://jannyai.com/collections/22222222-2222-4222-8222-222222222222_lore-box">
                <h3>Lore Box</h3>
                <p>Plot-heavy cards.</p>
                <span>3 cards</span>
                <span>by Archivist</span>
                <span>48 views</span>
            </a>
        </main>
    `;

    const parsed = parseJannyPublicCollectionsPage(html);
    assert.equal(parsed.collections.length, 2);
    assert.deepEqual(parsed.collections[0], {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Daily Finds',
        path: '/collections/11111111-1111-4111-8111-111111111111_daily-finds',
        url: 'https://jannyai.com/collections/11111111-1111-4111-8111-111111111111_daily-finds',
        description: 'A public list worth browsing.',
        characterCount: 12,
        ownerName: 'Yuuri',
        viewCount: 1200,
        updatedAt: '2026-07-08',
        images: [
            'https://image.jannyai.com/bot-avatars/a.webp',
            'https://image.jannyai.com/bot-avatars/b.webp',
        ],
    });
    assert.equal(parsed.collections[1].characterCount, 3);
    assert.equal(parsed.collections[1].ownerName, 'Archivist');
    assert.equal(parsed.hasMore, false);
});

test('parseJannyPublicCollectionDetailPage parses the live header layout without page bleed', () => {
    const html = `
        <header><a href="https://jannyai.com/"><img src="https://jannyai.com/logo.png" alt="Logo"></a></header>
        <div>
            <div>
                <img src="https://image.jannyai.com/bot-avatars/p1.webp">
                <img src="https://image.jannyai.com/bot-avatars/p2.webp">
                <img src="https://image.jannyai.com/bot-avatars/p3.webp">
                <img src="https://image.jannyai.com/bot-avatars/p4.webp">
                <img src="https://image.jannyai.com/bot-avatars/p5.webp">
            </div>
            <div>
                <h1>Try another time (Prob favorites)<span><img src="https://image.jannyai.com/user-avatars/owner.jpg"><span>by</span><a href="https://jannyai.com/collections/user/prota">Prota Shonen</a></span></h1>
                <p>Last updated: 7/9/2026</p>
                <div><div><p>This is a list of bots that I want to try on later.</p></div></div>
            </div>
        </div>
        <div>
            <h2>Characters (250)</h2>
            <a href="/characters/33333333-3333-4333-8333-333333333333_character-one">
                <p>At the party, your bully's girlfriend... a story by SomeoneElse with 99 views</p>
            </a>
            <a href="https://jannyai.com/characters/44444444-4444-4444-8444-444444444444_character-two"><p>Another tagline</p></a>
            <a href="/characters/33333333-3333-4333-8333-333333333333_character-one">Duplicate</a>
        </div>
    `;

    const parsed = parseJannyPublicCollectionDetailPage(html, '/collections/74993388-9f25-4ecb-8e80-f81e134a1560_try-another-time');
    assert.equal(parsed.collection.id, '74993388-9f25-4ecb-8e80-f81e134a1560');
    assert.equal(parsed.collection.name, 'Try another time (Prob favorites)');
    assert.equal(parsed.collection.ownerName, 'Prota Shonen');
    assert.equal(parsed.collection.description, 'This is a list of bots that I want to try on later.');
    assert.equal(parsed.collection.updatedAt, '7/9/2026');
    assert.equal(parsed.collection.characterCount, 250);
    assert.equal(parsed.collection.viewCount, null);
    assert.deepEqual(parsed.collection.images, [
        'https://image.jannyai.com/bot-avatars/p1.webp',
        'https://image.jannyai.com/bot-avatars/p2.webp',
        'https://image.jannyai.com/bot-avatars/p3.webp',
        'https://image.jannyai.com/bot-avatars/p4.webp',
    ]);
    assert.deepEqual(parsed.characterIds, [
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
    ]);
});

test('parseJannyPublicCollectionDetailPage extracts metadata and unique character ids', () => {
    const html = `
        <article>
            <h1>Daily Finds</h1>
            <p>Collected cards with strong intros.</p>
            <span>by Yuuri</span>
            <span>12 characters</span>
            <span>1,234 views</span>
            <time datetime="2026-07-08">Jul 8, 2026</time>
            <a href="/characters/33333333-3333-4333-8333-333333333333_character-one">One</a>
            <a href="https://jannyai.com/characters/44444444-4444-4444-8444-444444444444_character-two">Two</a>
            <a href="/characters/33333333-3333-4333-8333-333333333333_character-one">Duplicate</a>
        </article>
    `;

    const parsed = parseJannyPublicCollectionDetailPage(html, '/collections/11111111-1111-4111-8111-111111111111_daily-finds');
    assert.equal(parsed.collection.id, '11111111-1111-4111-8111-111111111111');
    assert.equal(parsed.collection.name, 'Daily Finds');
    assert.equal(parsed.collection.description, 'Collected cards with strong intros.');
    assert.equal(parsed.collection.ownerName, 'Yuuri');
    assert.equal(parsed.collection.characterCount, 12);
    assert.equal(parsed.collection.viewCount, 1234);
    assert.equal(parsed.collection.updatedAt, '2026-07-08');
    assert.deepEqual(parsed.characterIds, [
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
    ]);
});

test('Janny public collection validators accept only narrow read inputs', () => {
    assert.equal(validateJannyPublicCollectionPath('/collections/11111111-1111-4111-8111-111111111111_daily-finds').ok, true);
    assert.equal(validateJannyPublicCollectionPath('/collections/11111111-1111-4111-8111-111111111111_daily-finds/edit').ok, false);
    assert.equal(validateJannyPublicCollectionPath('https://evil.example/collections/11111111-1111-4111-8111-111111111111_x').ok, false);

    assert.equal(validateJannyPublicCharacterIds('33333333-3333-4333-8333-333333333333,44444444-4444-4444-8444-444444444444').ok, true);
    assert.equal(validateJannyPublicCharacterIds('../../../etc/passwd').ok, false);
});

test('buildJannyPublicRequestHeaders reuses validated session cookies and avoids zstd bodies', () => {
    const headers = buildJannyPublicRequestHeaders({
        cookieHeader: 'session=abc; cf_clearance=clear',
        userAgent: 'TestAgent/1.0',
    });

    assert.equal(headers['User-Agent'], 'TestAgent/1.0');
    assert.equal(headers.Cookie, 'session=abc; cf_clearance=clear');
    assert.equal(headers['Accept-Encoding'], 'gzip, deflate, br');
    assert.equal(headers.Referer, 'https://jannyai.com/');
});
test('buildFlareSolverrJannyRequest pins target, cookies, user agent, and session', () => {
    const cookie = sanitizeJannyCookieHeader('session=abc; cf_clearance=clear');
    const body = buildFlareSolverrJannyRequest({
        path: '/api/collections/mine',
        sessionId: 'janny-session',
        cookie,
    });

    assert.equal(body.cmd, 'request.get');
    assert.equal(body.url, 'https://jannyai.com/api/collections/mine');
    assert.equal(body.session, 'janny-session');
    assert.equal(body.maxTimeout > 1000, true);
    assert.deepEqual(body.cookies, [
        { name: 'session', value: 'abc' },
        { name: 'cf_clearance', value: 'clear' },
    ]);
});

test('summarizeJannyResponseForClient hides raw Cloudflare challenge bodies', () => {
    const rawChallengeBody = '\u0000\u0001\u0002'.repeat(2048) + '<title>Just a moment...</title>';
    const summary = summarizeJannyResponseForClient({
        status: 403,
        contentType: 'application/octet-stream',
        cloudflare: true,
        body: rawChallengeBody,
    });

    assert.deepEqual(summary, { error: 'Cloudflare challenge', cloudflare: true });
    assert.equal(Object.hasOwn(summary, 'text'), false);
    assert.equal(Object.hasOwn(summary, 'html'), false);
});