import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const browse = await readFile(
    new URL('../modules/providers/janny/janny-browse.js', import.meta.url),
    'utf8',
);
const css = await readFile(
    new URL('../modules/providers/browse-shared.css', import.meta.url),
    'utf8',
);
const mobile = await readFile(
    new URL('../app/library-mobile.js', import.meta.url),
    'utf8',
);

test('Janny account bookmark is a compact metadata action', () => {
    assert.match(
        browse,
        /<p class="browse-char-meta">[\s\S]{0,700}id="jannyBookmarkBtn"[\s\S]{0,250}browse-meta-action[\s\S]{0,250}fa-regular fa-bookmark/,
    );
    assert.doesNotMatch(
        browse,
        /<div class="modal-controls">[\s\S]{0,700}id="jannyBookmarkBtn"/,
    );
    assert.doesNotMatch(browse, /id="jannyBookmarkBtn" class="action-btn/);
});

test('Janny bookmark state remains icon-only and accessible', () => {
    assert.match(browse, /classList\.toggle\('favorited', isBookmarked\)/);
    assert.match(browse, /fa-solid fa-bookmark/);
    assert.match(browse, /fa-regular fa-bookmark/);
    assert.match(browse, /setAttribute\('aria-label', title\)/);
    assert.doesNotMatch(browse, /fa-solid fa-bookmark"><\/i> Bookmarked/);
    assert.doesNotMatch(browse, /fa-regular fa-bookmark"><\/i> Bookmark/);
});

test('Janny compact bookmark is available through mobile overflow', () => {
    assert.match(css, /\.browse-meta-action\s*{/);
    assert.match(mobile, /querySelectorAll\('\.browse-meta-action'\)/);
    assert.match(mobile, /metaAction\.click\(\)/);
});

test('mobile overflow excludes hidden metadata actions', () => {
    assert.match(mobile, /metaAction\.hidden\s*\|\|\s*metaAction\.style\.display\s*===\s*'none'/);
    assert.match(mobile, /getComputedStyle\(metaAction\)\.display\s*===\s*'none'/);
});

test('Janny account filter follows maintainer Personal and Library grouping', () => {
    assert.match(
        browse,
        /Personal <span[^>]*>\(requires login\)<\/span>:[\s\S]{0,500}id="jannyFilterOnlyBookmarked"[\s\S]{0,180}fa-solid fa-bookmark[\s\S]{0,120}My Bookmarks[\s\S]{0,500}<div class="dropdown-section-title">Library:<\/div>/,
    );
    assert.doesNotMatch(browse, /id="jannyFilterOnlyBookmarked"[^>]*>[\s\S]{0,220}Only Bookmarked<\/label>/);
    assert.doesNotMatch(browse, /<div class="dropdown-section-title">Account:<\/div>/);
});
