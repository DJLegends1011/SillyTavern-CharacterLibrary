export const DATACAT_ORIGIN = 'https://datacat.run';
export const DATACAT_TOKEN_MAX_LENGTH = 4096;
export const DATACAT_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

export function normalizeDcCredential(value, { maxLength = DATACAT_TOKEN_MAX_LENGTH } = {}) {
    if (typeof value !== 'string') return null;

    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength) return null;
    if (/[\u0000-\u001F\u007F]/.test(normalized)) return null;

    return normalized;
}

export function normalizeOptionalDcCredential(value, options = {}) {
    if (value === undefined || value === null) return null;
    return normalizeDcCredential(value, options);
}

export function isDataCatCharacterId(value) {
    const normalized = normalizeDcCredential(value, { maxLength: 80 });
    return Boolean(normalized
        && /^[a-f0-9][a-f0-9-]{6,62}[a-f0-9]$/i.test(normalized)
        && !normalized.includes('--'));
}

export function chooseDataCatToken({
    accountToken = null,
    anonymousToken = null,
    preferAccount = true,
} = {}) {
    const account = normalizeDcCredential(accountToken);
    const anonymous = normalizeDcCredential(anonymousToken);

    if (preferAccount && account) {
        return { token: account, source: 'account' };
    }
    if (anonymous) {
        return { token: anonymous, source: 'anonymous' };
    }

    return { token: null, source: null };
}

export function buildDataCatHeaders({
    sessionToken,
    deviceToken = null,
    json = false,
} = {}) {
    const headers = {
        'User-Agent': DATACAT_BROWSER_UA,
        Accept: 'application/json',
        Origin: DATACAT_ORIGIN,
        Referer: `${DATACAT_ORIGIN}/`,
    };

    const session = normalizeDcCredential(sessionToken);
    const device = normalizeDcCredential(deviceToken);

    if (session) headers['X-Session-Token'] = session;
    if (device) headers['X-Device-Token'] = device;
    if (json) headers['Content-Type'] = 'application/json';

    return headers;
}

export function buildDataCatGoogleSigninBody(firebaseIdToken, anonymousToken = null) {
    const token = normalizeDcCredential(firebaseIdToken);
    if (!token) return null;

    const body = { token };
    const anonToken = normalizeDcCredential(anonymousToken);
    if (anonToken) body.anonToken = anonToken;

    return body;
}

export function sanitizeDataCatUser(user = null) {
    if (!user || typeof user !== 'object' || Array.isArray(user)) return null;

    return {
        uuid: normalizeDcCredential(user.uuid ?? user.id, { maxLength: 128 }),
        email: normalizeDcCredential(user.email, { maxLength: 320 }),
        username: normalizeDcCredential(user.username, { maxLength: 80 }),
        role: normalizeDcCredential(user.role, { maxLength: 40 }),
    };
}
