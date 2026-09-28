// node --test tests/harpy-page.test.mjs
// harpy-page.js is DOM-free, so no browser-globals shim is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    extractFlight,
    parseFlightRows,
    parseHarpyCharacterPage,
    docToMarkdown,
    docToHtml,
    normalizeMacros,
    findHarpyOnlyMacros,
} from '../modules/providers/harpy/harpy-page.js';

const utf8Len = (s) => new TextEncoder().encode(s).length;
const textRow = (id, s) => `${id}:T${utf8Len(s).toString(16)},${s}`;

const greeting = {
    type: 'doc',
    content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'She waves. ', marks: [{ type: 'italic' }] }, { type: 'text', text: '"Hi {{User}}!"' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Loud', marks: [{ type: 'bold' }] }] },
    ],
};

// Mirrors the live layout: text rows carry no terminator and sit flush against the next row.
function unlockedFlight() {
    const description = 'Café owner — “quoted” ✨\n> ## Setting:\n{{user}} visits; {{poss}} cup.';
    const card = {
        id: '11111111-2222-3333-4444-555555555555',
        name: 'Mira',
        title: 'Mira | The Café',
        ownerId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        isLocked: false,
        summary: { type: 'doc', content: [] },
        linkedLorebookIds: [],
        description: '$1f',
        lorebook: null,
        scenario: 'A rainy {{User}} evening.',
        firstMessages: [greeting, greeting],
        exampleDialogue: '',
    };
    return [
        '0:["$","div",null,{}]\n',
        '3:I[69473,["x.js"],"default"]\n',
        textRow('1f', description),
        `20:["$","main",null,{"children":[{"character":${JSON.stringify(card)}}]}]\n`,
    ].join('');
}

test('parseFlightRows reads text rows by UTF-8 byte length, flush against the next row', () => {
    const rows = parseFlightRows(unlockedFlight());
    assert.equal(rows.text.get('1f'), 'Café owner — “quoted” ✨\n> ## Setting:\n{{user}} visits; {{poss}} cup.');
    assert.ok(rows.json.has('20'), 'the JSON row after a text row must still parse');
    assert.ok(!rows.json.has('3'), 'module rows are skipped');
});

test('parseHarpyCharacterPage resolves $ refs and keeps every greeting', () => {
    const page = parseHarpyCharacterPage(unlockedFlight());
    assert.equal(page.name, 'Mira');
    assert.equal(page.isLocked, false);
    assert.match(page.description, /^Café owner/);
    assert.equal(page.scenario, 'A rainy {{User}} evening.');
    assert.equal(page.firstMessages.length, 2);
});

test('the same payload wrapped in HTML push chunks parses identically', () => {
    const flight = unlockedFlight();
    const half = Math.floor(flight.length / 2);
    const html = `<html><script>self.__next_f.push([1,${JSON.stringify(flight.slice(0, half))}])</script>`
        + `<script>self.__next_f.push([1,${JSON.stringify(flight.slice(half))}])</script></html>`;
    assert.equal(extractFlight(html), flight);
    assert.deepEqual(parseHarpyCharacterPage(html).description, parseHarpyCharacterPage(flight).description);
});

test('a locked card (definition nulled) reports isLocked but keeps its greetings', () => {
    const card = { id: 'x', name: 'Locked', isLocked: true, description: null, scenario: null, lorebook: null, firstMessages: [greeting], linkedLorebookIds: ['a', 'b'] };
    const page = parseHarpyCharacterPage(`5:${JSON.stringify({ card })}\n`);
    assert.equal(page.isLocked, true);
    assert.equal(page.description, null);
    assert.equal(page.firstMessages.length, 1);
    assert.equal(page.linkedLorebookIds.length, 2);
});

test('pages without a character object return null', () => {
    assert.equal(parseHarpyCharacterPage('0:["$","div",null,{}]\n'), null);
    assert.equal(parseHarpyCharacterPage(''), null);
});

test('docToMarkdown keeps whitespace outside emphasis markers', () => {
    assert.equal(docToMarkdown(greeting), '*She waves.* "Hi {{User}}!"\n\n**Loud**');
    assert.equal(docToMarkdown('plain'), 'plain');
    assert.equal(docToMarkdown(null), '');
});

test('docToHtml escapes text and drops unsafe styles and links', () => {
    const doc = {
        type: 'doc',
        content: [
            { type: 'paragraph', attrs: { textAlign: 'center' }, content: [
                { type: 'text', text: '<b>x</b>', marks: [{ type: 'textStyle', attrs: { color: 'rgb(255, 38, 38)' } }] },
                { type: 'text', text: 'y', marks: [{ type: 'textStyle', attrs: { color: 'red;background:url(x)' } }] },
                { type: 'text', text: 'z', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
            ] },
            { type: 'image', attrs: { src: 'https://example.com/a.webp' } },
            { type: 'horizontalRule' },
        ],
    };
    // "y" loses its injected style and "z" its javascript: link; both keep their text
    assert.equal(docToHtml(doc),
        '<p style="text-align: center"><span style="color: rgb(255, 38, 38)">&lt;b&gt;x&lt;/b&gt;</span>yz</p>'
        + '<p><img src="https://example.com/a.webp" alt=""></p><hr>');
});

test('macros: {{User}} normalizes, Harpy pronoun macros are reported not rewritten', () => {
    assert.equal(normalizeMacros('Hi {{User}} and {{ Char }}'), 'Hi {{user}} and {{char}}');
    assert.equal(normalizeMacros('{{poss}} cup'), '{{poss}} cup');
    assert.deepEqual(findHarpyOnlyMacros(['{{poss}} {{sub}}', '{{Poss_P}}', null]), ['{{poss_p}}', '{{poss}}', '{{sub}}']);
});
