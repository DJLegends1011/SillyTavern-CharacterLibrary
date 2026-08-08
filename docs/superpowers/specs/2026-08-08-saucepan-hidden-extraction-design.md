# Saucepan Hidden Definition Extraction Design

## Context

Saucepan's direct definition endpoint omits the Companion Core when a creator hides a definition. Saucepan does, however, send the complete assembled prompt to a custom OpenAI-compatible provider when the companion creator has enabled custom providers.

An authenticated live proof confirmed that a hidden-definition companion with custom providers enabled sends an OpenAI request containing:

- a system message with the Companion Core and example dialogue;
- the selected starting message as an assistant message; and
- the temporary user message.

The system prompt uses stable section markers: `[ Background ]`, `[ Example Dialogue ]`, and `[ User Description ]`. Saucepan rejects loopback/private provider URLs, so the capture listener must be temporarily reachable through a public URL.

## Goals

- Extract one selected Saucepan companion for local SillyTavern import.
- Work only when the creator has enabled custom providers.
- Reuse the authenticated Saucepan token already held by `cl-helper`.
- Create only temporary Saucepan state and remove it unconditionally.
- Keep captured definition data in memory only.
- Keep the change small and isolated to the existing Saucepan provider and helper.

## Non-goals

- No bulk extraction or background crawling.
- No attempt to bypass `vetted_only` or `internal_only` provider policies.
- No publishing, caching, feed, or redistribution mechanism.
- No exposure of the SillyTavern HTTP server through the tunnel.
- No bundled tunnel binary or automatic software installation.

## Eligibility

The companion detail response must indicate that custom providers are allowed. The UI and helper must fail closed if the policy is absent or does not permit custom providers.

Public/open definitions continue to use the existing direct extraction endpoint. The capture path is only a fallback for hidden definitions.

## Architecture

`cl-helper` owns the complete temporary lifecycle:

1. Validate the Saucepan token, companion ID, and creator provider policy.
2. Start a dedicated HTTP listener on a random loopback port.
3. Generate independent high-entropy path and bearer secrets.
4. Start an installed `cloudflared` executable as a Quick Tunnel targeting only that listener.
5. Parse the generated `trycloudflare.com` URL from process output.
6. Create a temporary Saucepan custom provider using the one-use capture URL.
7. Create a temporary Saucepan chat for the selected companion.
8. Generate one response with the temporary provider and the message `hi`.
9. Capture one OpenAI-compatible request and immediately close the capture session.
10. Parse the Companion Core, example dialogue, and starting message.
11. In `finally`, cancel outstanding generation if necessary, delete the temporary chat and provider, stop `cloudflared`, and close the listener.

The helper returns extracted fields to the existing Saucepan card builder. Images, public metadata, tags, and other fields continue to come from the existing Saucepan detail/definition requests.

## Capture Listener

The listener is not the SillyTavern server. It binds to `127.0.0.1` on an ephemeral port and is the only origin exposed by the tunnel.

It must:

- accept one exact random path ending in `/v1/chat/completions`;
- require an independent random bearer token;
- accept only `POST` with JSON;
- enforce a small request-body limit and timeout;
- store at most one request in memory;
- support both JSON and SSE OpenAI-compatible responses;
- return a harmless `CL_CAPTURE_OK` completion; and
- reject every other request with no identifying data.

## Parsing and Card Mapping

For the captured `messages` array:

- `messages[0].content` is the assembled system prompt.
- Companion Core is the text after `[ Background ]` and before `[ Example Dialogue ]`.
- Example dialogue is the text after `[ Example Dialogue ]` and before `[ User Description ]`.
- The initial assistant message is the starting message already present before the temporary `hi`.

Parsing must validate all markers and fail rather than importing a platform wrapper or user persona as character data.

The parsed fields map to the existing character-card fields:

- Companion Core -> `description`
- example dialogue -> `mes_example`
- starting assistant message -> `first_mes`

The existing public companion description remains available as card metadata, not as a substitute for the Core.

## Security and Privacy

- One extraction at a time per helper process.
- Random secrets are generated for every extraction and never logged.
- Captured prompt content is never logged or written to disk.
- Tunnel URL, provider ID, chat ID, and generation ID exist only for the active session.
- Cleanup runs after success, failure, timeout, cancellation, or malformed payload.
- The endpoint refuses cards whose creator did not allow custom providers.
- The UI explains that the definition passes through a temporary Cloudflare tunnel to the user's local helper.

## Failure Handling

Errors should distinguish:

- custom providers not permitted for this companion;
- `cloudflared` missing or not executable;
- tunnel startup timeout;
- Saucepan provider/chat/generation failure;
- capture timeout;
- malformed or unparseable prompt; and
- cleanup failures.

Cleanup failures are reported without discarding a successfully captured card, but all cleanup steps are attempted independently.

## Testing

- Unit tests for prompt marker parsing and malformed prompt rejection.
- Unit tests for the one-use listener: method, path, bearer, body limit, JSON response, SSE response, and replay rejection.
- Unit tests for lifecycle cleanup using mocked Saucepan requests and a mocked tunnel process.
- Existing direct and partial Saucepan extraction behavior must remain unchanged.
- Syntax checks and the repository's available test command run before publishing.

## Delivery

The first pull request is intentionally a draft. Its description will include the live proof, creator-policy limitation, `cloudflared` prerequisite, privacy model, and any endpoints that still need maintainer confirmation.
