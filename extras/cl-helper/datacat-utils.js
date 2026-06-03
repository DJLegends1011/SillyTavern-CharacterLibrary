export const DATACAT_ORIGIN = 'https://datacat.run';
export const DATACAT_TOKEN_MAX_LENGTH = 4096;

export function normalizeDcCredential(value, { maxLength = DATACAT_TOKEN_MAX_LENGTH } = {}) {
    if (typeof value !== 'string') return null;

    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength) return null;

    return normalized;
}

export function isDataCatCharacterId(value) {
    const normalized = normalizeDcCredential(value, { maxLength: 80 });
    return Boolean(normalized && /^[a-f0-9-]{8,64}$/i.test(normalized));
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
    if (account) {
        return { token: account, source: 'account' };
    }

    return { token: null, source: null };
}

export function buildDataCatHeaders({
    sessionToken,
    deviceToken = null,
    json = false,
} = {}) {
    const headers = {
        'User-Agent': 'SillyTavern-CharacterLibrary',
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

export function sanitizeDataCatUser(user = null) {
    if (!user || typeof user !== 'object' || Array.isArray(user)) return null;

    return {
        uuid: normalizeDcCredential(user.uuid ?? user.id),
        email: normalizeDcCredential(user.email),
        username: normalizeDcCredential(user.username),
        role: normalizeDcCredential(user.role),
    };
}
