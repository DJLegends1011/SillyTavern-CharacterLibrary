import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

import { resolveDatacatAvatarUrl } from '../modules/providers/datacat/datacat-api.js';

describe('resolveDatacatAvatarUrl', () => {
    before(() => {
        // CoreAPI delegates the SSRF check to the app; allow everything here.
        window.isUrlSafeForDownload = () => ({ ok: true });
    });

    it('resolves DataCat direct-upload paths against datacat.run', () => {
        const avatar = '/api/media/direct_upload/5af63fd2-7e12-4685-8aef-d9c3b204783d/view?token=abc.def';
        assert.equal(
            resolveDatacatAvatarUrl({ avatar }),
            `https://datacat.run${avatar}`,
        );
    });

    it('does not add the janitorai thumbnail width to DataCat-hosted paths', () => {
        const url = resolveDatacatAvatarUrl({ avatar: '/api/media/direct_upload/x/view?token=t' }, { width: 400 });
        assert.equal(url, 'https://datacat.run/api/media/direct_upload/x/view?token=t');
    });

    it('still maps bare JanitorAI filenames to ella.janitorai.com', () => {
        assert.equal(
            resolveDatacatAvatarUrl({ avatar: 'abc123.webp' }),
            'https://ella.janitorai.com/bot-avatars/abc123.webp',
        );
    });

    it('passes absolute URLs through unchanged', () => {
        const avatar = 'https://media.datacat.run/prod-media/variants/source-avatar/v2/aa/id/hash/card.webp';
        assert.equal(resolveDatacatAvatarUrl({ avatar }), avatar);
    });

    it('treats a protocol-relative value as a filename, never as another host', () => {
        const url = resolveDatacatAvatarUrl({ avatar: '//evil.example/x.png' });
        assert.ok(!url.startsWith('https://evil.example'), url);
    });

    it('returns null when there is no avatar', () => {
        assert.equal(resolveDatacatAvatarUrl({ avatar: null }), null);
    });
});
