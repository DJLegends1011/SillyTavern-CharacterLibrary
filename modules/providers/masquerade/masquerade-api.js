// Shared MasqueradeAI API utilities.
//
// Masquerade exposes a public Supabase/PostgREST character catalog. This
// module keeps the browser-only provider's network and V2 card mapping in one
// place so provider, browse UI, and tests share the same behavior.

import { fetchWithProxy } from '../provider-utils.js';

export const MASQUERADE_SITE_BASE = 'https://www.masqueradeproductions.org';
export const MASQUERADE_API_BASE = 'https://api.masqueradeproductions.org';
export const MASQUERADE_SUPABASE_REST_BASE = 'https://mqdpdmiujadxdhxxqcqk.supabase.co/rest/v1';
export const MASQUERADE_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1xZHBkbWl1amFkeGRoeHhxY3FrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc5ODI4MjksImV4cCI6MjA4MzU1ODgyOX0.YNTbx6Ta3R1LEyrPwzJz8z3QYo0W-SyDM5bQn9pgbA8';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 5;

const MASQUERADE_FIELDS = [
    'id',
    'user_id',
    'name',
    'tagline',
    'description',
    'greeting',
    'personality',
    'scenario',
    'image_url',
    'background_url',
    'circle_avatar_url',
    'created_at',
    'is_public',
    'is_unlisted',
    'force_private',
    'is_nsfw',
    'is_obliterated',
    'origin_tag',
    'identity_tags',
    'personality_tags',
    'subscriber_count',
    'total_messages',
    'unique_chatters',
    'chat_count',
    'quality_score',
    'card_bottom_color',
    'alternate_greetings',
    'theme_url',
    'theme_name',
    'theme_spotify_url',
    'theme_soundcloud_url',
    'theme_suno_url',
    'profile_opacity',
    'profile_blur',
    'profile_glass',
    'profile_bg_position_x',
    'profile_bg_position_y',
    'profile_bg_zoom',
    'recent_bg_position_x',
    'recent_bg_position_y',
    'recent_bg_zoom',
    'is_amplified',
    'foil_style',
    'foil_colors',
    'foil_texture',
    'foil_texture_opacity',
    'foil_texture_size',
    'foil_light',
    'creator_colors',
    'voice_config',
    'amplified_at',
];

export const MASQUERADE_SELECT = MASQUERADE_FIELDS.join(',');

export const MASQUERADE_SORT_OPTIONS = {
    popular: { label: 'Popular', order: 'total_messages.desc.nullslast' },
    newest: { label: 'Newest', order: 'created_at.desc' },
    quality: { label: 'Quality', order: 'quality_score.desc.nullslast' },
    subscribers: { label: 'Most Saved', order: 'subscriber_count.desc.nullslast' },
    chatters: { label: 'Most Chatters', order: 'unique_chatters.desc.nullslast' },
};

let _getSetting = null;
let _debugLog = null;
export const masqueradeMetadataCache = new Map();

export function initMasqueradeApi(deps = {}) {
    _getSetting = deps.getSetting || null;
    _debugLog = deps.debugLog || null;
}

function debugLog(...args) {
    _debugLog?.(...args);
}

export function getMasqueradeHeaders(includeAuth = true, json = false) {
    const token = includeAuth ? _getSetting?.('masqueradeToken') : null;
    const headers = {
        Accept: 'application/json',
        apikey: MASQUERADE_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token || MASQUERADE_SUPABASE_ANON_KEY}`,
    };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
}

function buildRestUrl(table, params = {}) {
    const url = new URL(`${MASQUERADE_SUPABASE_REST_BASE}/${table}`);
    for (const [key, value] of Object.entries(params)) {
        if (value != null && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
}

async function fetchJson(url, options = {}) {
    const response = await fetchWithProxy(url, options);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

function rememberMetadata(id, value) {
    if (!id || !value) return;
    while (masqueradeMetadataCache.size >= CACHE_MAX) {
        const firstKey = masqueradeMetadataCache.keys().next().value;
        masqueradeMetadataCache.delete(firstKey);
    }
    masqueradeMetadataCache.set(id, { value, time: Date.now() });
}

export function isMasqueradeUuid(value) {
    return UUID_RE.test(String(value || ''));
}

export async function fetchMasqueradeMetadata(charId) {
    if (!isMasqueradeUuid(charId)) return null;

    const cached = masqueradeMetadataCache.get(charId);
    if (cached && Date.now() - cached.time < CACHE_TTL) {
        debugLog('[Masquerade] Using cached metadata for:', charId);
        return cached.value;
    }

    const url = buildRestUrl('characters', {
        select: MASQUERADE_SELECT,
        id: `eq.${charId}`,
        limit: 1,
    });
    const rows = await fetchJson(url, { headers: getMasqueradeHeaders(false) });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;

    const normalized = normalizeMasqueradeCharacter(row);
    if (!isMasqueradeCharacterImportable(normalized)) return null;
    rememberMetadata(charId, normalized);
    return normalized;
}

export async function browseMasqueradeCharacters(opts = {}) {
    const {
        page = 1,
        limit = 60,
        sort = 'popular',
        nsfw = false,
        excludeTags = [],
    } = opts;
    const offset = Math.max(0, (Number(page) - 1) * Number(limit));
    const params = {
        select: MASQUERADE_SELECT,
        is_public: 'eq.true',
        is_unlisted: 'neq.true',
        force_private: 'neq.true',
        is_obliterated: 'neq.true',
        order: MASQUERADE_SORT_OPTIONS[sort]?.order || MASQUERADE_SORT_OPTIONS.popular.order,
        limit,
        offset,
    };
    if (!nsfw) params.is_nsfw = 'neq.true';

    const rows = await fetchJson(buildRestUrl('characters', params), { headers: getMasqueradeHeaders(false) });
    return filterAndNormalizeRows(rows, { nsfw, excludeTags });
}

export async function searchMasqueradeCharacters(opts = {}) {
    const {
        query = '',
        limit = 60,
        nsfw = false,
        excludeTags = [],
    } = opts;
    const trimmed = String(query || '').trim();
    if (!trimmed) return browseMasqueradeCharacters(opts);

    try {
        const data = await fetchJson(`${MASQUERADE_SUPABASE_REST_BASE}/rpc/search_characters_fuzzy`, {
            method: 'POST',
            headers: getMasqueradeHeaders(false, true),
            body: JSON.stringify({ search_term: trimmed }),
        });
        return filterAndNormalizeRows(data, { nsfw, excludeTags }).slice(0, limit);
    } catch (error) {
        debugLog('[Masquerade] RPC search failed, using ilike fallback:', error.message);
        const term = trimmed.replace(/[%(),]/g, ' ');
        const url = buildRestUrl('characters', {
            select: MASQUERADE_SELECT,
            is_public: 'eq.true',
            is_unlisted: 'neq.true',
            force_private: 'neq.true',
            is_obliterated: 'neq.true',
            or: `(name.ilike.%${term}%,tagline.ilike.%${term}%,origin_tag.ilike.%${term}%)`,
            order: MASQUERADE_SORT_OPTIONS.popular.order,
            limit,
        });
        const rows = await fetchJson(url, { headers: getMasqueradeHeaders(false) });
        return filterAndNormalizeRows(rows, { nsfw, excludeTags });
    }
}

function filterAndNormalizeRows(rows, options = {}) {
    const excludeTags = new Set((options.excludeTags || []).map(normalizeTag).filter(Boolean));
    return (Array.isArray(rows) ? rows : [])
        .map(normalizeMasqueradeCharacter)
        .filter(isMasqueradeCharacterBrowsable)
        .filter(row => options.nsfw || row.is_nsfw !== true)
        .filter(row => !row.tags.some(tag => excludeTags.has(normalizeTag(tag))));
}

function normalizeTag(tag) {
    return String(tag || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function pushUnique(list, seen, value) {
    const clean = normalizeTag(value);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    list.push(clean);
}

export function getMasqueradeTags(row, includeNsfwTag = false) {
    const tags = [];
    const seen = new Set();
    pushUnique(tags, seen, row?.origin_tag);
    for (const tag of Array.isArray(row?.identity_tags) ? row.identity_tags : []) pushUnique(tags, seen, tag);
    for (const tag of Array.isArray(row?.personality_tags) ? row.personality_tags : []) pushUnique(tags, seen, tag);
    if (includeNsfwTag && row?.is_nsfw) pushUnique(tags, seen, 'nsfw');
    return tags;
}

export function isMasqueradeCharacterImportable(row = {}) {
    return !!(row.id || row.character_id)
        && row.is_public !== false
        && row.force_private !== true
        && row.is_obliterated !== true;
}

export function isMasqueradeCharacterBrowsable(row = {}) {
    return isMasqueradeCharacterImportable(row)
        && row.is_unlisted !== true;
}

export function getAvatarUrl(row) {
    const src = row?.image_url || row?.avatar_url;
    if (!src || typeof src !== 'string') return '/img/ai4.png';
    if (!src.startsWith('http')) return '/img/ai4.png';
    const safety = typeof window !== 'undefined' ? window.isUrlSafeForDownload?.(src) : null;
    if (safety && !safety.ok) return '/img/ai4.png';
    return src;
}

export function getGalleryUrls(row) {
    const avatar = getAvatarUrl(row);
    const urls = [];
    const seen = new Set([avatar]);
    for (const url of [row?.background_url, row?.circle_avatar_url]) {
        if (!url || typeof url !== 'string' || !url.startsWith('http')) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
    }
    return urls;
}

export function normalizeMasqueradeCharacter(row = {}) {
    const id = row.id || row.character_id || null;
    const avatarUrl = getAvatarUrl(row);
    return {
        ...row,
        id,
        character_id: id,
        avatar_url: avatarUrl,
        image_url: row.image_url || avatarUrl,
        message_count: row.message_count || row.total_messages || 0,
        chat_count: row.chat_count || row.unique_chatters || 0,
        tags: getMasqueradeTags(row, false),
        galleryUrls: getGalleryUrls(row),
    };
}

export function getCharacterPageUrl(charId) {
    return `${MASQUERADE_SITE_BASE}/character/${encodeURIComponent(charId)}`;
}

export function parseCharacterUrl(url) {
    if (!url) return null;
    try {
        const u = new URL(String(url).startsWith('http') ? url : `https://${url}`);
        if (!/^(www\.)?masqueradeproductions\.org$/i.test(u.hostname)) return null;
        const match = u.pathname.match(/^\/(?:character|chat)\/([0-9a-f-]{36})(?:\/)?$/i);
        if (!match) return null;
        return isMasqueradeUuid(match[1]) ? match[1] : null;
    } catch {
        return null;
    }
}

function maybeDistinct(value, other) {
    const a = String(value || '').trim();
    const b = String(other || '').trim();
    return a && a !== b ? a : '';
}

function getCreatorNotes(row) {
    return row.creator_notes || row.creatorNotes || row.author_notes || row.authorNotes || '';
}

export function buildCharacterCardFromMasquerade(rawRow = {}) {
    const row = normalizeMasqueradeCharacter(rawRow);
    const description = row.description || '';
    const personality = row.personality || '';
    const scenario = maybeDistinct(row.scenario, description);
    const sourceUrl = row.id ? getCharacterPageUrl(row.id) : MASQUERADE_SITE_BASE;

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: row.name || 'Unknown',
            description,
            personality,
            scenario,
            first_mes: row.greeting || '',
            mes_example: '',
            creator_notes: getCreatorNotes(row),
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: Array.isArray(row.alternate_greetings)
                ? row.alternate_greetings.filter(g => typeof g === 'string' && g.trim()).map(g => g.trim())
                : [],
            tags: getMasqueradeTags(row, true),
            creator: row.creator_name || '',
            character_version: '',
            extensions: {
                masquerade: {
                    id: row.id || null,
                    user_id: row.user_id || null,
                    pageName: row.name || '',
                    tagline: row.tagline || '',
                    image_url: row.image_url || null,
                    background_url: row.background_url || null,
                    circle_avatar_url: row.circle_avatar_url || null,
                    is_nsfw: !!row.is_nsfw,
                    is_unlisted: !!row.is_unlisted,
                    subscriber_count: row.subscriber_count || 0,
                    total_messages: row.total_messages || 0,
                    unique_chatters: row.unique_chatters || 0,
                    quality_score: row.quality_score || 0,
                    created_at: row.created_at || null,
                    sourceUrl,
                    linkedAt: new Date().toISOString(),
                },
            },
            character_book: undefined,
        },
    };
}
