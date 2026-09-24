import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= {};
const { splitAssembledPrompt } = await import('../extras/cl-helper/index.js');
// Loaded first, as in janitorai-favorites.test.mjs: entering the provider graph at the api module
// trips a circular import (CL_HELPER_PLUGIN_BASE used before initialization).
await import('../modules/providers/janitor-session.js');
const { buildV2FromJanitorai } = await import('../modules/providers/janitorai/janitorai-api.js');

// Shape of a real proxy capture's system message (hidden definition, scenario, private lorebook).
const ASSEMBLED = [
    '',
    "<Helen's Persona>>**Bio:**",
    '- Name: Elastigirl</Helen\'s Persona>',
    '<Scenario>>**Premise:**',
    '- A stakeout.</Scenario>',
    'The Golden Age of Supers erupted in the late 1930s.',
    '',
    'Metroville is a city located in California.',
].join('\n');

test('splits the definition and scenario out of the assembled prompt, keeping lorebook text out of both', () => {
    const parts = splitAssembledPrompt(ASSEMBLED);
    assert.equal(parts.definition, '>**Bio:**\n- Name: Elastigirl');
    assert.equal(parts.scenario, '>**Premise:**\n- A stakeout.');
    assert.equal(parts.exampleDialogs, '');
    assert.equal(parts.injectedLore, 'The Golden Age of Supers erupted in the late 1930s.\n\nMetroville is a city located in California.');
});

test('a card with no scenario or lorebook yields only the unwrapped definition', () => {
    const parts = splitAssembledPrompt("\n<Faith & Hope's Persona>[\nname: Faith\n]</Faith & Hope's Persona>\n");
    assert.deepEqual(parts, { definition: '[\nname: Faith\n]', scenario: '', exampleDialogs: '', injectedLore: '' });
});

test('example dialogs and the throwaway user persona are taken out of the remainder', () => {
    const parts = splitAssembledPrompt(
        "<Bob's Persona>def</Bob's Persona>\n<UserPersona>ABC123</UserPersona>\n"
        + '<example_dialogs>{{user}}: hi\n{{char}}: hello</example_dialogs>\nlore entry',
    );
    assert.equal(parts.definition, 'def');
    assert.equal(parts.exampleDialogs, '{{user}}: hi\n{{char}}: hello');
    assert.equal(parts.injectedLore, 'lore entry');
});

test('the user persona is never mistaken for the character wrapper', () => {
    const parts = splitAssembledPrompt("<UserPersona>me</UserPersona>\n<Bob's Persona>def</Bob's Persona>");
    assert.equal(parts.definition, 'def');
    assert.equal(parts.injectedLore, '');
});

test('an unrecognised prompt shape keeps the whole message as the definition', () => {
    const parts = splitAssembledPrompt('\nplain definition with no wrapper\n');
    assert.deepEqual(parts, { definition: 'plain definition with no wrapper', scenario: '', exampleDialogs: '', injectedLore: '' });
});

test('the card builder files each split section in its own field', () => {
    const detail = {
        id: 'x', chat_name: 'Helen', personality: null, scenario: null, example_dialogs: null,
        first_message: null, showdefinition: false, scripts: [{ type: 'lorebook', title: 'Supers', is_public: false }],
    };
    const card = buildV2FromJanitorai(detail, {
        definition: 'def', firstMessage: 'hi there', scenario: 'scen', exampleDialogs: 'ex',
    });
    assert.equal(card.data.description, 'def');
    assert.equal(card.data.scenario, 'scen');
    assert.equal(card.data.mes_example, 'ex');
    assert.equal(card.data.first_mes, 'hi there');
    // A private lorebook has no content to hydrate, and the inlined text is not turned into one.
    assert.equal(card.data.character_book, undefined);
});
