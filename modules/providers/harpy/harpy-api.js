// Shared Harpy (harpy.chat) API utilities, used by harpy-provider.js and harpy-browse.js
//
// Listing, tags, creators and gallery come straight from Harpy's Supabase REST API (public
// anon key, CORS open to any origin). Definitions are NOT in those views: they come from the
// server-rendered character page (see harpy-page.js), which sends no CORS headers, so that
// one fetch goes through cl-helper's /harpy-page route, or ST's /proxy/ without the helper.

import { CL_HELPER_PLUGIN_BASE, fetchWithProxy, readJsonClassified } from '../provider-utils.js';
import {
    parseHarpyCharacterPage,
    docToMarkdown,
    docToHtml,
    normalizeMacros,
    findHarpyOnlyMacros,
} from './harpy-page.js';

export { slugify, stripHtml, formatNumber } from '../provider-utils.js';

// ========================================
// CONSTANTS
// ========================================

export const HARPY_SITE_BASE = 'https://harpy.chat';
const SUPABASE_REST = 'https://ehgqxxoeyqsdgquzzond.supabase.co/rest/v1';
// Harpy's own public client key (Supabase `anon` role, the one harpy.chat's bundle ships).
// It reads only what RLS already exposes to logged-out visitors.
const HARPY_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVoZ3F4eG9leXFzZGdxdXp6b25kIiwicm9sZSI6ImFub24iLCJpYXQiOjE2OTI5NTM0ODUsImV4cCI6MjAwODUyOTQ4NX0.Cn-jDJqZFnwnhV9H6sBdRj8a3RA_XNWsBrApg4spOis';
const HARPY_ASSET_BASE = 'https://storage.googleapis.com/astrsk-assets/';
const HARPY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const HARPY_PAGE_SIZE = 48;

export const HARPY_SORT_OPTIONS = [
    { value: 'popular', label: 'Most Popular', order: 'total_interactions.desc.nullslast', emoji: '🔥' },
    { value: 'recommended', label: 'Recommended', order: 'recommended_score.desc.nullslast', emoji: '✨' },
    { value: 'newest', label: 'Newest', order: 'published_at.desc.nullslast', emoji: '🆕' },
    { value: 'likes', label: 'Most Liked', order: 'like_count.desc.nullslast', emoji: '❤️' },
    { value: 'chats', label: 'Most Chats', order: 'chat_count.desc.nullslast', emoji: '💬' },
    { value: 'updated', label: 'Recently Updated', order: 'updated_at.desc', emoji: '🕐' },
];

const LISTING_SELECT = [
    'id,name,title,tags,token_count,creator,owner_id',
    'is_nsfw,is_nsfw_image,is_locked,is_premium',
    'like_count,chat_count,total_interactions,created_at,published_at,updated_at',
    'icon_asset:hub_assets!icon_asset_id(file_path)',
    'owner_profile:astrsk_users!owner_id(name)',
].join(',');

// Every listing excludes drafts and private session copies, as harpy.chat's own browse does.
const BASE_FILTERS = ['is_public=eq.true', 'is_draft=eq.false', 'session_id=is.null'];

// ========================================
// SUPABASE REST
// ========================================

async function restGet(pathAndQuery, { count = false } = {}) {
    const headers = { apikey: HARPY_ANON_KEY, Authorization: `Bearer ${HARPY_ANON_KEY}`, Accept: 'application/json' };
    if (count) headers.Prefer = 'count=exact';
    const resp = await fetch(`${SUPABASE_REST}${pathAndQuery}`, { headers });
    const data = await readJsonClassified(resp);
    let total = null;
    const range = resp.headers.get('content-range');
    if (range && range.includes('/')) {
        const n = parseInt(range.split('/')[1], 10);
        if (Number.isFinite(n)) total = n;
    }
    return { data, total };
}

const pgArray = (values) => `{${values.map(v => `"${String(v).replace(/["\\]/g, '')}"`).join(',')}}`;

/**
 * Harpy's tag_norm form: case and emoji dropped, spaces and hyphens kept
 * ("‍🦰 Female" -> "female", "Dead Dove" -> "dead dove"). Filtering on tags_norm with this
 * makes tags typed in Settings match however the creator decorated them.
 * @param {string} tag
 */
export function normalizeHarpyTag(tag) {
    return String(tag || '').normalize('NFKC').toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]+/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}
// PostgREST reserves , ( ) inside or=() filters; `*` is its ilike wildcard
const pgLikeTerm = (s) => String(s).replace(/[,()*%\\]/g, ' ').trim();

/**
 * Search the public character listing.
 * @param {Object} opts
 * @returns {Promise<{characters: Object[], total: number|null, hasMore: boolean}>}
 */
export async function searchHarpy(opts = {}) {
    const {
        search = '',
        sort = 'popular',
        offset = 0,
        limit = HARPY_PAGE_SIZE,
        includeTags = [],
        excludeTags = [],
        nsfw = false,
        showLocked = false,
        ownerId = null,
        minTokens = 0,
        maxTokens = 0,
    } = opts;

    const filters = [...BASE_FILTERS];
    if (!nsfw) filters.push('is_nsfw=eq.false');
    if (!showLocked) filters.push('is_locked=eq.false');
    if (ownerId && HARPY_ID_RE.test(ownerId)) filters.push(`owner_id=eq.${ownerId}`);
    const inc = [...new Set(includeTags.map(normalizeHarpyTag).filter(Boolean))];
    const exc = [...new Set(excludeTags.map(normalizeHarpyTag).filter(Boolean))];
    if (inc.length) filters.push(`tags_norm=cs.${encodeURIComponent(pgArray(inc))}`);
    if (exc.length) filters.push(`tags_norm=not.ov.${encodeURIComponent(pgArray(exc))}`);
    if (minTokens > 0) filters.push(`token_count=gte.${Math.floor(minTokens)}`);
    if (maxTokens > 0) filters.push(`token_count=lte.${Math.floor(maxTokens)}`);
    const term = pgLikeTerm(search);
    if (term) {
        const like = `*${term}*`;
        filters.push(`or=${encodeURIComponent(`(search_text.ilike.${like},creator.ilike.${like},tags_search.ilike.${like})`)}`);
    }

    const order = HARPY_SORT_OPTIONS.find(o => o.value === sort)?.order || HARPY_SORT_OPTIONS[0].order;
    const query = `/hub_characters_with_likes?select=${encodeURIComponent(LISTING_SELECT)}&${filters.join('&')}`
        + `&order=${order},id.asc&offset=${offset}&limit=${limit}`;
    const { data, total } = await restGet(query, { count: true });
    const characters = Array.isArray(data) ? data : [];
    return {
        characters,
        total,
        hasMore: total != null ? offset + characters.length < total : characters.length === limit,
    };
}

/**
 * One listing row by id (stats, lock state, creator, icon).
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function fetchHarpyListingRow(id) {
    if (!HARPY_ID_RE.test(String(id))) return null;
    const { data } = await restGet(`/hub_characters_with_likes?select=${encodeURIComponent(`${LISTING_SELECT},summary`)}&id=eq.${id}&limit=1`);
    return Array.isArray(data) ? (data[0] || null) : null;
}

/**
 * Most-used tags, for the tag filter dropdown.
 * @param {number} [limit]
 * @returns {Promise<Array<{tag: string, norm: string, count: number}>>}
 */
export async function fetchHarpyTopTags(limit = 400) {
    const { data } = await restGet(`/hub_character_tag_stats?select=tag,tag_norm,character_count&tag_norm=neq.&order=character_count.desc&limit=${limit}`);
    return (Array.isArray(data) ? data : [])
        .filter(r => r?.tag_norm && r.tag?.trim())
        .map(r => ({ tag: r.tag.trim(), norm: r.tag_norm, count: r.character_count || 0 }));
}

/**
 * Creator lookup by name (Harpy's own search_creators RPC).
 * @param {string} query
 * @returns {Promise<Array<{id: string, name: string, character_count: number, follower_count: number, avatar_url: string}>>}
 */
export async function searchHarpyCreators(query, limit = 10) {
    const params = new URLSearchParams({ p_search: String(query || '').trim(), p_sort: 'followers', p_limit: String(limit), p_offset: '0' });
    const { data } = await restGet(`/rpc/search_creators?${params}`);
    return Array.isArray(data) ? data : [];
}

/**
 * Resolve a creator name (or id) to { id, name }. Exact name match wins.
 * @param {string} nameOrId
 * @returns {Promise<{id: string, name: string}|null>}
 */
export async function resolveHarpyCreator(nameOrId) {
    const q = String(nameOrId || '').trim().replace(/^@/, '');
    if (!q) return null;
    if (HARPY_ID_RE.test(q)) {
        const { data } = await restGet(`/astrsk_users?select=id,name&id=eq.${q}&limit=1`);
        const row = Array.isArray(data) ? data[0] : null;
        return row ? { id: row.id, name: row.name || q } : null;
    }
    const matches = await searchHarpyCreators(q);
    const lower = q.toLowerCase();
    const hit = matches.find(c => (c.name || '').toLowerCase() === lower) || matches[0];
    return hit ? { id: hit.id, name: hit.name || q } : null;
}

/**
 * Gallery images attached to a character (public, per-image NSFW flag).
 * @param {string} characterId
 * @returns {Promise<Array<{url: string, thumb: string, id: string, name: string, nsfw: boolean}>>}
 */
export async function fetchHarpyGallery(characterId) {
    if (!HARPY_ID_RE.test(String(characterId))) return [];
    const select = encodeURIComponent('id,is_nsfw,created_at,asset:hub_assets!asset_id(id,name,file_path,thumbnail_path)');
    const { data } = await restGet(`/hub_character_gallery_images?select=${select}&character_id=eq.${characterId}&order=created_at.asc`);
    return (Array.isArray(data) ? data : [])
        .filter(r => r?.asset?.file_path)
        .map(r => ({
            url: harpyAssetUrl(r.asset.file_path),
            thumb: harpyAssetUrl(r.asset.thumbnail_path || r.asset.file_path),
            id: r.asset.id || r.id,
            // the asset id is the stable identity; the stored name is the uploader's filename
            name: r.asset.id || r.id,
            nsfw: r.is_nsfw === true,
        }));
}

// ========================================
// CHARACTER PAGE (definitions)
// ========================================

let _helperProbe = null;

/**
 * Is cl-helper present and new enough to serve /harpy-page?
 * @param {Function} apiRequest - CoreAPI.apiRequest
 */
export function harpyHelperAvailable(apiRequest) {
    if (!apiRequest) return Promise.resolve(false);
    if (!_helperProbe) {
        _helperProbe = (async () => {
            try {
                const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/health`);
                if (!resp.ok) return false;
                const data = await resp.json();
                return data?.ok === true && Array.isArray(data.features) && data.features.includes('harpy-page');
            } catch {
                return false;
            }
        })();
    }
    return _helperProbe;
}

/**
 * Fetch and parse a character's public page.
 * @param {string} id
 * @param {Function} [apiRequest]
 * @returns {Promise<ReturnType<typeof parseHarpyCharacterPage>>}
 */
export async function fetchHarpyCharacterPage(id, apiRequest) {
    if (!HARPY_ID_RE.test(String(id))) throw new Error('Invalid Harpy character id');
    let body;
    if (await harpyHelperAvailable(apiRequest)) {
        const resp = await apiRequest(`${CL_HELPER_PLUGIN_BASE}/harpy-page/${id}`);
        if (!resp.ok) {
            const t = await resp.text().catch(() => '');
            throw new Error(`Harpy page fetch failed (HTTP ${resp.status})${t ? `: ${t.slice(0, 120)}` : ''}`);
        }
        body = await resp.text();
    } else {
        // Without the helper: the full HTML through ST's CORS proxy carries the same flight data
        const resp = await fetchWithProxy(`${HARPY_SITE_BASE}/characters/${id}`);
        body = await resp.text();
    }
    const page = parseHarpyCharacterPage(body);
    if (!page) throw new Error('Could not find the character data on the Harpy page (layout change?)');
    return page;
}

// ========================================
// URL HELPERS
// ========================================

export function harpyAssetUrl(filePath) {
    if (!filePath) return '';
    if (/^https?:\/\//i.test(filePath)) return filePath;
    return HARPY_ASSET_BASE + String(filePath).split('/').map(encodeURIComponent).join('/');
}

export function harpyCharacterUrl(id) {
    return `${HARPY_SITE_BASE}/characters/${id}`;
}

export function harpyCreatorUrl(name) {
    return `${HARPY_SITE_BASE}/u/${encodeURIComponent(name)}`;
}

export function isHarpyId(value) {
    return HARPY_ID_RE.test(String(value || ''));
}

/**
 * Parse a harpy.chat URL.
 * @param {string} url
 * @returns {{type: 'character', id: string}|{type: 'creator', name: string}|null}
 */
export function parseHarpyUrl(url) {
    if (!url) return null;
    try {
        const u = new URL(url.startsWith('http') ? url : `https://${url}`);
        if (!/^(www\.)?harpy\.chat$/i.test(u.hostname)) return null;
        const ch = u.pathname.match(/^\/characters\/([0-9a-f-]{36})/i);
        if (ch && isHarpyId(ch[1])) return { type: 'character', id: ch[1].toLowerCase() };
        const cr = u.pathname.match(/^\/u\/([^/]+)/);
        if (cr) return { type: 'creator', name: decodeURIComponent(cr[1]) };
    } catch { /* not a URL */ }
    return null;
}

// ========================================
// LISTING ROW HELPERS
// ========================================

/** The character's own name ("Claire"); `title` is the listing headline. */
export function harpyCharName(row) {
    return (row?.name || '').trim() || (row?.title || '').trim() || 'Unknown';
}

export function harpyListingTitle(row) {
    return (row?.title || '').trim() || harpyCharName(row);
}

export function harpyCreatorName(row) {
    return row?.owner_profile?.name || row?.creator || '';
}

export function harpyAvatarUrl(row) {
    return harpyAssetUrl(row?.icon_asset?.file_path || row?.imageFilePath || '') || row?.image || '';
}

export function harpyTags(row) {
    return Array.isArray(row?.tags) ? row.tags.map(t => String(t).trim()).filter(Boolean) : [];
}

// ========================================
// V2 CARD BUILDING
// ========================================

function mesExample(value) {
    const text = normalizeMacros(docToMarkdown(value)).trim();
    if (!text) return '';
    return /^<START>/i.test(text) ? text : `<START>\n${text}`;
}

// Harpy's lorebook shape is unverified (no public card has shipped one yet); only a
// payload already in character_book form is carried, anything else is dropped.
function characterBookFrom(lorebook) {
    if (!lorebook || typeof lorebook !== 'object' || !Array.isArray(lorebook.entries)) return undefined;
    return lorebook;
}

/**
 * Build the notes block: the showcase summary as HTML, plus what the import could not carry.
 */
function buildCreatorNotes(summaryDoc, { harpyMacros = [], linkedLorebooks = 0, locked = false, extracted = false } = {}) {
    const parts = [];
    if (locked && !extracted) {
        parts.push('<p><em>Imported from Harpy without its definition: the creator locked it. Description and scenario are empty.</em></p>');
    }
    if (harpyMacros.length) {
        parts.push(`<p><em>Uses Harpy pronoun macros that SillyTavern does not replace: ${harpyMacros.join(', ')}.</em></p>`);
    }
    if (linkedLorebooks > 0) {
        parts.push(`<p><em>Uses ${linkedLorebooks} linked lorebook${linkedLorebooks === 1 ? '' : 's'} on Harpy that ${linkedLorebooks === 1 ? 'is' : 'are'} not public and could not be included.</em></p>`);
    }
    const summaryHtml = docToHtml(summaryDoc);
    if (parts.length && summaryHtml) parts.push('<hr>');
    if (summaryHtml) parts.push(summaryHtml);
    return parts.join('\n');
}

/**
 * Build a chara_card_v2 from a listing row plus the parsed character page.
 * @param {Object} row - listing row (fetchHarpyListingRow / searchHarpy)
 * @param {Object} page - parseHarpyCharacterPage result
 * @param {Object} [extracted] - { description, scenario } recovered for a locked card
 */
export function buildV2FromHarpy(row, page, extracted = null) {
    const greetings = (page?.firstMessages || []).map(d => normalizeMacros(docToMarkdown(d))).filter(g => g.trim());
    const description = normalizeMacros(extracted?.description ?? page?.description ?? '');
    const scenario = normalizeMacros(extracted?.scenario ?? page?.scenario ?? '');
    const locked = page?.isLocked === true || row?.is_locked === true;
    const harpyMacros = findHarpyOnlyMacros([description, scenario, ...greetings]);
    const summary = page?.raw?.summary ?? row?.summary ?? null;

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: harpyCharName(page?.raw?.name ? page.raw : row),
            description,
            personality: '',
            scenario,
            first_mes: greetings[0] || '',
            mes_example: mesExample(page?.exampleDialogue),
            system_prompt: '',
            post_history_instructions: '',
            creator_notes: buildCreatorNotes(summary, {
                harpyMacros,
                linkedLorebooks: page?.linkedLorebookIds?.length || 0,
                locked,
                extracted: !!extracted,
            }),
            creator: harpyCreatorName(row) || '',
            character_version: '',
            tags: harpyTags(row?.tags ? row : page?.raw),
            alternate_greetings: greetings.slice(1),
            character_book: characterBookFrom(page?.lorebook),
            extensions: {
                harpy: {
                    id: row?.id || page?.id || null,
                    ownerId: row?.owner_id || page?.ownerId || null,
                    creatorName: harpyCreatorName(row) || null,
                    pageName: harpyListingTitle(row?.title ? row : page?.raw),
                    locked,
                    definitionMissing: locked && !extracted,
                },
            },
        },
    };
}
