// Shared collection card for browse views: a titled group of characters shown as a
// 2x2 cover mosaic (DataCat community collections are the first user).
//
// Covers load through BrowseView's image loader, not native lazy loading: every tile
// is a .browse-card-image wrapper holding an <img data-src>, so the caller's usual
// view.observeImages(grid) gives them the shimmer, fade-in, eager viewport load and the
// ai4 fallback on error, exactly like browse cards. List the grid in the view's
// _getImageGridIds() so reconnectImageObserver() picks it up after a tab switch.
// Styles live in browse-shared.css (.browse-collection-*).

import CoreAPI from '../core-api.js';
import { IMG_PLACEHOLDER, formatNumber } from './provider-utils.js';

export const COLLECTION_COVER_TILES = 4;

// Accents land in a style attribute, so only a hex colour or a CSS variable gets through.
const SAFE_ACCENT_RE = /^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\))$/i;

const esc = (value) => CoreAPI.escapeHtml(String(value ?? ''));

function renderCoverTile(url) {
    if (!url) return '<span class="browse-collection-tile browse-collection-tile-empty"></span>';
    return `<span class="browse-collection-tile browse-card-image"><img data-src="${esc(url)}" src="${IMG_PLACEHOLDER}" alt="" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/ai4.png'"></span>`;
}

/**
 * @param {Object} c
 * @param {string} c.id - Opaque id handed back by getCollectionCardId / wireCollectionGrid
 * @param {string} c.title
 * @param {string} [c.byline] - eg. "by @curator"
 * @param {number} [c.count] - Characters in the collection; the pill is hidden when falsy
 * @param {string} [c.countLabel='characters']
 * @param {Array<string|null>} [c.coverUrls] - Resolved image URLs; the first four non-empty are used
 * @param {boolean} [c.nsfw]
 * @param {string[]} [c.tags] - Up to three are shown
 * @param {string} [c.footer] - Muted last line, eg. "Updated 9/23/2026"
 * @param {string|null} [c.accent] - Top stripe colour (#hex or var(--x)); theme accent otherwise
 * @returns {string} HTML
 */
export function renderCollectionCard({
    id,
    title,
    byline = '',
    count = 0,
    countLabel = 'characters',
    coverUrls = [],
    nsfw = false,
    tags = [],
    footer = '',
    accent = null,
}) {
    const name = title || 'Untitled collection';
    const covers = (Array.isArray(coverUrls) ? coverUrls : []).filter(Boolean).slice(0, COLLECTION_COVER_TILES);
    const tiles = Array.from({ length: COLLECTION_COVER_TILES }, (_, i) => renderCoverTile(covers[i])).join('');
    const shownTags = (Array.isArray(tags) ? tags : []).filter(Boolean).slice(0, 3);
    const style = accent && SAFE_ACCENT_RE.test(accent) ? ` style="--collection-accent: ${accent}"` : '';
    const total = Number(count) || 0;

    return `
        <div class="browse-collection-card" data-collection-id="${esc(id)}"${style} tabindex="0" role="button" aria-label="Open ${esc(name)}">
            <div class="browse-collection-mosaic">
                ${tiles}
                ${nsfw ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}
                ${total ? `<span class="browse-collection-count"><strong>${formatNumber(total)}</strong> ${esc(countLabel)}</span>` : ''}
            </div>
            <div class="browse-collection-body">
                <div class="browse-collection-title">${esc(name)}</div>
                ${byline ? `<div class="browse-collection-byline">${esc(byline)}</div>` : ''}
                ${shownTags.length ? `<div class="browse-card-tags">${shownTags.map(t => `<span class="browse-card-tag" title="${esc(t)}">${esc(t)}</span>`).join('')}</div>` : ''}
                ${footer ? `<div class="browse-collection-footer"><i class="fa-solid fa-clock"></i> ${esc(footer)}</div>` : ''}
            </div>
        </div>
    `;
}

/** The collection id of the card containing `el`, or null. */
export function getCollectionCardId(el) {
    return el?.closest?.('.browse-collection-card')?.dataset?.collectionId || null;
}

/**
 * Open a collection on click, Enter or Space anywhere in `grid`. Safe to call again
 * for the same grid; it only wires once.
 * @param {HTMLElement} grid
 * @param {(id: string) => void} onOpen
 */
export function wireCollectionGrid(grid, onOpen) {
    if (!grid || grid.dataset.collectionGridWired) return;
    grid.dataset.collectionGridWired = '1';
    grid.addEventListener('click', (e) => {
        const id = getCollectionCardId(e.target);
        if (id) onOpen(id);
    });
    grid.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const id = getCollectionCardId(e.target);
        if (!id) return;
        e.preventDefault();
        onOpen(id);
    });
}
