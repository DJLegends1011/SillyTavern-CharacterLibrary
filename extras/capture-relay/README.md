# Capture relay

Some sites (Harpy, Saucepan) hide a character's definition but still send it, inside the chat
prompt, to any custom OpenAI-compatible endpoint you configure on the site. Their **server**
sends it, not your browser, so whatever receives it must be reachable from the internet.

Character Library handles that by itself in **built-in** mode: cl-helper opens a short-lived
tunnel (localhost.run over your system `ssh`, or `cloudflared` if you already have it) for the
few seconds an extraction takes. Run this relay instead when you would rather not use a
third-party tunnel, or when neither works on your network: put it on any host that already has a
public HTTPS address (a VPS, a home server behind your own domain, a named tunnel) and point
Character Library at it (**Settings → Online → Harpy → Capture receiver**, mode **Relay**).

It is a reference implementation. The protocol is four plain HTTP routes, so a Cloudflare Worker
or anything else that speaks them works just as well.

## Run it

```bash
node run-relay.mjs
```

Node 22+, no dependencies. It prints the relay URL and relay key to paste. Leave it running.

Env: `PORT` (8787), `BIND`, `RELAY_KEY` (random each start unless set), `PUBLIC_URL` (the HTTPS
address to print), `TTL_SECONDS` (300), `MAX_SLOTS` (64).

In a container:

```bash
RELAY_KEY=<long random string> PUBLIC_URL=https://relay.example.com docker compose up -d --build
```

**Serve it over HTTPS.** Sites may refuse a plain-http endpoint. Terminate TLS in a reverse proxy
(Caddy, nginx) in front of it, or publish it through a named tunnel, and set `BIND=127.0.0.1` so
only that proxy reaches it.

## Protocol

| Route | Who | What |
|---|---|---|
| `GET /health` | cl-helper | `{"ok":true,"relay":"cl-capture-relay"}`, used to recognise a relay |
| `GET /c/<slot>/v1/models` | the site | one model, `cl-capture` |
| `POST /c/<slot>/v1/chat/completions` | the site | stores the request body, answers `CL_CAPTURE_OK` (streamed if asked) |
| `GET /api/capture/<slot>` | cl-helper | `200 {body, apiKey, receivedAt}` once, then forgets it; `204` if nothing yet |
| `DELETE /api/capture/<slot>` | cl-helper | drop an unread capture |

`<slot>` is 64 hex characters that cl-helper generates per extraction. The `/api` routes need
`Authorization: Bearer <relay key>`. The first prompt to a slot wins; captures expire after the TTL.

## Security

- The relay sees what the site sends: the character's definition and one throwaway API key per
  extraction. It never sees your SillyTavern, your chats or your site login.
- Anyone who can reach it can **send** to a slot, which is why slots are 256-bit random and
  bodies are capped at 4 MB, 64 slots, 5 minutes. Only the relay key can **read**.
- Treat the relay key like a password. Set `RELAY_KEY` rather than pasting the random one into
  scripts, and rotate it by restarting with a new value.
