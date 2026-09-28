// Harpy character-page parsing: no DOM, no network, so it runs under `node --test` too.
//
// harpy.chat hides definitions from its Supabase views, but the public character page
// server-renders the card for anyone: description, scenario, every greeting, example
// dialogue and lorebook ride the Next.js RSC flight payload. A locked card ships the
// same object with description/scenario nulled, which is how isLocked shows up here.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Pull the flight payload out of whatever the fetch returned: a bare `RSC: 1`
 * response is the payload itself; a full HTML page carries it as
 * `self.__next_f.push([1,"..."])` string chunks.
 * @param {string} body
 * @returns {string}
 */
export function extractFlight(body) {
    if (typeof body !== 'string' || !body) return '';
    if (!body.includes('self.__next_f.push')) return body;
    let flight = '';
    for (const m of body.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
        try { flight += JSON.parse(m[1]); } catch { /* one bad chunk must not drop the rest */ }
    }
    return flight;
}

/**
 * Split a flight payload into rows. JSON rows are `<hexId>:<json>\n`; text rows are
 * `<hexId>:T<hexByteLen>,<text>` with NO terminator, the length counted in UTF-8 bytes,
 * so this walks bytes, not characters.
 * @param {string} flight
 * @returns {{ json: Map<string, any>, text: Map<string, string> }}
 */
export function parseFlightRows(flight) {
    const bytes = textEncoder.encode(flight || '');
    const json = new Map();
    const text = new Map();
    const COLON = 58, NEWLINE = 10, COMMA = 44, T = 84;
    let i = 0;
    while (i < bytes.length) {
        let j = i;
        while (j < bytes.length && bytes[j] !== COLON && bytes[j] !== NEWLINE) j++;
        if (j >= bytes.length) break;
        if (bytes[j] === NEWLINE) { i = j + 1; continue; }
        const id = textDecoder.decode(bytes.subarray(i, j));
        const start = j + 1;
        if (bytes[start] === T) {
            let k = start + 1;
            while (k < bytes.length && bytes[k] !== COMMA) k++;
            const len = parseInt(textDecoder.decode(bytes.subarray(start + 1, k)), 16);
            if (!Number.isFinite(len)) { i = k + 1; continue; }
            text.set(id, textDecoder.decode(bytes.subarray(k + 1, k + 1 + len)));
            i = k + 1 + len;
            continue;
        }
        let end = start;
        while (end < bytes.length && bytes[end] !== NEWLINE) end++;
        const raw = textDecoder.decode(bytes.subarray(start, end));
        // Only plain JSON rows matter; module (I), hint (HL) and error (E) rows are skipped.
        if (/^[[{"]/.test(raw)) {
            try { json.set(id, JSON.parse(raw)); } catch { /* not a JSON row */ }
        }
        i = end + 1;
    }
    return { json, text };
}

function findCardObject(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 60) return null;
    if (!Array.isArray(value) && Array.isArray(value.firstMessages) && 'scenario' in value && 'description' in value) {
        return value;
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
        const hit = findCardObject(child, depth + 1);
        if (hit) return hit;
    }
    return null;
}

function resolveRef(value, rows) {
    if (typeof value !== 'string') return value;
    const m = /^\$([0-9a-f]+)$/.exec(value);
    if (!m) return value === '$undefined' ? undefined : value;
    if (rows.text.has(m[1])) return rows.text.get(m[1]);
    if (rows.json.has(m[1])) return rows.json.get(m[1]);
    return undefined;
}

/**
 * Locate the character object in a Harpy page and resolve its field references.
 * @param {string} body - RSC payload or full HTML
 * @returns {null | {
 *   id?: string, name?: string, title?: string, ownerId?: string, isLocked: boolean,
 *   description: string|null, scenario: string|null, exampleDialogue: any,
 *   firstMessages: any[], lorebook: any, linkedLorebookIds: string[], raw: object }}
 */
export function parseHarpyCharacterPage(body) {
    const rows = parseFlightRows(extractFlight(body));
    let card = null;
    for (const value of rows.json.values()) {
        card = findCardObject(value);
        if (card) break;
    }
    if (!card) return null;
    const description = resolveRef(card.description, rows);
    const scenario = resolveRef(card.scenario, rows);
    return {
        id: card.id,
        name: card.name,
        title: card.title,
        ownerId: card.ownerId,
        // Locked cards arrive with the definition nulled rather than omitted
        isLocked: card.isLocked === true || (description == null && scenario == null),
        description: typeof description === 'string' ? description : null,
        scenario: typeof scenario === 'string' ? scenario : null,
        exampleDialogue: resolveRef(card.exampleDialogue, rows) ?? null,
        firstMessages: (card.firstMessages || []).map(d => resolveRef(d, rows)).filter(Boolean),
        lorebook: resolveRef(card.lorebook, rows) ?? null,
        linkedLorebookIds: Array.isArray(card.linkedLorebookIds) ? card.linkedLorebookIds : [],
        raw: card,
    };
}

// ========================================
// PROSEMIRROR (TipTap) DOCUMENTS
// ========================================

const BLOCK_JOIN = '\n\n';

/**
 * Rich-text doc to ST-style markdown text: italics become *x*, bold **x**, images
 * ![](src). Colours and alignment are dropped; greetings are chat text, not a page.
 * @param {any} doc - ProseMirror JSON, a plain string, or null
 * @returns {string}
 */
export function docToMarkdown(doc) {
    if (doc == null) return '';
    if (typeof doc === 'string') return doc;

    const inline = (nodes = []) => nodes.map((n) => {
        if (n.type === 'hardBreak') return '\n';
        if (n.type === 'image') return n.attrs?.src ? `![${n.attrs.alt || ''}](${n.attrs.src})` : '';
        if (n.type !== 'text') return inline(n.content);
        let t = n.text || '';
        const marks = (n.marks || []).map(m => m.type);
        if (!t.trim()) return t;
        // Keep surrounding whitespace outside the markers or *x * never renders
        const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(t);
        let out = core;
        if (marks.includes('code')) out = `\`${out}\``;
        if (marks.includes('italic')) out = `*${out}*`;
        if (marks.includes('bold')) out = `**${out}**`;
        if (marks.includes('strike')) out = `~~${out}~~`;
        const link = (n.marks || []).find(m => m.type === 'link')?.attrs?.href;
        if (link) out = `[${out}](${link})`;
        return lead + out + trail;
    }).join('');

    const block = (node, listPrefix = '') => {
        switch (node.type) {
            case 'doc': return (node.content || []).map(c => block(c)).filter(s => s !== '').join(BLOCK_JOIN);
            case 'paragraph': return inline(node.content);
            case 'heading': return `${'#'.repeat(Math.min(6, node.attrs?.level || 2))} ${inline(node.content)}`;
            case 'blockquote': return (node.content || []).map(c => block(c)).join(BLOCK_JOIN).split('\n').map(l => `> ${l}`).join('\n');
            case 'horizontalRule': return '---';
            case 'codeBlock': return `\`\`\`\n${inline(node.content)}\n\`\`\``;
            case 'image': return node.attrs?.src ? `![${node.attrs.alt || ''}](${node.attrs.src})` : '';
            case 'bulletList':
            case 'orderedList': return (node.content || []).map((li, idx) => {
                const marker = node.type === 'orderedList' ? `${(node.attrs?.start || 1) + idx}. ` : '- ';
                return (li.content || []).map(c => block(c)).join('\n').split('\n')
                    .map((l, k) => (k === 0 ? listPrefix + marker : listPrefix + '   ') + l).join('\n');
            }).join('\n');
            default: return node.content ? (node.content || []).map(c => block(c)).join(BLOCK_JOIN) : inline([node]);
        }
    };

    return block(doc.type === 'doc' ? doc : { type: 'doc', content: [doc] })
        .replace(/\n{3,}/g, '\n\n').trim();
}

const escapeHtml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Style values are attacker-controlled creator input; only let plain colours and sizes through.
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.\s,%]+\)|hsla?\(\s*[\d.\s,%deg]+\)|[a-z]{3,20})$/i;
const SAFE_SIZE = /^\d{1,3}(\.\d+)?(px|em|rem|%)$/i;
const SAFE_ALIGN = /^(left|right|center|justify)$/;

function markStyle(attrs = {}) {
    const css = [];
    if (attrs.color && SAFE_COLOR.test(attrs.color)) css.push(`color: ${attrs.color}`);
    if (attrs.backgroundColor && SAFE_COLOR.test(attrs.backgroundColor)) css.push(`background-color: ${attrs.backgroundColor}`);
    if (attrs.fontSize && SAFE_SIZE.test(attrs.fontSize)) css.push(`font-size: ${attrs.fontSize}`);
    return css.join('; ');
}

const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u : '';

/**
 * Rich-text doc to HTML for creator notes, keeping the showcase look: images, colours,
 * alignment, rules. Output still goes through CL's secure creator-notes renderer.
 * @param {any} doc
 * @returns {string}
 */
export function docToHtml(doc) {
    if (doc == null) return '';
    if (typeof doc === 'string') return escapeHtml(doc).replace(/\n/g, '<br>');

    const inline = (nodes = []) => nodes.map((n) => {
        if (n.type === 'hardBreak') return '<br>';
        if (n.type === 'image') {
            const src = safeUrl(n.attrs?.src);
            return src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(n.attrs?.alt || '')}">` : '';
        }
        if (n.type !== 'text') return inline(n.content);
        let out = escapeHtml(n.text || '');
        for (const m of n.marks || []) {
            if (m.type === 'bold') out = `<strong>${out}</strong>`;
            else if (m.type === 'italic') out = `<em>${out}</em>`;
            else if (m.type === 'underline') out = `<u>${out}</u>`;
            else if (m.type === 'strike') out = `<s>${out}</s>`;
            else if (m.type === 'code') out = `<code>${out}</code>`;
            else if (m.type === 'link' && safeUrl(m.attrs?.href)) out = `<a href="${escapeHtml(m.attrs.href)}" target="_blank" rel="noopener noreferrer">${out}</a>`;
            else if (m.type === 'textStyle' || m.type === 'highlight') {
                const style = markStyle(m.type === 'highlight' ? { backgroundColor: m.attrs?.color } : m.attrs);
                if (style) out = `<span style="${escapeHtml(style)}">${out}</span>`;
            }
        }
        return out;
    }).join('');

    const alignAttr = (node) => {
        const a = node.attrs?.textAlign;
        return a && SAFE_ALIGN.test(a) ? ` style="text-align: ${a}"` : '';
    };

    const block = (node) => {
        switch (node.type) {
            case 'doc': return (node.content || []).map(block).join('');
            case 'paragraph': return `<p${alignAttr(node)}>${inline(node.content) || '<br>'}</p>`;
            case 'heading': {
                const lvl = Math.min(6, Math.max(1, node.attrs?.level || 2));
                return `<h${lvl}${alignAttr(node)}>${inline(node.content)}</h${lvl}>`;
            }
            case 'blockquote': return `<blockquote>${(node.content || []).map(block).join('')}</blockquote>`;
            case 'horizontalRule': return '<hr>';
            case 'codeBlock': return `<pre><code>${inline(node.content)}</code></pre>`;
            case 'image': {
                const src = safeUrl(node.attrs?.src);
                return src ? `<p><img src="${escapeHtml(src)}" alt="${escapeHtml(node.attrs?.alt || '')}"></p>` : '';
            }
            case 'bulletList': return `<ul>${(node.content || []).map(block).join('')}</ul>`;
            case 'orderedList': return `<ol>${(node.content || []).map(block).join('')}</ol>`;
            case 'listItem': return `<li>${(node.content || []).map(block).join('')}</li>`;
            default: return node.content ? (node.content || []).map(block).join('') : inline([node]);
        }
    };

    return block(doc.type === 'doc' ? doc : { type: 'doc', content: [doc] });
}

// ========================================
// MACROS
// ========================================

// ST resolves {{user}}/{{char}} case-sensitively; Harpy creators also write {{User}}.
const ST_MACRO = /\{\{\s*(user|char)\s*\}\}/gi;
// Harpy's pronoun macros have no ST equivalent, so they stay literal and get reported.
const HARPY_PRONOUN_MACRO = /\{\{\s*(sub|obj|poss|poss_p|refl|ref)\s*\}\}/gi;

/** @param {string} text */
export function normalizeMacros(text) {
    if (typeof text !== 'string' || !text) return text || '';
    return text.replace(ST_MACRO, (_, which) => `{{${which.toLowerCase()}}}`);
}

/**
 * @param {string[]} texts
 * @returns {string[]} distinct Harpy-only macros, as written (e.g. "{{poss}}")
 */
export function findHarpyOnlyMacros(texts) {
    const found = new Set();
    for (const t of texts) {
        if (typeof t !== 'string') continue;
        for (const m of t.matchAll(HARPY_PRONOUN_MACRO)) found.add(`{{${m[1].toLowerCase()}}}`);
    }
    return [...found].sort();
}
