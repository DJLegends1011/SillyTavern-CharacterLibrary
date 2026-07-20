// ==UserScript==
// @name         Character Library - JannyAI Bridge
// @namespace    https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary
// @version      2.0.0
// @description  Lets Character Library sync JannyAI bookmarks and collections using a pasted login token plus browser Cloudflare clearance.
// @author       DJLegends
// @match        *://*/*
// @connect      jannyai.com
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @run-at       document-idle
// ==/UserScript==

/*
 * This is the JannyAI counterpart to the maintainer's JanitorAI Hampter bridge.
 * Character Library supplies the pasted Supabase access token in an Authorization
 * header; GM_xmlhttpRequest supplies the browser's Cloudflare clearance. The user
 * does not need to keep jannyai.com open or stay logged into it in another tab.
 *
 * SECURITY
 * The bridge only accepts same-origin messages from Character Library and only
 * permits the exact jannyai.com method/path pairs in isAllowed(). @connect enforces
 * the host boundary as well. It intentionally follows the maintainer bridge's broad
 * page match so remote SillyTavern/Colab URLs work on Firefox mobile.
 *
 * FRAME NOTE
 * Character Library can run inside SillyTavern's same-origin iframe, so this script
 * intentionally does not use @noframes.
 */
(function () {
    'use strict';

    const PAGE_SRC = 'character-library-janny';
    const SCRIPT_SRC = 'cl-janny-bridge';
    const JANNY_ORIGIN = 'https://jannyai.com';

    const isCLPage = /\/SillyTavern-CharacterLibrary\/app\/library\.html/i.test(location.pathname)
        || !!document.querySelector('meta[name="character-library"]');
    // Match the maintainer bridge: the CL page marker is the activation gate.
    if (!isCLPage) return;
    console.debug('[CL-JannyBridge] active on Character Library page');

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const COLLECTION_PATH_RE = /^\/collections\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:_[^/?#]+)?$/i;
    const COLLECTION_CHARACTERS_RE = /^\/api\/collections\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/characters$/i;
    const FORM_PATHS = [
        '/collections/form/add-collection',
        '/collections/form/edit-collection',
        '/collections/form/delete-collection',
    ];

    function csvIdsAreSafe(value) {
        if (!value || value.length > 4096) return false;
        return value.split(',').every(id => UUID_RE.test(id.trim()));
    }

    function isAllowed(method, urlStr) {
        let url;
        try { url = new URL(urlStr); } catch { return false; }
        if (url.origin !== JANNY_ORIGIN) return false;

        const verb = String(method || 'GET').toUpperCase();
        const p = url.pathname;
        const params = url.searchParams;
        const paramKeys = [...params.keys()];
        const hasOnly = (allowed) => paramKeys.every(k => allowed.includes(k));
        const noParams = paramKeys.length === 0;

        // Public collection browsing (HTML pages).
        if (verb === 'GET' && p === '/collections') return hasOnly(['page', 'sort', 'q']);
        if (verb === 'GET' && /^\/collectors\/[^/?#]{1,128}$/.test(p)) return noParams;
        if (verb === 'GET' && COLLECTION_PATH_RE.test(p)) return noParams;

        // Bookmarks.
        if (p === '/api/bookmark') {
            if (verb === 'GET' || verb === 'POST') return noParams;
            if (verb === 'DELETE') return hasOnly(['ids']) && csvIdsAreSafe(params.get('ids'));
            return false;
        }

        // Character hydration.
        if (verb === 'GET' && p === '/api/get-characters') {
            return hasOnly(['ids']) && csvIdsAreSafe(params.get('ids'));
        }

        // Collections (JSON APIs).
        if (verb === 'GET' && p === '/api/collections/mine') return noParams;
        if (COLLECTION_CHARACTERS_RE.test(p)) {
            if (verb === 'GET' || verb === 'POST') return noParams;
            if (verb === 'DELETE') return hasOnly(['characterId']) && UUID_RE.test(params.get('characterId') || '');
            return false;
        }

        // Collection create/edit/delete (server-rendered form POSTs, 302 on success).
        if (verb === 'POST' && FORM_PATHS.includes(p)) return noParams;

        return false;
    }

    const gmRequest = (typeof GM_xmlhttpRequest === 'function')
        ? GM_xmlhttpRequest
        : (typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest.bind(GM) : null);

    function reply(id, ok, status, body, finalUrl) {
        window.postMessage({ source: SCRIPT_SRC, type: 'result', id, ok, status, body, finalUrl: finalUrl || '' }, location.origin);
    }

    function announce() {
        window.postMessage({ source: SCRIPT_SRC, type: 'ready' }, location.origin);
    }

    window.addEventListener('message', (e) => {
        // Origin-guarded rather than e.source === window: under an Xray wrapper the sandbox
        // window is not identity-equal to the page window.
        if (e.origin !== location.origin) return;
        const msg = e.data;
        if (!msg || msg.source !== PAGE_SRC) return;

        if (msg.type === 'ping') { announce(); return; }
        if (msg.type !== 'fetch') return;

        const { id, method, url, body, contentType, authToken } = msg;
        if (!id) return;
        if (!gmRequest) { reply(id, false, 0, 'Userscript manager does not expose GM_xmlhttpRequest'); return; }
        if (!isAllowed(method, url)) { reply(id, false, 0, 'Blocked: bridge only permits allowlisted JannyAI requests'); return; }

        const headers = { 'Accept': 'application/json,text/html;q=0.9,*/*;q=0.8' };
        if (typeof contentType === 'string' && contentType) headers['Content-Type'] = contentType;
        if (typeof authToken === 'string' && authToken) headers['Authorization'] = `Bearer ${authToken}`;

        gmRequest({
            method: String(method).toUpperCase(),
            url,
            headers,
            // Tampermonkey 5.6+ otherwise selects cookies using the localhost sender frame.
            // Explicitly use the same partition as a top-level jannyai.com tab.
            cookiePartition: { topLevelSite: JANNY_ORIGIN },
            data: typeof body === 'string' && body ? body : undefined,
            timeout: 25000,
            onload: (r) => reply(id, r.status >= 200 && r.status < 400, r.status, r.responseText || '', r.finalUrl || ''),
            onerror: () => reply(id, false, 0, 'Network error'),
            ontimeout: () => reply(id, false, 0, 'Timed out'),
        });
    });

    announce();
})();
