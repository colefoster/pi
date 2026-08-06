# pi-tui

A terminal client for the **pi harness** — a peer to the web app. Chat with the agent,
switch repos, watch streaming output, and tweak model/thinking without a browser.

It speaks the harness's HTTP + WebSocket protocol directly (default `:5179`), the
same one the web app uses. No build step — plain Node ESM + [Ink](https://github.com/vadimdemedes/ink)
(via `htm` tagged templates).

## Run

```bash
# harness must be running first (in ../pi):
#   node harness/service.mjs

pnpm install
node cli.mjs
# or, against a remote/proxied harness:
HARNESS_URL=http://localhost:5178 node cli.mjs
```

## Keys

| key | action |
|-----|--------|
| type + Enter | message the active agent |
| Tab / Shift+Tab | switch repo |
| ↑ / ↓ | scroll the conversation (2 rows) |
| PgUp / PgDn | scroll a page; sending snaps back to the live tail |
| Ctrl+N | add a repo |
| Ctrl+O | change model / thinking |
| Ctrl+G | inspector (tools + system prompt) |
| Ctrl+C | quit (cancels an open modal first) |

Background repos whose agent replies while you're elsewhere get a **magenta ●**
unread badge in the sidebar (busy agents show a **yellow ●**). A dropped harness
shows an offline banner and auto-reconnects.

## How it works

- One WebSocket to the harness. Events are broadcast to every client, so each
  event is filtered by its `project` field into a per-repo session slice.
- Turn lifecycle per repo: `typing → delta/step/usage → done|error`.
  `delta` text streams into the live agent bubble; `done` finalizes it.
- On selecting a repo, history is loaded via `GET /messages?project=<id>` (added
  to the harness for backscroll — a fresh WS otherwise only sees future events).
- An agent is single-flight: sending while it's busy is blocked client-side and by
  the harness.

`HARNESS_URL` — harness base URL (default `http://localhost:5179`).
