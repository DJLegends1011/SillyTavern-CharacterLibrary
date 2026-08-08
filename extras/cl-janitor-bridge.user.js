// ==UserScript==
// @name         Character Library - JanitorAI Bridge
// @namespace    https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary
// @version      1.3.1
// @description  Lets Character Library reach Cloudflare-gated pages from your own browser: DataCat's JanitorAI Hampter sorts and JannyAI card definitions. Not used by the JanitorAI provider, which needs a real browser.
// @author       Sillyanonymous
// @match        *://*/*
// @connect      janitorai.com
// @connect      jannyai.com
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_openInTab
// @run-at       document-idle
// ==/UserScript==

/*
 * WHY THIS EXISTS
 * A page fetch from Character Library to janitorai.com can read the response (hampter serves
 * CORS *) but cannot send your janitorai cf_clearance cookie (credentialed requests are rejected
 * against a * ACAO), so it only gets through when Cloudflare isn't actively challenging.
 * jannyai.com character pages are worse: they serve no CORS headers at all, and Cloudflare
 * challenges every server-side transport, so card definitions are unreachable without a real
 * browser context. GM_xmlhttpRequest is CORS-exempt: it carries your cf_clearance cookie for the
 * target site, so the request passes Cloudflare reliably. That cookie is the ONLY thing this
 * script uniquely adds. It also forwards the Authorization header CL provides, but that is just
 * the request riding along intact: the JanitorAI login (which unlocks page 2+ of the hampter
 * sorts) is a CORS-allowed header the direct fetch sends too, so login works with or without
 * this script.
 *
 * CLEARANCE REFRESH (v1.2.0)
 * cf_clearance is short-lived and does NOT slide: Cloudflare sets a fixed expiry when the
 * challenge is passed, so no amount of traffic extends it. Once it lapses, both sites answer
 * every request with a managed challenge (cf-mitigated: challenge) until a REAL browsing context
 * executes the challenge JS again. GM_xmlhttpRequest cannot do that (no JS execution), and an
 * iframe cannot either (the challenge response sets X-Frame-Options: SAMEORIGIN). The only
 * mechanism left is a genuine page load, so on request this script opens the site in a
 * BACKGROUND tab and then POLLS the site until it stops answering with a challenge, at which
 * point the tab is closed and the caller told it is safe to retry. Nothing is ever read out of
 * that tab; the browser simply gains a fresh cookie the next GM_xmlhttpRequest can carry.
 * v1.2.1 replaced a fixed wait with that poll, because a fixed wait made the very request that
 * triggered the refresh retry too early and fail while every later request succeeded.
 * v1.3.0 polls faster and closes sooner, and CL now warms clearance when you open the JannyAI
 * browse view, so the refresh usually happens while you are still scanning the grid rather than
 * when you click a card. A tab is still required: the challenge only clears in a real browsing
 * context, and neither GM_xmlhttpRequest (no JS) nor an iframe (X-Frame-Options) qualifies.
 *
 * SECURITY
 * This script is a privileged context (GM_xmlhttpRequest can reach the network with your cookies),
 * so it is deliberately locked down:
 *   - It ONLY ever GETs https://janitorai.com/hampter/... or https://jannyai.com/characters/...
 *     Any other URL or method is refused, so even a compromised CL page cannot use it to read
 *     your cookies from another site.
 *   - The clearance refresh can ONLY open the two site roots above, never a caller-supplied URL,
 *     so the added GM_openInTab grant cannot be steered anywhere else.
 *   - It only answers same-origin messages (event.origin check) tagged by CL.
 *   - @connect janitorai.com / jannyai.com make the userscript manager enforce the host
 *     boundary too.
 * It never sends anything anywhere except the two requests CL asks for, and returns only those
 * response bodies back to the CL page in the same tab.
 */

(function () {
    'use strict';

    const PAGE_SRC = 'character-library';
    const SCRIPT_SRC = 'cl-janitor-bridge';

    // Only run on the Character Library page (the manifest @match is broad; this narrows it without
    // needing to know the user's SillyTavern host). CL announces itself with a page marker.
    // Frames are deliberately NOT excluded: CL's embedded pane mode IS an iframe, so @noframes
    // would make the bridge unreachable there. Every other frame exits on the next line.
    const isCLPage = /\/SillyTavern-CharacterLibrary\/app\/library\.html/i.test(location.pathname)
        || !!document.querySelector('meta[name="character-library"]');
    if (!isCLPage) return;
    console.debug('[CL-JanitorBridge] active on Character Library page');

    // Hard allowlist: the ONLY things this bridge is permitted to fetch.
    const ALLOWED = [
        { prefix: 'https://janitorai.com/hampter/', host: 'janitorai.com' },
        { prefix: 'https://jannyai.com/characters/', host: 'jannyai.com' },
    ];
    // Returns the matched allowlist rule, or null. The prefix compares against the NORMALIZED
    // origin+pathname (dot segments already resolved), not the raw string: a raw startsWith
    // would let "/hampter/../" escape the allowed prefix at request time.
    function allowedRule(url) {
        if (typeof url !== 'string') return null;
        let u;
        try { u = new URL(url); } catch { return null; }
        const normalized = u.origin + u.pathname;
        return ALLOWED.find(r => u.hostname === r.host && normalized.startsWith(r.prefix)) || null;
    }

    const gmRequest = (typeof GM_xmlhttpRequest === 'function')
        ? GM_xmlhttpRequest
        : (typeof GM !== 'undefined' && GM.xmlHttpRequest ? GM.xmlHttpRequest.bind(GM) : null);

    // Clearance refresh can only ever target these roots, never a caller-supplied URL.
    const CLEARANCE_URLS = {
        'janitorai.com': 'https://janitorai.com/',
        'jannyai.com': 'https://jannyai.com/characters/',
    };
    // Clearance is POLLED for, never waited out on a timer. A fixed wait made the request that
    // triggered the refresh retry on a guess: it fired before Cloudflare had issued the cookie and
    // failed, while every later request succeeded. Polling means the reply only comes back once the
    // cookie demonstrably works, so the caller's single retry always lands on a cleared session.
    // Poll fast and close the moment clearance lands: the tab is visible in the tab strip while
    // it exists, so its lifetime is the whole UX cost. A managed challenge usually clears in a
    // couple of seconds, so the common case is a tab that appears and vanishes.
    const CLEARANCE_POLL_MS = 600;
    const CLEARANCE_FIRST_POLL_MS = 1200;
    const CLEARANCE_MAX_MS = 30000;
    const CLEARANCE_GRACE_MS = 400;
    let clearanceBusy = false;

    // Mirrors isCloudflareBlockPage in provider-utils.js. Duplicated deliberately: the userscript
    // is a separate execution context and cannot import from the page's modules.
    function looksChallenged(status, body) {
        if (status === 403 || status === 503) return true;
        return /Just a moment|__cf_chl|cf-error-details|Attention Required! \| Cloudflare/i.test((body || '').slice(0, 2000));
    }

    function refreshClearance(id, host) {
        const target = CLEARANCE_URLS[host];
        if (!target) { reply(id, false, 0, 'Blocked: host not in the clearance allowlist'); return; }
        if (typeof GM_openInTab !== 'function') { reply(id, false, 0, 'Userscript manager does not expose GM_openInTab'); return; }
        if (!gmRequest) { reply(id, false, 0, 'Userscript manager does not expose GM_xmlhttpRequest'); return; }
        if (clearanceBusy) { reply(id, false, 0, 'A clearance refresh is already running'); return; }
        clearanceBusy = true;

        let tab = null;
        try {
            // active:false keeps focus with the user; insert/setParent keep the tab adjacent so a
            // manager that ignores the auto-close still leaves something obvious to shut.
            tab = GM_openInTab(target, { active: false, insert: true, setParent: true });
        } catch (e) {
            clearanceBusy = false;
            reply(id, false, 0, `Could not open a refresh tab: ${e.message}`);
            return;
        }

        const started = Date.now();
        const finish = (ok, note) => {
            // Small grace period so the cookie is committed before the caller retries.
            setTimeout(() => {
                try { tab?.close?.(); } catch { /* manager may have closed it already */ }
                clearanceBusy = false;
                reply(id, ok, ok ? 200 : 0, note);
            }, ok ? CLEARANCE_GRACE_MS : 0);
        };

        const poll = () => {
            if (Date.now() - started > CLEARANCE_MAX_MS) {
                finish(false, 'Cloudflare did not clear within the timeout');
                return;
            }
            gmRequest({
                method: 'GET',
                url: target,
                headers: { 'Accept': 'text/html,application/xhtml+xml' },
                timeout: 8000,
                onload: (r) => {
                    if (!looksChallenged(r.status, r.responseText)) finish(true, 'clearance confirmed');
                    else setTimeout(poll, CLEARANCE_POLL_MS);
                },
                onerror: () => setTimeout(poll, CLEARANCE_POLL_MS),
                ontimeout: () => setTimeout(poll, CLEARANCE_POLL_MS),
            });
        };
        setTimeout(poll, CLEARANCE_FIRST_POLL_MS);
    }

    function reply(id, ok, status, body) {
        window.postMessage({ source: SCRIPT_SRC, type: 'result', id, ok, status, body }, location.origin);
    }

    function announce() {
        // `caps` lets CL skip features an older installed script cannot serve, instead of
        // waiting out a timeout on a message that will never be answered.
        window.postMessage({
            source: SCRIPT_SRC,
            type: 'ready',
            version: '1.3.0',
            caps: { clearance: typeof GM_openInTab === 'function' },
        }, location.origin);
    }

    window.addEventListener('message', (e) => {
        // Origin-guarded rather than e.source === window: under an Xray wrapper the sandbox window
        // is not identity-equal to the page window, so the identity check would drop every message.
        if (e.origin !== location.origin) return;
        const msg = e.data;
        if (!msg || msg.source !== PAGE_SRC) return;

        if (msg.type === 'ping') {
            announce();
            return;
        }
        if (msg.type === 'clearance') {
            if (msg.id) refreshClearance(msg.id, msg.host);
            return;
        }
        if (msg.type !== 'fetch') return;

        const { id, url, authToken } = msg;
        if (!id) return;
        if (!gmRequest) { reply(id, false, 0, 'Userscript manager does not expose GM_xmlhttpRequest'); return; }
        const rule = allowedRule(url);
        if (!rule) { reply(id, false, 0, 'Blocked: URL not in the bridge allowlist'); return; }

        // hampter is a JSON API; the jannyai character pages are HTML documents
        const headers = { 'Accept': rule.host === 'jannyai.com' ? 'text/html,application/xhtml+xml' : 'application/json' };
        // The Bearer is the JanitorAI session; it must never travel to the other host.
        if (rule.host === 'janitorai.com' && typeof authToken === 'string' && authToken) headers['Authorization'] = `Bearer ${authToken}`;

        gmRequest({
            method: 'GET',
            url,
            headers,
            timeout: 20000,
            onload: (r) => reply(id, r.status >= 200 && r.status < 300, r.status, r.responseText || ''),
            onerror: () => reply(id, false, 0, 'Network error'),
            ontimeout: () => reply(id, false, 0, 'Timed out'),
        });
    });

    // Announce on load; CL also pings, so the handshake works whichever side is ready first.
    announce();
})();
