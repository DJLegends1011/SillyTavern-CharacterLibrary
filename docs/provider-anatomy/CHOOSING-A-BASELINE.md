# Choosing a Baseline Provider — Selection & Cloning Playbook

This is the entry point that ties the per-provider anatomy docs together. When
a new bot-hosting site is proposed, use this doc to pick the existing provider
that is the closest framework, then clone it 1:1 and only reroute it to the new
site before adding anything distinctive.

Anatomy docs this links to:
[chub](./chub.md) · [botbooru](./botbooru.md) · [chartavern](./chartavern.md) ·
[datacat](./datacat.md) · [pygmalion](./pygmalion.md) · [wyvern](./wyvern.md) ·
[janny](./janny.md). Comparison matrix lives in [README](./README.md).

## The workflow

1. **Propose.** You say "can we implement `<site>`".
2. **Recon + match (Claude).** Claude answers the decision inputs below for the
   target site, scores each provider as a baseline candidate, and recommends a
   single best baseline (plus a runner-up) with reasons, linking the anatomy
   doc for each.
3. **Approve (you).** Nothing is cloned until you approve the baseline pick.
4. **Clone 1:1.** Copy the chosen provider's folder and rename every identifier
   to the new site. The clone must stay byte-for-behavior identical to the
   original **except** endpoint hosts/paths and provider identity. No feature
   changes in this pass.
5. **Wire the cable if needed.** If the site can't be done browser-side, add a
   `cl-helper` route modeled on the matching existing route (see "The cable"
   below) — same as datacat and botbooru.
6. **Verify parity.** Browse, preview, import, link, and update must work and
   look like the baseline (see "Verification gate").
7. **Extend.** Only after parity is proven do we add distinctive features, the
   way each vanilla provider ends up distinct.

## Step 2 — decision inputs (recon the target first)

Answer these about the new site before picking a baseline. Each answer pushes
toward a specific provider.

| Question | Why it matters | Pushes toward |
| --- | --- | --- |
| Can the browser fetch data directly or via SillyTavern `/proxy/`? | If yes, no cable needed | chub, wyvern, janny |
| Is login required for useful browse? | Public-first is simplest | botbooru, chartavern, datacat (anon) |
| What is the auth type? | Determines login plumbing | token paste → chub/botbooru; cookie → chartavern; IdP/JWT → wyvern; server-side exchange → pygmalion; anon session token → datacat |
| Does login need a form-encoded body or forbidden headers (`Origin`/`Referer`)? | Browser can't send these → needs a login cable | botbooru (form body), pygmalion (forbidden headers) |
| Cloudflare / bot challenge on required data? | Needs FlareSolverr-style path | datacat |
| What is the data shape? | Decides mapping work | ready V2 cards → botbooru; embedded PNG → chartavern/chub; REST JSON needing remap → chub/wyvern/pygmalion; aggregator/extraction → datacat; HTML/app-shell scrape → janny |
| Save/favorites model? | Few baselines support it | account-backed CL favorites → chub; provider-native favorites → botbooru; follow-only → wyvern/pygmalion; none → chartavern/janny/datacat |
| Gallery support? | Copy a gallery-capable baseline | chub, botbooru, wyvern |
| Canonical character ID format? | Drives `parseUrl`/`canHandleUrl` | per anatomy doc |

## Step 2 — selection matrix (decisive trait → baseline)

Pick by the **network + auth + data model**, not by how the site looks. Use the
first row that matches.

| If the target site is… | Copy this baseline | Anatomy |
| --- | --- | --- |
| Public REST aggregator with rich browse **and** account-backed favorites/follows | **chub** | [chub.md](./chub.md) |
| Public-first and already serves `chara_card_v2` cards; optional token auth; maybe a non-JSON login | **botbooru** | [botbooru.md](./botbooru.md) |
| Public read-only with a JSON search API + embedded-PNG cards; login is an optional cookie that only widens content | **chartavern** | [chartavern.md](./chartavern.md) |
| Aggregator/extraction across upstreams; needs a server proxy with forged headers, a server-minted session, awkward decoding, or Cloudflare bypass | **datacat** | [datacat.md](./datacat.md) |
| Public browse but login is a server-side credential exchange (forbidden headers) | **pygmalion** | [pygmalion.md](./pygmalion.md) |
| Public REST, browser-reachable, optional IdP/JWT token auth, no server plugin | **wyvern** | [wyvern.md](./wyvern.md) |
| Cloudflare-protected app-shell (Astro/Next) with no clean detail API; read-only, no auth | **janny** | [janny.md](./janny.md) |

If two rows tie, prefer the simpler baseline (fewer cl-helper routes) unless a
hard blocker (CORS, Cloudflare, forbidden headers) forces the heavier one.

## The cable (cl-helper) — when and which to model on

A new provider needs a `cl-helper` route only when the browser genuinely can't
do the job. Three baselines need no cable at all (chub, wyvern, janny). When
you do need one, model it on the closest existing route and keep it narrow
(hostname + path allowlist, validated body, no open proxy):

| The site needs… | Model the route on | Example route |
| --- | --- | --- |
| Login with a form-encoded body that ST's JSON proxy mangles | botbooru | `POST /botbooru-login` |
| Login that requires forbidden `Origin`/`Referer` headers | pygmalion | `POST /pyg-login` |
| A pasted session **cookie** passed through + read-only proxy | chartavern | `ct-set-cookie`, `ct-session`, `ct-proxy/*` |
| Server-minted session token + extraction + body decode + Cloudflare bypass | datacat | `dc-init`, `dc-session`, `dc-extract`, `dc-proxy/*`, `saucepan-proxy/*`, `flaresolverr-fetch` |
| Nothing (browser-side `fetchWithProxy` is enough) | — | no cable |

## Step 4 — clone & rename (keep it 1:1)

Copy the baseline folder, then rename **every** identifier so no stale name
survives, changing behavior nowhere except the endpoints/host:

- filenames (`<old>-api.js` → `<new>-api.js`, etc.)
- class names, provider `id`, display `name`, icon
- extension metadata key, DOM ID prefix, CSS prefix, setting keys, log prefixes
- endpoint constants / base URLs / paths → the new site (the **only** behavioral change)
- URL parser names + the ID format in `canHandleUrl`/`parseUrl`
- test filenames + fixtures

Then wire the shared entry points (none of these are optional — the provider
won't appear until they're done):

- `modules/module-loader.js` — provider CSS + import
- `modules/providers/provider-registry.js` — only if the generic registry can't carry it
- `app/library.js` — hardcoded provider lists, settings controls, filters, search prefixes, extension keys, import/link routing
- `extras/cl-helper/index.js` — only if "the cable" above is required
- `README.md` — provider matrix, after it's real

Parity rule: every control, modal shell, card field, and stat slot from the
baseline stays identical unless the target site has no equivalent data — in
which case render an explicit unavailable state, don't silently simplify.

## Step 6 — verification gate (before any custom features)

"It works" means, against the **live** site, matching the baseline:

- provider shows in the selector; topbar/search/cards match baseline density
- clicking a real rendered card opens the preview in the same modal shell
- import produces a valid V2 card; "In Library" shows; link metadata exists
- "Check for Updates" returns sane diffs
- pasting a site URL routes to the provider
- `node --test`, `node --check` on the new files, and `git diff --check` pass

Record which checks passed and which weren't run. Do not start Step 7 until
this gate is green.

## Step 7 — adding distinctive features

Only after 1:1 parity is verified. New features (extra filters, account sync,
provider-native saves, galleries) follow the same evidence rule as the rest of
the set: back every change with a site observation or a test, and prefer
extending the cloned contract over forking shared renderers. This is how each
vanilla provider ends up distinct without breaking the shared UI.
