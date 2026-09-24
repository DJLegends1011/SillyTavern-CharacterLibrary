import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

import {
    renderCollectionCard,
    getCollectionCardId,
    COLLECTION_COVER_TILES,
} from '../modules/providers/browse-collection-card.js';
import { IMG_PLACEHOLDER } from '../modules/providers/provider-utils.js';

before(() => {
    // CoreAPI delegates escaping to the app global.
    window.escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
});

const count = (html, needle) => html.split(needle).length - 1;

describe('renderCollectionCard', () => {
    const base = { id: 'slug-1', title: 'Cozy Fantasy', coverUrls: ['https://a/1.webp', 'https://a/2.webp'] };

    it('always renders four tiles: covers first, then empty tiles', () => {
        const html = renderCollectionCard(base);
        assert.equal(COLLECTION_COVER_TILES, 4);
        assert.equal(count(html, 'class="browse-collection-tile '), 4);
        assert.equal(count(html, 'browse-collection-tile-empty'), 2);
    });

    it('routes covers through the BrowseView loader (card-image wrapper + data-src + placeholder)', () => {
        const html = renderCollectionCard(base);
        assert.equal(count(html, 'browse-collection-tile browse-card-image'), 2);
        assert.ok(html.includes('data-src="https://a/1.webp"'));
        assert.ok(html.includes(`src="${IMG_PLACEHOLDER}"`));
        assert.ok(html.includes('onerror='), 'failed covers fall back like browse cards');
        assert.ok(!html.includes('loading="lazy"'), 'native lazy loading is replaced by the observer');
    });

    it('ignores extra and empty cover urls', () => {
        const html = renderCollectionCard({ ...base, coverUrls: ['https://a/1', null, '', 'https://a/2', 'https://a/3', 'https://a/4', 'https://a/5'] });
        assert.equal(count(html, 'data-src='), 4);
        assert.ok(!html.includes('https://a/5'));
    });

    it('escapes provider text and the id', () => {
        const html = renderCollectionCard({ id: 'x"><b>', title: '<script>alert(1)</script>', byline: 'by @<i>me</i>', tags: ['<t>'] });
        assert.ok(!html.includes('<script>'));
        assert.ok(!html.includes('<i>me'));
        assert.ok(!html.includes('<t>'));
        assert.ok(html.includes('data-collection-id="x&quot;&gt;&lt;b&gt;"'));
    });

    it('shows the count pill, NSFW badge, tags and footer only when given', () => {
        const bare = renderCollectionCard({ id: 'a', title: 'A' });
        assert.ok(!bare.includes('browse-nsfw-badge'));
        assert.ok(!bare.includes('browse-collection-count'));
        assert.ok(!bare.includes('browse-card-tags'));
        assert.ok(!bare.includes('browse-collection-footer'));

        const full = renderCollectionCard({ id: 'a', title: 'A', count: 1234, countLabel: 'bots', nsfw: true, tags: ['One', 'Two'], footer: 'Updated 9/23/2026' });
        assert.ok(full.includes('browse-nsfw-badge'));
        assert.ok(full.includes('<strong>1.2K</strong> bots'));
        assert.equal(count(full, 'class="browse-card-tag"'), 2);
        assert.ok(full.includes('Updated 9/23/2026'));
    });

    it('accepts only hex or CSS-variable accents', () => {
        assert.ok(renderCollectionCard({ id: 'a', title: 'A', accent: '#c77dff' }).includes('style="--collection-accent: #c77dff"'));
        assert.ok(renderCollectionCard({ id: 'a', title: 'A', accent: 'var(--accent)' }).includes('--collection-accent: var(--accent)'));
        for (const bad of ['red; background:url(x)', 'url(javascript:1)', '#12345g', 'expression(1)']) {
            assert.ok(!renderCollectionCard({ id: 'a', title: 'A', accent: bad }).includes('--collection-accent'), bad);
        }
    });

    it('is a keyboard-focusable button with a label', () => {
        const html = renderCollectionCard({ id: 'a', title: 'Cozy' });
        assert.ok(html.includes('tabindex="0"'));
        assert.ok(html.includes('role="button"'));
        assert.ok(html.includes('aria-label="Open Cozy"'));
    });
});

describe('getCollectionCardId', () => {
    it('reads the id from the nearest card', () => {
        const card = { dataset: { collectionId: 'slug-9' } };
        const target = { closest: (sel) => (sel === '.browse-collection-card' ? card : null) };
        assert.equal(getCollectionCardId(target), 'slug-9');
    });
    it('returns null outside a card or for a missing target', () => {
        assert.equal(getCollectionCardId({ closest: () => null }), null);
        assert.equal(getCollectionCardId(null), null);
    });
});
