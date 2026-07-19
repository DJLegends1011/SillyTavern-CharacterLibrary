// JannyAI HTML parsers for public collection pages — moved client-side from cl-helper now that the userscript bridge fetches these pages in the browser.

export const JANNY_BASE = 'https://jannyai.com';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHARACTER_PATH_RE = /^\/characters\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:_[^/?#]+)?$/i;
const COLLECTION_PATH_RE = /^\/collections\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:_[^/?#]+)?$/i;
const CHARACTER_LINK_RE = /href=["'](https:\/\/jannyai\.com)?(\/characters\/[0-9a-f-]+(?:_[^"'?#\s<>]+)?)/ig;

function decodeJannyHtml(text) {
    return String(text || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x2F;/g, '/');
}

function stripJannyTags(text) {
    return decodeJannyHtml(String(text || '').replace(/<[^>]*>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}

function parseJannyCompactNumber(value) {
    const raw = String(value || '').replace(/,/g, '').trim();
    const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)(k|m)?$/i);
    if (!match) return null;
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return null;
    const suffix = (match[2] || '').toLowerCase();
    if (suffix === 'm') return Math.round(base * 1_000_000);
    if (suffix === 'k') return Math.round(base * 1_000);
    return Math.round(base);
}

function jannyAttr(attrs, name) {
    const match = String(attrs || '').match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
    return match ? decodeJannyHtml(match[2]).trim() : '';
}

function normalizeJannyCollectionPath(href) {
    const value = decodeJannyHtml(href || '').trim();
    let path = value;
    if (/^https?:\/\//i.test(value)) {
        let parsed;
        try { parsed = new URL(value); } catch { return null; }
        if (parsed.origin !== JANNY_BASE) return null;
        if (parsed.search || parsed.hash) return null;
        path = parsed.pathname;
    }
    const match = path.match(COLLECTION_PATH_RE);
    return match ? { id: match[1], path } : null;
}

function extractJannyCollectionName(block, attrs = '') {
    const heading = String(block || '').match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i);
    return (heading ? stripJannyTags(heading[1]) : '')
        || jannyAttr(attrs, 'aria-label')
        || jannyAttr(attrs, 'title');
}

function extractJannyUpdatedAt(block) {
    const match = String(block || '').match(/\bdatetime\s*=\s*(["'])([\s\S]*?)\1/i);
    if (match) return decodeJannyHtml(match[2]).trim().split('T')[0] || null;
    const textMatch = stripJannyTags(block).match(/\blast\s+updated\s*:?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{2,4}|[0-9]{4}-[0-9]{2}-[0-9]{2})/i);
    return textMatch ? textMatch[1] : null;
}

// Collection previews are always member bot avatars; the surrounding card
// markup also carries the owner avatar (/user-avatars/ or googleusercontent)
// and icon sprites, so only bot-avatar URLs qualify as preview images.
function extractJannyImages(...blocks) {
    const images = [];
    const seen = new Set();
    const re = /<img\b[^>]*\bsrc\s*=\s*(["'])([\s\S]*?)\1/ig;
    for (const block of blocks) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(String(block || ''))) && images.length < 4) {
            const src = decodeJannyHtml(match[2]).trim();
            if (!src || !src.includes('/bot-avatars/') || seen.has(src)) continue;
            seen.add(src);
            images.push(src);
        }
        if (images.length >= 4) break;
    }
    return images;
}

function extractJannyOwnerName(text) {
    const match = String(text || '').match(/\bby\s+(.+?)(?=\s+(?:[0-9,.]+[km]?\s+views|[0-9,]+\s*(?:characters|cards)|last\s+updated\b|[A-Z][a-z]{2}\s+\d{1,2}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})|$)/i);
    return match ? match[1].trim() : '';
}

function parseAccountPath(path) {
    if (!path || typeof path !== 'string') return null;
    if (/^https?:\/\//i.test(path)) return null;
    if (!path.startsWith('/')) return null;
    if (path.length > 1024 || /[\0\r\n]/.test(path)) return null;
    let parsed;
    try { parsed = new URL(path, JANNY_BASE); } catch { return null; }
    if (parsed.origin !== JANNY_BASE) return null;
    return parsed;
}

export function validateJannyPublicCollectionPath(path) {
    const parsed = parseAccountPath(path);
    if (!parsed) return { ok: false, error: 'collection path is required' };
    if (parsed.searchParams.size !== 0) return { ok: false, error: 'collection path cannot include query parameters' };
    if (!COLLECTION_PATH_RE.test(parsed.pathname)) return { ok: false, error: 'collection path is not public-readable' };
    return { ok: true, path: parsed.pathname };
}

// Collector profile pages live at /collectors/<username> and list that
// user's public collections with the same card markup as /collections.
export function validateJannyCollectorName(name) {
    const value = String(name || '').trim();
    if (!value) return { ok: false, error: 'collector name is required' };
    if (value.length > 128 || /[\0-\x1f/\\]/.test(value)) return { ok: false, error: 'collector name is not valid' };
    return { ok: true, name: value };
}

const JANNY_CARD_SEGMENT_CAP = 6000;
const JANNY_LAST_UPDATED_TEXT_RE = /^\s*last\s+updated\b/i;

function stripJannyParagraphs(block) {
    return String(block || '').replace(/<p\b[^>]*>[\s\S]*?<\/p>/ig, ' ');
}

function extractJannyCardDescription(...blocks) {
    const re = /<p\b[^>]*>([\s\S]*?)<\/p>/ig;
    for (const block of blocks) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(String(block || '')))) {
            const text = stripJannyTags(match[1]);
            if (text && !JANNY_LAST_UPDATED_TEXT_RE.test(text)) return text;
        }
    }
    return '';
}

function stripJannyCollectionNameSuffix(name) {
    return String(name || '').replace(/\s*\(\s*[0-9,]+\s*(?:characters?|cards?)\s*\)\s*$/i, '').trim();
}

export function parseJannyPublicCollectionsPage(html) {
    const text = String(html || '');
    const seen = new Set();
    const anchors = [];
    const anchorRe = /<a\b([^>]*\bhref\s*=\s*(["'])([\s\S]*?)\2[^>]*)>([\s\S]*?)<\/a>/ig;
    let match;
    while ((match = anchorRe.exec(text))) {
        const normalized = normalizeJannyCollectionPath(match[3]);
        if (!normalized || seen.has(normalized.id)) continue;
        seen.add(normalized.id);
        anchors.push({ normalized, attrs: match[1], block: match[4], start: match.index, end: match.index + match[0].length });
    }

    // JannyAI's live card markup wraps only the <h3> title in the collection
    // link: the preview <img> strip sits in a sibling div BEFORE the anchor,
    // while the "Last updated" line, description, owner, and view count come
    // AFTER it. Slice the page between neighbouring title anchors so each card
    // only sees its own markup (capped so the outermost cards can't swallow
    // the page header/footer). Anchor-wrapped cards keep working because the
    // anchor block is always consulted too.
    const collections = anchors.map((anchor, i) => {
        const beforeStart = i > 0 ? anchors[i - 1].end : 0;
        const before = text.slice(Math.max(beforeStart, anchor.start - JANNY_CARD_SEGMENT_CAP), anchor.start);
        // The last card's segment must stop at the site footer, whose <p> text
        // would otherwise become the description of a card that has none.
        const footerIndex = text.indexOf('<footer', anchor.end);
        const afterEnd = Math.min(
            i + 1 < anchors.length ? anchors[i + 1].start : text.length,
            footerIndex >= 0 ? footerIndex : text.length,
            anchor.end + JANNY_CARD_SEGMENT_CAP,
        );
        const after = text.slice(anchor.end, afterEnd);

        const titleText = stripJannyTags(anchor.block);
        const footerText = stripJannyTags(stripJannyParagraphs(after));
        const cardText = `${titleText} ${footerText}`;
        const countMatch = cardText.match(/([0-9,]+)\s*(?:characters|cards)/i);
        const viewsMatch = cardText.match(/([0-9,.]+[km]?)\s*views/i);

        return {
            id: anchor.normalized.id,
            name: stripJannyCollectionNameSuffix(extractJannyCollectionName(anchor.block, anchor.attrs)),
            path: anchor.normalized.path,
            url: `${JANNY_BASE}${anchor.normalized.path}`,
            description: extractJannyCardDescription(anchor.block, after),
            characterCount: countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : null,
            ownerName: extractJannyOwnerName(cardText),
            viewCount: viewsMatch ? parseJannyCompactNumber(viewsMatch[1]) : null,
            updatedAt: extractJannyUpdatedAt(anchor.block) || extractJannyUpdatedAt(after),
            images: extractJannyImages(anchor.block, before),
        };
    });

    const hasMore = /<a\b[^>]*\brel\s*=\s*(["'])[^"']*\bnext\b[^"']*\1[^>]*>/i.test(text)
        || /<a\b[^>]*>[\s\S]*?\bNext\b[\s\S]*?<\/a>/i.test(text);
    return { collections, hasMore };
}

export function parseJannyPublicCollectionDetailPage(html, path = '') {
    const text = String(html || '');
    const validation = path ? validateJannyPublicCollectionPath(path) : { ok: false };
    const pathMatch = validation.ok ? validation.path.match(COLLECTION_PATH_RE) : null;

    // Collection meta lives in the header above the character grid. Character
    // cards carry their own <p> taglines and "by" text, so scope every
    // extraction to the header segment or the first card's tagline becomes the
    // description and the owner regex swallows the rest of the page.
    CHARACTER_LINK_RE.lastIndex = 0;
    const firstCharacter = CHARACTER_LINK_RE.exec(text);
    CHARACTER_LINK_RE.lastIndex = 0;
    const gridHeading = text.match(/<h2\b[^>]*>\s*Characters\s*\(\s*([0-9,]+)\s*\)/i);
    const headerEnd = Math.min(
        firstCharacter ? firstCharacter.index : text.length,
        gridHeading && gridHeading.index >= 0 ? gridHeading.index : text.length,
    );
    const header = text.slice(0, headerEnd);
    const headerText = stripJannyTags(header);

    // The title heading nests the owner credit, e.g.
    // <h1>Name <span><img> <span>by</span> <a>Owner</a></span></h1>
    const headingMatch = header.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i);
    const headingInner = headingMatch ? headingMatch[1] : '';
    const ownerAnchor = headingInner.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i);
    const name = stripJannyCollectionNameSuffix(stripJannyTags(headingInner.replace(/<span\b[\s\S]*<\/span>/i, ' ')))
        || stripJannyCollectionNameSuffix(extractJannyCollectionName(header));

    const countMatch = headerText.match(/([0-9,]+)\s*(?:characters|cards)/i);
    const viewsMatch = headerText.match(/([0-9,.]+[km]?)\s*views/i);

    const collection = {
        id: pathMatch ? pathMatch[1] : '',
        name,
        path: validation.ok ? validation.path : '',
        url: validation.ok ? `${JANNY_BASE}${validation.path}` : '',
        description: extractJannyCardDescription(header),
        characterCount: countMatch
            ? parseInt(countMatch[1].replace(/,/g, ''), 10)
            : (gridHeading ? parseInt(gridHeading[1].replace(/,/g, ''), 10) : null),
        ownerName: ownerAnchor ? stripJannyTags(ownerAnchor[1]) : extractJannyOwnerName(headerText),
        viewCount: viewsMatch ? parseJannyCompactNumber(viewsMatch[1]) : null,
        updatedAt: extractJannyUpdatedAt(header),
        images: extractJannyImages(header),
    };

    const seen = new Set();
    const characterIds = [];
    const characterUrls = [];
    CHARACTER_LINK_RE.lastIndex = 0;
    let match;
    while ((match = CHARACTER_LINK_RE.exec(text))) {
        const charPath = decodeJannyHtml(match[2]);
        const idMatch = charPath.match(CHARACTER_PATH_RE);
        if (!idMatch) continue;
        const id = idMatch[1];
        if (seen.has(id)) continue;
        seen.add(id);
        characterIds.push(id);
        characterUrls.push(`${JANNY_BASE}${charPath}`);
    }

    return { collection, characterIds, characterUrls };
}

// Challenge pages are HTML with distinctive markers. Cloudflare also injects its
// JS-detection script into legitimate 2xx pages, so looser markers only count on errors.
export function detectJannyCloudflareBody(status, body) {
    const lower = String(body || '').toLowerCase();
    if (lower.includes('<title>just a moment') || lower.includes('cf-chl-') || lower.includes('window._cf_chl_opt')) {
        return true;
    }
    if (status >= 400) {
        return lower.includes('just a moment')
            || lower.includes('cf_chl_')
            || lower.includes('challenge-platform');
    }
    return false;
}
