import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const librarySource = await readFile(new URL('../app/library.js', import.meta.url), 'utf8');
const wyvernBrowseSource = await readFile(new URL('../modules/providers/wyvern/wyvern-browse.js', import.meta.url), 'utf8');
const bookmarkModuleSource = await readFile(new URL('../modules/providers/bookmark-module.js', import.meta.url), 'utf8');
const datacatBrowseSource = await readFile(new URL('../modules/providers/datacat/datacat-browse.js', import.meta.url), 'utf8');
const chartavernBrowseSource = await readFile(
    new URL('../modules/providers/chartavern/chartavern-browse.js', import.meta.url),
    'utf8',
);
const jannyBrowseSource = await readFile(
    new URL('../modules/providers/janny/janny-browse.js', import.meta.url),
    'utf8',
);
const pygmalionBrowseSource = await readFile(
    new URL('../modules/providers/pygmalion/pygmalion-browse.js', import.meta.url),
    'utf8',
);
const janitoraiBrowseSource = await readFile(
    new URL('../modules/providers/janitorai/janitorai-browse.js', import.meta.url),
    'utf8',
);
const saucepanBrowseSource = await readFile(
    new URL('../modules/providers/saucepan/saucepan-browse.js', import.meta.url),
    'utf8',
);
const mobileSource = await readFile(
    new URL('../app/library-mobile.js', import.meta.url),
    'utf8',
);

// Every provider wired for local backups, and the factory instance each one builds.
const BACKUP_PROVIDERS = [
    [chartavernBrowseSource, 'ctBookmarks'],
    [datacatBrowseSource, 'datacatBookmarks'],
    [jannyBrowseSource, 'jannyBookmarks'],
    [pygmalionBrowseSource, 'pygBookmarks'],
    [wyvernBrowseSource, 'wyvernBookmarks'],
    [janitoraiBrowseSource, 'janitoraiBookmarks'],
    [saucepanBrowseSource, 'saucepanBookmarks'],
];
const sharedCssSource = await readFile(
    new URL('../modules/providers/browse-shared.css', import.meta.url),
    'utf8',
);

test('settings migration keeps the 6.1 gallery ID flow without legacy folder mappings', () => {
    assert.match(librarySource, /\bcountCharactersNeedingGalleryId\b/);
    assert.match(librarySource, /\bassignGalleryIdToCharacter\b/);

    for (const obsoleteName of [
        'countCharactersNeedingFolderRegistration',
        'registerGalleryFolderOverride',
        'removeGalleryFolderOverride',
        'fullGallerySync',
    ]) {
        assert.doesNotMatch(librarySource, new RegExp(`\\b${obsoleteName}\\b`));
    }
});

test('Wyvern browse composes upstream skeleton previews with extended bookmarks', () => {
    assert.match(
        wyvernBrowseSource,
        /import\s*{[^}]*\bskeletonLines\b[^}]*}\s*from\s*'\.\.\/provider-utils\.js';/s,
    );
    assert.match(
        wyvernBrowseSource,
        /import\s*{\s*createBookmarkModule\s*}\s*from\s*'\.\.\/bookmark-module\.js';/,
    );
});

test('Local Backup detail action is compact on every backup-enabled provider', () => {
    for (const [source, factoryName] of BACKUP_PROVIDERS) {
        assert.match(
            source,
            new RegExp(`<p class="browse-char-meta">[\\s\\S]{0,900}\\$\\{${factoryName}\\.renderMetaAction\\(\\)\\}`),
        );
        assert.doesNotMatch(source, new RegExp(`${factoryName}\\.renderModalBtn\\(\\)`));
    }

    assert.match(bookmarkModuleSource, /\bfunction\s+renderMetaAction\b/);
    assert.match(bookmarkModuleSource, /class="browse-meta-action \$\{BOOKMARK_CLASS\}/);
    assert.doesNotMatch(bookmarkModuleSource, /\bfunction\s+renderModalBtn\b/);
    assert.match(sharedCssSource, /\.browse-meta-action\s*{/);
    assert.match(mobileSource, /querySelectorAll\('\.browse-meta-action'\)/);
});

test('Local Backup filters live under Library with no Bookmarks section', () => {
    for (const [source, factoryName] of BACKUP_PROVIDERS) {
        assert.match(
            source,
            new RegExp(`<div class="dropdown-section-title">Library:<\\/div>[\\s\\S]{0,900}\\$\\{${factoryName}\\.renderFilterCheckbox\\(\\)\\}`),
        );
        assert.doesNotMatch(source, /<div class="dropdown-section-title">Bookmarks:<\/div>/);
    }

    assert.match(bookmarkModuleSource, /filterLabel\s*=\s*'Local Backups'/);
});

test('Local Backup grid treatment and persistence stay unchanged', () => {
    assert.match(bookmarkModuleSource, /\bfunction\s+renderCardBtn\b/);
    assert.match(bookmarkModuleSource, /browse-card-stat \$\{BOOKMARK_CLASS\}/);
    assert.match(bookmarkModuleSource, /\bfunction\s+persist\b/);
    assert.match(bookmarkModuleSource, /\bfunction\s+renderBookmarksView\b/);
    assert.match(bookmarkModuleSource, /iconClass\s*=\s*'fa-floppy-disk'/);
});

test('mobile generic metadata-action mirror excludes hidden actions', () => {
    assert.match(mobileSource, /metaAction\.hidden/);
    assert.match(mobileSource, /metaAction\.style\.display\s*===\s*'none'/);
    assert.match(mobileSource, /getComputedStyle\(metaAction\)\.display\s*===\s*'none'/);
});
test('Wyvern backup snapshots keep an avatar source for the grid', () => {
    assert.match(wyvernBrowseSource, /avatar_url:\s*hit\.avatar_url\s*\|\|\s*hit\.avatarUrl\s*\|\|\s*hit\.avatar\s*\|\|\s*''/);
});

test('v7.0.0 providers (JanitorAI, Saucepan) are wired for local backups', () => {
    const wired = [
        [janitoraiBrowseSource, 'janitoraiBookmarks', 'janitorai'],
        [saucepanBrowseSource, 'saucepanBookmarks', 'saucepan'],
    ];

    for (const [source, factoryName, prefix] of wired) {
        assert.match(source, /import\s*{\s*createBookmarkModule\s*}\s*from\s*'\.\.\/bookmark-module\.js';/);
        assert.match(source, new RegExp(`const ${factoryName} = createBookmarkModule\\(`));
        assert.match(source, new RegExp(`settingsKey: '${factoryName}'`));
        // Grid button, click routing, modal state and the filter count all have to be present,
        // or the control renders but does nothing.
        assert.match(source, new RegExp(`\\$\\{${factoryName}\\.renderCardBtn\\(hit\\)\\}`));
        assert.match(source, new RegExp(`${factoryName}\\.handleGridClick\\(e,`));
        assert.match(source, new RegExp(`${factoryName}\\.syncModalState\\(hit\\)`));
        assert.match(source, new RegExp(`${factoryName}\\.attachFilterCheckbox\\(\\)`));
        assert.match(source, new RegExp(`${factoryName}\\.attachModalBtn\\(\\)`));
        assert.match(source, new RegExp(`${factoryName}\\.filterMyBookmarks`));
        // The backup control must not reuse the card's own id attribute, or the grid-wide
        // card lookup can resolve to the button instead of the card.
        assert.doesNotMatch(source, new RegExp(`dataAttrKey: '${prefix}Id'`));
    }
});

test('backup export/import covers every provider that stores bookmarks', () => {
    for (const key of ['janitoraiBookmarks', 'saucepanBookmarks']) {
        assert.match(librarySource, new RegExp(`BOOKMARK_KEYS = \\[[^\\]]*'${key}'`));
        assert.match(librarySource, new RegExp(`${key}: 'character_id'`));
    }
});

test('bookmark snapshots expose a documented provider-sync update hook', () => {
    assert.match(bookmarkModuleSource, /Provider account sync can learn state after a local backup was saved/);
    assert.match(bookmarkModuleSource, /\bfunction\s+updateSnapshot\b/);
    assert.match(bookmarkModuleSource, /\bupdateSnapshot,/);
});
