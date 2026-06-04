import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const librarySource = await readFile(new URL('../app/library.js', import.meta.url), 'utf8');
const wyvernBrowseSource = await readFile(new URL('../modules/providers/wyvern/wyvern-browse.js', import.meta.url), 'utf8');
const bookmarkModuleSource = await readFile(new URL('../modules/providers/bookmark-module.js', import.meta.url), 'utf8');
const datacatBrowseSource = await readFile(new URL('../modules/providers/datacat/datacat-browse.js', import.meta.url), 'utf8');

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

test('DataCat local bookmarks can render as provider-backup controls', () => {
    assert.match(bookmarkModuleSource, /iconClass\s*=\s*'fa-bookmark'/);
    assert.match(bookmarkModuleSource, /\bfunction\s+renderIcon\b/);
    assert.match(datacatBrowseSource, /iconClass:\s*'fa-floppy-disk'/);
    assert.match(datacatBrowseSource, /filterLabel:\s*'Local Backups'/);
    assert.match(datacatBrowseSource, /modalLabel:\s*'Local Backup'/);
});
