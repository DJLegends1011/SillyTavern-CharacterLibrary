import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.window ??= {};
await import('../modules/providers/janitor-session.js');
const {
    JANITORAI_CHARACTER_ID_RE,
    parseJanitoraiCharacterUrl,
    janitoraiCharacterUrl,
} = await import('../modules/providers/janitorai/janitorai-api.js');

const ID = 'ae5ce716-6a45-45b6-acb7-59c95ebca9f6';

test('parses a site character link, slug and all', () => {
    assert.equal(
        parseJanitoraiCharacterUrl(`https://janitorai.com/characters/${ID}_character-riven-pizza-delivery-woman`),
        ID,
    );
});

test('accepts the shapes a pasted link actually arrives in', () => {
    for (const url of [
        `https://janitorai.com/characters/${ID}`,
        `https://www.janitorai.com/characters/${ID}_slug`,
        `http://janitorai.com/characters/${ID}_slug`,
        `janitorai.com/characters/${ID}_slug`,
        `https://janitorai.com/character/${ID}`,
        `https://janitorai.com/characters/${ID}?ref=share`,
    ]) {
        assert.equal(parseJanitoraiCharacterUrl(url), ID, url);
    }
});

test('round-trips the URL builder', () => {
    assert.equal(parseJanitoraiCharacterUrl(janitoraiCharacterUrl(ID, 'Riven, pizza delivery')), ID);
});

test('rejects other hosts, non-character paths and junk', () => {
    for (const url of [
        `https://jannyai.com/characters/${ID}`,
        `https://datacat.run/characters/${ID}`,
        `https://janitorai.com/profiles/${ID}_someone`,
        'https://janitorai.com/',
        'pizza delivery woman',
        '',
        null,
        undefined,
    ]) {
        assert.equal(parseJanitoraiCharacterUrl(url), null, String(url));
    }
});

test('matches a bare id with or without its slug, and nothing else', () => {
    assert.equal(ID.match(JANITORAI_CHARACTER_ID_RE)?.[1], ID);
    assert.equal(`${ID}_character-riven`.match(JANITORAI_CHARACTER_ID_RE)?.[1], ID);
    assert.equal(ID.toUpperCase().match(JANITORAI_CHARACTER_ID_RE)?.[1], ID.toUpperCase());
    for (const text of ['riven', 'ae5ce716', `x${ID}`, `${ID}extra`]) {
        assert.equal(text.match(JANITORAI_CHARACTER_ID_RE), null, text);
    }
});

test('the card search routes a parsed link to the lookup before the text path', async () => {
    const source = await readFile(new URL('../modules/providers/janitorai/janitorai-browse.js', import.meta.url), 'utf8');
    const doSearch = source.slice(source.indexOf('function doSearch()'));
    const linkBranch = doSearch.indexOf('fetchCharacterAndOpenPreview(linkedId)');
    const textPath = doSearch.indexOf('jaCurrentSearch = val;');
    assert.ok(linkBranch > 0, 'doSearch has no link branch');
    assert.ok(textPath > linkBranch, 'the text path must come after the link branch');
});

test('the search box advertises that it takes a URL, inline and on mobile', async () => {
    const source = await readFile(new URL('../modules/providers/janitorai/janitorai-browse.js', import.meta.url), 'utf8');
    assert.match(source, /id="janitoraiSearchInput" placeholder="Search JanitorAI or paste a character URL\.\.\."/);
    assert.match(source, /getSearchPlaceholder\(mode\) \{[\s\S]*?'Search JanitorAI or paste a URL\.\.\.'/);
});

test('a looked-up card hands its detail to the modal instead of refetching it', async () => {
    const source = await readFile(new URL('../modules/providers/janitorai/janitorai-browse.js', import.meta.url), 'utf8');
    assert.match(source, /openPreviewModal\(hitFromDetail\(detail, charId\), detail\)/);
    assert.match(source, /detail = preloadedDetail \|\| await fetchJanitoraiCharacter\(charId\)/);
});
