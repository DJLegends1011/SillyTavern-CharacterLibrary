import test from 'node:test';
import assert from 'node:assert/strict';

import {
    detectJannyCloudflareBody,
    parseJannyPublicCollectionsPage,
    parseJannyPublicCollectionDetailPage,
    validateJannyCollectorName,
    validateJannyPublicCollectionPath,
} from '../modules/providers/janny/janny-html.js';

test('detectJannyCloudflareBody flags real challenges but not injected scripts on 2xx', () => {
    assert.equal(detectJannyCloudflareBody(403, '<title>Just a moment...</title>'), true);
    assert.equal(detectJannyCloudflareBody(403, 'window._cf_chl_opt = {}'), true);
    assert.equal(detectJannyCloudflareBody(403, '<script src="/cdn-cgi/challenge-platform/h/g"></script>'), true);
    // Cloudflare injects its detection script into legitimate 200s — not a challenge.
    assert.equal(detectJannyCloudflareBody(200, '<script src="/cdn-cgi/challenge-platform/h/g"></script><div>real page</div>'), false);
    assert.equal(detectJannyCloudflareBody(200, '<title>Just a moment</title>'), true);
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

test('parseJannyPublicCollectionsPage handles collector profile pages without footer bleed', () => {
    const html = `
        <div>
            <h1>Profile of Prota Shonen</h1>
            <h2>Public Collections (2)</h2>
            <div>
                <div>
                    <img src="https://image.jannyai.com/bot-avatars/c1.webp" alt="image">
                    <img src="https://image.jannyai.com/bot-avatars/c2.webp" alt="image">
                </div>
                <div>
                    <a href="/collections/74993388-9f25-4ecb-8e80-f81e134a1560_try-another-time"><h3>Try another time (546 characters)</h3></a>
                    <p>Last updated: 7/9/2026</p>
                    <p>Bots I want to try later.</p>
                </div>
                <div><span><img src="https://image.jannyai.com/user-avatars/o.jpg">by <a href="https://jannyai.com/collectors/Prota%20Shonen">Prota Shonen</a></span><span><strong>5414</strong> views</span></div>
            </div>
            <div>
                <div>
                    <img src="https://image.jannyai.com/bot-avatars/d1.webp" alt="image">
                </div>
                <div>
                    <a href="/collections/22222222-2222-4222-8222-222222222222_deleted-stuff"><h3>Deleted stuff (72 characters)</h3></a>
                    <p>Last updated: 6/21/2026</p>
                </div>
                <div><span><img src="https://image.jannyai.com/user-avatars/o.jpg">by <a href="https://jannyai.com/collectors/Prota%20Shonen">Prota Shonen</a></span><span><strong>6022</strong> views</span></div>
            </div>
        </div>
        <footer><p>We created this page because JanitorAI went away.</p></footer>
    `;

    const parsed = parseJannyPublicCollectionsPage(html);
    assert.equal(parsed.collections.length, 2);
    assert.equal(parsed.collections[0].name, 'Try another time');
    assert.equal(parsed.collections[0].characterCount, 546);
    assert.equal(parsed.collections[1].name, 'Deleted stuff');
    assert.equal(parsed.collections[1].ownerName, 'Prota Shonen');
    // Second card has no description; the site footer's <p> must not leak in.
    assert.equal(parsed.collections[1].description, '');
    assert.deepEqual(parsed.collections[1].images, ['https://image.jannyai.com/bot-avatars/d1.webp']);
});

test('validateJannyCollectorName accepts usernames and rejects path-breaking input', () => {
    assert.deepEqual(validateJannyCollectorName(' Prota Shonen '), { ok: true, name: 'Prota Shonen' });
    assert.equal(validateJannyCollectorName('').ok, false);
    assert.equal(validateJannyCollectorName('a/b').ok, false);
    assert.equal(validateJannyCollectorName('a\\b').ok, false);
    assert.equal(validateJannyCollectorName('bad\r\nname').ok, false);
    assert.equal(validateJannyCollectorName('x'.repeat(200)).ok, false);
});

test('validateJannyPublicCollectionPath accepts only narrow read inputs', () => {
    assert.equal(validateJannyPublicCollectionPath('/collections/11111111-1111-4111-8111-111111111111_daily-finds').ok, true);
    assert.equal(validateJannyPublicCollectionPath('/collections/11111111-1111-4111-8111-111111111111_daily-finds/edit').ok, false);
    assert.equal(validateJannyPublicCollectionPath('https://evil.example/collections/11111111-1111-4111-8111-111111111111_x').ok, false);
});
