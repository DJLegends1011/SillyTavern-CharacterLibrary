import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const browse = await readFile(
    new URL('../modules/providers/datacat/datacat-browse.js', import.meta.url),
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

test('DataCat exposes one detail-only folder heart', () => {
    assert.match(
        browse,
        /<p class="browse-char-meta">[\s\S]{0,700}id="datacatFolderBtn"[\s\S]{0,250}browse-meta-action[\s\S]{0,250}title="Save to folder"[\s\S]{0,250}fa-regular fa-heart/,
    );
    assert.doesNotMatch(browse, /id="datacatYoursBtn"/);
    assert.doesNotMatch(browse, /class="datacat-yours-btn/);
    assert.doesNotMatch(browse, /data-datacat-probe=/);
    assert.doesNotMatch(browse, /renderDatacatYoursCardButton/);
    assert.doesNotMatch(browse, /observeDatacatYoursProbes/);
});

test('DataCat folder heart opens the existing picker', () => {
    assert.match(browse, /on\('datacatFolderBtn', 'click',[\s\S]{0,900}openDatacatFolderPicker\(\{/);
    assert.match(browse, /anchor: btn/);
    assert.doesNotMatch(browse, /on\('datacatYoursBtn', 'click'/);
});

test('DataCat folder state controls regular and solid hearts', () => {
    assert.match(browse, /function setDatacatFolderActionState\(characterId, saved\)/);
    assert.match(browse, /classList\.toggle\('favorited', saved === true\)/);
    assert.match(browse, /fa-solid fa-heart/);
    assert.match(browse, /fa-regular fa-heart/);
    assert.match(browse, /hasDatacatFolderMembership\(result\)/);
    assert.match(browse, /setAnyFolderSaved: \(id, saved\) => setDatacatFolderActionState\(id, saved\)/);
});

test('DataCat Features follows maintainer Personal and Library grouping', () => {
    assert.match(
        browse,
        /Personal <span[^>]*>\(requires login\)<\/span>:[\s\S]{0,500}id="datacatFilterOnlyYours"[\s\S]{0,180}fa-solid fa-heart[\s\S]{0,120}My Folders[\s\S]{0,500}<div class="dropdown-section-title">Library:<\/div>/,
    );
    assert.doesNotMatch(browse, /id="datacatFilterOnlyYours"[^>]*>[\s\S]{0,220}Only DataCat Yours<\/label>/);
});

test('compact metadata actions have shared desktop and mobile treatment', () => {
    assert.match(css, /\.browse-meta-action\s*\{/);
    assert.match(css, /\.browse-meta-action\.favorited/);
    assert.match(css, /\.browse-meta-action:disabled/);
    assert.match(mobile, /querySelectorAll\('\.browse-meta-action'\)/);
    assert.match(mobile, /metaAction\.title \|\| metaAction\.getAttribute\('aria-label'\)/);
    assert.match(mobile, /metaAction\.click\(\)/);
});