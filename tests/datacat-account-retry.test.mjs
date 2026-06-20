import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

import {
    setApiRequest,
    setSavedAccountTokenGetter,
    setSavedDeviceTokenGetter,
    setDatacatClientIdGetter,
    setDatacatYoursSaved,
    setDatacatFollow,
    fetchDatacatFollowing,
} from '../modules/providers/datacat/datacat-api.js';

// Minimal Response-like stub matching what dcHelperJson consumes:
// `.ok`, `.status`, and `.clone().text()`.
function makeResp(status, bodyObj) {
    const text = bodyObj == null ? '' : JSON.stringify(bodyObj);
    return {
        ok: status >= 200 && status < 300,
        status,
        clone() { return { text: async () => text }; },
        async text() { return text; },
        async json() { return bodyObj; },
    };
}

// Installs a fake apiRequest that records calls and lets each test script the
// responses per path. Returns the recorded calls array.
function installApiRequest(handler) {
    const calls = [];
    setApiRequest(async (path, method = 'GET') => {
        calls.push({ path, method });
        return handler(path, method, calls);
    });
    return calls;
}

describe('DataCat account-scoped lazy session recovery', () => {
    beforeEach(() => {
        setSavedDeviceTokenGetter(() => null);
        setDatacatClientIdGetter(() => 'client-1');
    });

    it('restores the account session once and retries after a 401, then succeeds', async () => {
        setSavedAccountTokenGetter(() => 'acct-token');
        let restored = false;
        const calls = installApiRequest((path) => {
            if (path.includes('/dc-auth-set')) {
                restored = true;
                return makeResp(200, { ok: true, valid: true, user: { uuid: 'u1' } });
            }
            if (path.includes('/dc-yours/')) {
                return restored
                    ? makeResp(200, { ok: true, collected: true })
                    : makeResp(401, { error: 'No DataCat account session configured' });
            }
            return makeResp(404, { error: 'unexpected path' });
        });

        const result = await setDatacatYoursSaved('abc12345', true);

        assert.equal(result.ok, true);
        assert.equal(result.collected, true);
        // yours(401) -> dc-auth-set(200) -> yours(200)
        assert.equal(calls.length, 3);
        assert.match(calls[0].path, /\/dc-yours\//);
        assert.match(calls[1].path, /\/dc-auth-set/);
        assert.match(calls[2].path, /\/dc-yours\//);
    });

    it('does not attempt recovery when no account token is saved', async () => {
        setSavedAccountTokenGetter(() => null);
        const calls = installApiRequest((path) => {
            if (path.includes('/dc-follow/')) {
                return makeResp(401, { error: 'No DataCat account session configured' });
            }
            return makeResp(404, { error: 'unexpected path' });
        });

        const result = await setDatacatFollow('c0ffee00-dead-beef-cafe-000000000000', true);

        assert.equal(result.ok, false);
        assert.equal(result.status, 401);
        // No /dc-auth-set restore attempt.
        assert.equal(calls.length, 1);
        assert.match(calls[0].path, /\/dc-follow\//);
    });

    it('surfaces the original 401 when recovery itself fails', async () => {
        setSavedAccountTokenGetter(() => 'acct-token');
        const calls = installApiRequest((path) => {
            if (path.includes('/dc-auth-set')) {
                return makeResp(401, { valid: false, reason: 'token expired' });
            }
            if (path.includes('/dc-following')) {
                return makeResp(401, { error: 'No DataCat account session configured' });
            }
            return makeResp(404, { error: 'unexpected path' });
        });

        const result = await fetchDatacatFollowing({ sourceKind: 'janitor' });

        assert.equal(result.ok, false);
        assert.equal(result.status, 401);
        // following(401) -> dc-auth-set(401, fails) -> no retry
        assert.equal(calls.length, 2);
        assert.match(calls[0].path, /\/dc-following/);
        assert.match(calls[1].path, /\/dc-auth-set/);
    });
});
