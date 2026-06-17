# Provider Anatomy — Reference Set

This folder documents how each existing Character Library Online provider is
actually built, as raw material for writing/maintaining the "how to add a
provider" guide. Each provider has its own file following the same 12-section
template (overview, server plugin, auth, data source, browse/filtering,
preview, import/mapping, linking/updates, save/favorites, gallery, URL
handling, patterns worth copying).

These docs describe the code as it exists on the `codex/provider-guide-docs`
branch (CharacterLibrary v6.3.0 base). The **masquerade** provider is not on
this branch; it lives on `codex/masquerade-provider`.

## Comparison matrix

| Provider | cl-helper? | Auth model | Data source | Save / favorites | Gallery | Best copied when the target is… |
| --- | --- | --- | --- | --- | --- | --- |
| **chub** | No | Optional bearer token (`chubToken`), pasted from chub.ai localStorage | REST API → V4 git `card.json` → PNG extraction | **Yes — account-backed** favorites + full following manager | Yes | a public-REST aggregator with rich browse and server-side social (favorites/follows) |
| **botbooru** | Yes — 1 route (`/botbooru-login`, only because the auth body is form-encoded) | Anonymous SFW; token-only NSFW + personal (`botbooruToken` JWT) | Ready-made `chara_card_v2` cards (no field mapping) | No CL save; **token-only Botbooru favorites** + "My Favorites" view + following | Yes | a public-first site that already serves V2 cards, with optional token auth and a minimal non-JSON login |
| **chartavern** | Yes — auth only (`ct-*` routes; note "CharacterTavern" naming) | Optional session **cookie** (`ctCookie`), unlocks NSFW only | JSON search + embedded-V2 **PNG** cards on a CDN | No | a public read-only site with a JSON search API + PNG cards, where login is an optional cookie that only widens content |
| **datacat** | Yes — **heavy** (`/dc-init`, `/dc-session`, `/dc-extract`, `/dc-proxy/*`, + Saucepan + FlareSolverr) | Anonymous **server-side session token** (`datacatToken`), lazy re-bootstrap on 401/403 | Aggregator / on-demand extraction across multiple upstreams | No (local-only followed-creator list) | No | an aggregator/extraction source needing a server proxy with forged headers / a session the browser can't set / awkward decoding |
| **pygmalion** | Yes — **narrow** (`/pyg-login` only) | Optional Bearer **JWT**; login is a server-side credential exchange (forbidden `Origin`/`Referer`); creds in `pygmalionEmail`/`Password`/`Token` | Public REST (`server.pygmalion.chat`) | No (follow **authors**, not cards) | No | a site with public browse but whose login requires a server-side exchange / browser-forbidden headers |
| **wyvern** | No | Optional **Firebase** email/pw → JWT bearer (`wyvernToken`/`wyvernRefreshToken`) | Public REST, browser-reachable | No (follow creators only) | Check provider doc | the cleanest "no cl-helper, browser-side fetch, optional token auth" case |
| **janny** | No | None (public auto-scraped MeiliSearch key) | **Hybrid**: hosted MeiliSearch API for the grid + HTML/`astro-island` **scraping** for detail, behind a Cloudflare proxy ladder | No | No | a Cloudflare-protected app-shell (Astro/Next) site with no clean detail API; read-only, no auth, no gallery |

## Axis cheat-sheet (what the existing providers teach)

**Server plugin (cl-helper) — only when the browser genuinely can't do it.**
Three of seven avoid it entirely (chub, wyvern, janny). When it is used, the
scope is deliberately narrow:
- `botbooru` / `pygmalion` — **login only** (form-encoded body, or
  forbidden-header credential exchange); data still rides the browser proxy.
- `chartavern` — auth/session cookie pass-through, read-only allowlisted proxy.
- `datacat` — the full server-plugin case: session bootstrap, extraction,
  decoding, allowlisted proxy, plus Cloudflare (FlareSolverr) and
  body-decompress (Saucepan) helpers.

**Auth ladder, simplest → hardest:**
none (janny) → optional bearer token pasted by user (chub, botbooru) →
optional cookie pass-through (chartavern) → client-side IdP login (wyvern via
Firebase) → server-side credential exchange (pygmalion) → anonymous
server-minted session token (datacat).

**Data source spectrum:** ready V2 cards (botbooru) → embedded-PNG cards
(chartavern, partly chub) → clean REST JSON needing field remapping (chub,
wyvern, pygmalion) → aggregator/extraction (datacat) → HTML/page-prop scraping
(janny).

**Save-card support is rare.** Only **chub** offers account-backed favorites
through Character Library. botbooru exposes the *provider's* own favorites but
no CL save hook. Everyone else tops out at following creators/authors, or has
no save surface at all. This is the biggest gap a new provider's spec should
be explicit about.

**Following ≠ saving.** Several providers (chub, wyvern, pygmalion, botbooru)
implement a following manager for *creators*, which is separate from saving
*characters*. Don't conflate them when speccing a new provider.
