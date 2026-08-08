# Saucepan Hidden Definition Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact, single-card Saucepan extraction for hidden companions whose creators allow custom providers, using an isolated one-use listener and temporary Cloudflare Quick Tunnel.

**Architecture:** A focused cl-helper module owns prompt parsing, the one-use OpenAI-compatible listener, `cloudflared` startup, Saucepan temporary provider/chat/generation calls, and cleanup. The browser provider calls this helper only after an explicit locked-card CTA, merges the captured Core/example dialogue with existing Saucepan metadata, and reuses the resulting V2 card for import.

**Tech Stack:** Node.js 22 ESM, built-in `node:http`, `node:crypto`, `node:child_process`, built-in `node:test`, existing SillyTavern cl-helper Express router, browser ES modules.

## Global Constraints

- Work only when the creator/provider profile permits custom providers.
- Extract one selected companion per run; no bulk route or queue.
- Keep captured definitions in memory only and never log their content or secrets.
- Expose only a dedicated loopback listener, never the SillyTavern HTTP server.
- Require an installed `cloudflared`; do not install or bundle it.
- Attempt every cleanup step after success, failure, timeout, or cancellation.
- Preserve existing direct and partial Saucepan extraction behavior.

---

### Task 1: Prompt parser and one-use listener

**Files:**
- Create: `extras/cl-helper/saucepan-hidden-extraction.js`
- Create: `extras/cl-helper/test/saucepan-hidden-extraction.test.js`
- Modify: `extras/cl-helper/package.json`

**Interfaces:**
- Produces: `canUseSaucepanCustomProvider(profile: string): boolean`
- Produces: `parseSaucepanCapturedMessages(messages: Array<{role:string,content:string}>): { core:string, exampleDialogue:string, greeting:string }`
- Produces: `createSaucepanCaptureListener(options?): Promise<{ port:number, providerPath:string, apiKey:string, waitForCapture():Promise<object>, close():Promise<void> }>`

- [ ] **Step 1: Add failing parser tests**

```js
test('parses core, example dialogue, and starting message', () => {
    const result = parseSaucepanCapturedMessages([
        { role: 'system', content: 'wrapper\n[ Background ]\nCORE\n[ Example Dialogue ]\nEXAMPLE\n[ User Description ]\nUSER' },
        { role: 'assistant', content: 'GREETING' },
        { role: 'user', content: 'hi' },
    ]);
    assert.deepEqual(result, { core: 'CORE', exampleDialogue: 'EXAMPLE', greeting: 'GREETING' });
});

test('rejects missing or reordered markers', () => {
    assert.throws(() => parseSaucepanCapturedMessages([
        { role: 'system', content: '[ Background ]\nCORE\n[ User Description ]\nUSER' },
    ]), /marker/i);
});
```

- [ ] **Step 2: Run the parser tests and verify they fail**

Run: `node --test extras/cl-helper/test/saucepan-hidden-extraction.test.js`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement strict marker parsing and provider-policy checks**

```js
const CUSTOM_PROVIDER_PROFILES = new Set([
    'custom_and_vetted',
    'vetted_only_owner_bypass',
    'internal_only_owner_bypass',
]);

export function canUseSaucepanCustomProvider(profile) {
    return CUSTOM_PROVIDER_PROFILES.has(profile);
}
```

Parse only the first system message, require the three markers in ascending order, trim section edges, require a non-empty Core, and take the first assistant message before the temporary `hi` as the greeting.

- [ ] **Step 4: Add failing listener tests**

Use a real loopback listener and Node `fetch` to verify:

```js
assert.equal((await fetch(baseUrl)).status, 404);
assert.equal((await fetch(captureUrl, { method: 'POST', body: '{}' })).status, 401);
assert.equal((await authorizedPost(captureUrl, validBody)).status, 200);
assert.equal((await authorizedPost(captureUrl, validBody)).status, 410);
```

Add separate JSON and `stream: true` assertions, plus a body-limit assertion.

- [ ] **Step 5: Implement the minimal one-use listener**

Bind `node:http` to `127.0.0.1` and port `0`. Generate independent 32-byte path and bearer secrets. Accept exactly one authorized JSON `POST`, enforce a 4 MiB limit and 30-second timeout, resolve `waitForCapture()` with the parsed JSON, then reject replays with `410`. Return either a normal OpenAI completion or two SSE chunks followed by `[DONE]`.

- [ ] **Step 6: Run the listener tests**

Run: `node --test extras/cl-helper/test/saucepan-hidden-extraction.test.js`
Expected: all parser, policy, listener, SSE, replay, and size-limit tests pass.

- [ ] **Step 7: Add the helper test script and commit**

```json
"scripts": {
  "test": "node --test test/*.test.js"
}
```

```bash
git add extras/cl-helper/package.json extras/cl-helper/saucepan-hidden-extraction.js extras/cl-helper/test/saucepan-hidden-extraction.test.js
git commit -m "add Saucepan capture parser and listener"
```

### Task 2: Quick Tunnel and Saucepan lifecycle

**Files:**
- Modify: `extras/cl-helper/saucepan-hidden-extraction.js`
- Modify: `extras/cl-helper/test/saucepan-hidden-extraction.test.js`

**Interfaces:**
- Consumes: `createSaucepanCaptureListener()` and `parseSaucepanCapturedMessages()`
- Produces: `startCloudflaredQuickTunnel({ port, command?, spawnImpl?, timeoutMs? }): Promise<{ url:string, close():Promise<void> }>`
- Produces: `extractSaucepanHiddenDefinition({ token, companionId, fetchImpl?, openCapture?, openTunnel? }): Promise<{ assembled:Record<string,string>, greeting:string }>`

- [ ] **Step 1: Write failing tunnel parser tests**

Inject a fake child process whose stderr emits the real banner shape:

```text
Your quick Tunnel has been created!
https://example-random.trycloudflare.com
```

Assert URL resolution, startup timeout, early process exit, and idempotent `close()`.

- [ ] **Step 2: Run the tunnel tests and verify they fail**

Run: `node --test extras/cl-helper/test/saucepan-hidden-extraction.test.js`
Expected: FAIL because `startCloudflaredQuickTunnel` is not exported.

- [ ] **Step 3: Implement Quick Tunnel startup**

Spawn `process.env.CLOUDFLARED_PATH || 'cloudflared'` with:

```js
['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate']
```

Parse stdout and stderr, accept only `https://*.trycloudflare.com`, reject after 25 seconds, translate `ENOENT` into an install/prerequisite error, and terminate the process during cleanup.

- [ ] **Step 4: Write failing lifecycle/cleanup tests**

Inject `fetchImpl`, `openCapture`, and `openTunnel`. Assert this request sequence and bodies:

1. `GET /api/v2/companions/{id}`
2. `POST /api/v1/openai_provider/config`
3. `POST /api/v1/core/create-chat`
4. `POST /api/v2/chat/generate` with `generation_config: { openaiprovider: { config_id } }`
5. cleanup `POST /api/v2/chat/cancel` when a generation ID exists
6. cleanup `DELETE /api/v1/chat` with `{ chat_id }`
7. cleanup `DELETE /api/v1/openai_provider/config` with `{ config_id }`

Repeat with failures after each creation step and assert that all available cleanup handles are still attempted.

- [ ] **Step 5: Implement the Saucepan lifecycle**

Use `https://saucepan.ai` and bearer authentication. Fail closed unless `providers_profile` passes `canUseSaucepanCustomProvider`. Create the provider with:

```js
{
    config_name: 'Character Library temporary capture',
    provider: 'custom',
    model_id: 'cl-capture',
    api_key: capture.apiKey,
    temperature: 1,
    is_visible: false,
    provider_prompt: null,
    provider_post_history_prompt: null,
    context_length: 32000,
    provider_url: `${tunnel.url}${capture.providerPath}`,
    use_chat_temperature_override: false,
}
```

Create a chat with the first scenario ID, send `hi`, wait for the capture, parse it, and always run cancel/chat/provider/tunnel/listener cleanup in independent guarded blocks.

- [ ] **Step 6: Run all helper tests and commit**

Run: `npm test --prefix extras/cl-helper`
Expected: all tests pass.

```bash
git add extras/cl-helper/saucepan-hidden-extraction.js extras/cl-helper/test/saucepan-hidden-extraction.test.js
git commit -m "add Saucepan hidden extraction lifecycle"
```

### Task 3: cl-helper route

**Files:**
- Modify: `extras/cl-helper/index.js`
- Modify: `extras/cl-helper/test/saucepan-hidden-extraction.test.js`

**Interfaces:**
- Consumes: `extractSaucepanHiddenDefinition({ token, companionId })`
- Produces: `POST /api/plugins/cl-helper/saucepan-extract-hidden` with `{ companionId }`

- [ ] **Step 1: Add validation and concurrency tests**

Export a small `createSaucepanHiddenExtractionHandler` factory from the helper module so tests can call it with a fake extractor. Assert missing token -> 401, malformed UUID -> 400, second concurrent request -> 409, success -> 200, and extractor error -> mapped JSON error without secret content.

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test --prefix extras/cl-helper`
Expected: FAIL because the handler factory is not implemented.

- [ ] **Step 3: Implement and register the route**

Import the factory in `extras/cl-helper/index.js`, pass a token getter rather than the token value, and register the handler inside `registerSaucepanRoutes`. Never log the request result.

- [ ] **Step 4: Run tests and syntax checks**

Run: `npm test --prefix extras/cl-helper`
Run: `node --check extras/cl-helper/index.js`
Run: `node --check extras/cl-helper/saucepan-hidden-extraction.js`
Expected: all commands succeed.

- [ ] **Step 5: Commit the route**

```bash
git add extras/cl-helper/index.js extras/cl-helper/test/saucepan-hidden-extraction.test.js
git commit -m "expose Saucepan hidden extraction route"
```

### Task 4: Browser opt-in and card import

**Files:**
- Modify: `modules/providers/saucepan/saucepan-api.js`
- Modify: `modules/providers/saucepan/saucepan-provider.js`
- Modify: `modules/providers/saucepan/saucepan-browse.js`

**Interfaces:**
- Produces: `submitSaucepanExtraction(url, { allowPartial, allowHiddenCapture })`
- Produces: `fetchSaucepanV2Card(hit, { allowHiddenCapture })`
- Consumes: cl-helper response `{ assembled, greeting }`
- Consumes: provider option `{ prebuiltCard }`

- [ ] **Step 1: Add the gated client extraction path**

Keep `allowHiddenCapture` false by default. Only when the direct response is locked, the Core is empty, and the companion policy permits custom providers, post `{ companionId }` to `/saucepan-extract-hidden`. Merge only `Companion Core` and `Example Dialogue`; use the captured greeting only when the normal greeting list is empty.

- [ ] **Step 2: Add an explicit locked-card CTA**

For eligible locked cards, render copy explaining that extraction creates temporary Saucepan state and passes the prompt through a short-lived Cloudflare tunnel to the local helper. The CTA calls `fetchSaucepanV2Card(hit, { allowHiddenCapture: true })`, paints the returned card, caches it as `hit._v2Card`, and enables Import. Keep the existing partial-import CTA for ineligible cards or capture failures.

- [ ] **Step 3: Reuse the captured card during import**

Pass `{ prebuiltCard: hit._v2Card }` from the browse import flow. In `saucepan-provider.js`, skip a second extraction when `prebuiltCard?.data` exists, then continue avatar/gallery/import handling unchanged.

- [ ] **Step 4: Run client and helper syntax checks**

Run: `node --check modules/providers/saucepan/saucepan-api.js`
Run: `node --check modules/providers/saucepan/saucepan-provider.js`
Run: `node --check modules/providers/saucepan/saucepan-browse.js`
Run: `npm test --prefix extras/cl-helper`
Expected: all commands succeed.

- [ ] **Step 5: Commit browser integration**

```bash
git add modules/providers/saucepan/saucepan-api.js modules/providers/saucepan/saucepan-provider.js modules/providers/saucepan/saucepan-browse.js
git commit -m "add opt-in Saucepan hidden card import"
```

### Task 5: Documentation, verification, and draft PR

**Files:**
- Modify: `README.md`
- Modify: `extras/cl-helper/README.md` if present

**Interfaces:**
- Documents: creator-policy boundary, one-card scope, `cloudflared` prerequisite, tunnel privacy model, and cleanup behavior.

- [ ] **Step 1: Update user-facing documentation**

Add a concise Saucepan locked-definition note: eligible cards show an opt-in extraction button, creator-disallowed cards remain partial-only, `cloudflared` must be installed or set through `CLOUDFLARED_PATH`, and definitions are not persisted by CharacterLibrary.

- [ ] **Step 2: Run complete verification**

Run:

```bash
npm test --prefix extras/cl-helper
node --check extras/cl-helper/index.js
node --check extras/cl-helper/saucepan-hidden-extraction.js
node --check modules/providers/saucepan/saucepan-api.js
node --check modules/providers/saucepan/saucepan-provider.js
node --check modules/providers/saucepan/saucepan-browse.js
git diff --check main...HEAD
git status --short
```

Expected: tests and syntax checks pass, no whitespace errors, and only intended files are changed.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md extras/cl-helper/README.md
git commit -m "document Saucepan hidden extraction limits"
```

- [ ] **Step 4: Push and open a draft PR**

Push `codex/saucepan-hidden-extraction` to the fork and open a draft PR against `Sillyanonymous/SillyTavern-CharacterLibrary:main`. The PR body must identify the live proof, policy limitation, Quick Tunnel behavior, test commands, and that the draft needs maintainer validation before merge.
