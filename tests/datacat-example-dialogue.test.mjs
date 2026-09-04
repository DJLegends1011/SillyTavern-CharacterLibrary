import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildV2FromDatacat } from '../modules/providers/datacat/datacat-api.js';

// DataCat v0.97 put /api/characters/:id/download behind Cloudflare Turnstile, so
// every import now falls through to buildV2FromDatacat. The detail payload still
// carries the example dialogue in chara_card_v2_json.data.mes_example - these
// guard that the fallback stops discarding it.
// Shapes mirror live rows captured 2026-08-20 (character ec6f418c, "Reina Kuroda").

const janitorRow = (v2 = {}) => ({
    character_id: 'ec6f418c-7a51-4589-ab5b-e737ee84bcdc',
    name: 'Reina Kuroda',
    primary_content_source_kind: 'janitor_core',
    personality: 'Reina body text that becomes the description.',
    first_message: '*Reina has routines.*',
    chara_card_v2_json: { data: { description: 'v2 description', ...v2 } },
});

describe('buildV2FromDatacat example dialogue', () => {
    it('carries mes_example from chara_card_v2_json.data', () => {
        const card = buildV2FromDatacat(janitorRow({ mes_example: '{{user}}: hi\n{{char}}: hello' }));
        assert.equal(card.data.mes_example, '{{user}}: hi\n{{char}}: hello');
    });

    it('carries system_prompt and post_history_instructions when present', () => {
        const card = buildV2FromDatacat(janitorRow({
            system_prompt: 'stay in character',
            post_history_instructions: 'keep it terse',
        }));
        assert.equal(card.data.system_prompt, 'stay in character');
        assert.equal(card.data.post_history_instructions, 'keep it terse');
    });

    it('defaults to empty strings when the payload has none', () => {
        const card = buildV2FromDatacat(janitorRow());
        assert.equal(card.data.mes_example, '');
        assert.equal(card.data.system_prompt, '');
        assert.equal(card.data.post_history_instructions, '');
    });

    it('keeps personality empty so the janitor body stays in description only', () => {
        const card = buildV2FromDatacat(janitorRow({
            mes_example: 'example',
            personality: 'should NOT be copied through',
        }));
        assert.equal(card.data.personality, '');
        assert.equal(card.data.description, 'Reina body text that becomes the description.');
    });
});
