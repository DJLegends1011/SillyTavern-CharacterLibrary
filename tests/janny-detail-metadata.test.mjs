import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../modules/providers/janny/janny-browse.js', import.meta.url), 'utf8');
const detailsSource = source.slice(source.indexOf('async function fetchAndPopulateDetails('), source.indexOf('function cleanupJannyCharModal('));
const id = '50d7e00c-6943-43fd-8ade-e8d008c2a2e3';

function preview(details, { currentToken = 1, initialDate = 'Unknown' } = {}) {
    const hit = { id, name: 'Example', creatorId: 'creator-id' };
    const creator = { textContent: 'Unknown' }, date = { textContent: initialDate }, button = { disabled: true };
    const context = {
        jannySelectedChar: hit, jannyDetailFetchToken: currentToken,
        CoreAPI: { getProvider: () => ({ fetchMetadata: async () => details }) },
        document: { getElementById: key => ({ jannyCharCreator: creator, jannyCharDate: date, jannyImportBtn: button })[key] || null },
        slugify: () => 'example', handleJannyAccountFailure: error => { throw error; },
    };
    runInNewContext(detailsSource, context);
    return { hit, creator, date, button, load: () => context.fetchAndPopulateDetails(hit, 1) };
}

const full = { id, firstMessage: 'Greeting', personality: 'Definition', creatorUsername: 'Kinose', createdAt: '2026-08-28 22:54:36.947+00' };

test('loaded character metadata replaces the creator and unknown date and survives reopening', async () => {
    const ui = preview(full);
    await ui.load();
    assert.equal(ui.creator.textContent, 'Kinose');
    assert.equal(ui.date.textContent, new Date('2026-08-28T22:54:36.947Z').toLocaleDateString());
    assert.equal(Date.parse(ui.hit.createdAt), Date.parse('2026-08-28T22:54:36.947Z'));
    assert.equal(ui.hit.creatorUsername, 'Kinose');
    assert.equal(ui.button.disabled, false);
});

test('a stale character response cannot overwrite the currently open preview', async () => {
    const ui = preview(full, { currentToken: 2 });
    await ui.load();
    assert.equal(ui.creator.textContent, 'Unknown');
    assert.equal(ui.date.textContent, 'Unknown');
    assert.equal(ui.hit._fullData, undefined);
});

test('an invalid detail date does not replace an existing listing date', async () => {
    const ui = preview({ ...full, createdAt: 'invalid' }, { initialDate: 'Known date' });
    await ui.load();
    assert.equal(ui.date.textContent, 'Known date');
});
