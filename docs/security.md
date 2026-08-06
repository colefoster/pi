# Security model

The harness drives an **unsandboxed** coding agent (bash/edit/write) over a
network API. Treat the harness port as a trust boundary.

## Auth (shared secret)

Set **`HARNESS_TOKEN`** to require a shared secret on the harness:

- Every HTTP route except `GET /health` returns `401` without it.
- The WebSocket upgrade is rejected (close code `1008`) without it.
- Accepted as `Authorization: Bearer <token>`, an `x-pi-token` header, or a
  `?token=` query param (browsers can't set headers on a WebSocket).

When `HARNESS_TOKEN` is **unset**, auth is OFF and the harness logs a warning.
That's acceptable only on a trusted localhost box — never when the port is
exposed (`HARNESS_HOST=0.0.0.0`).

Who supplies the token:

- **TUI** → talks to the harness directly; reads `HARNESS_TOKEN` from its env
  (via the protocol client) for both WS and HTTP.
- **Web** → the browser talks to the web server (same origin, localhost) and
  never sees the token. The web server is a trusted client that holds
  `HARNESS_TOKEN` and injects it on every hop to the harness (proxy + upstream
  WS). Set the same `HARNESS_TOKEN` in the web server's env.

## Project root allowlist

Set **`PI_PROJECT_ROOT`** to restrict `addProject` to directories under that
root, so the control API can't point an agent at `~/.ssh` or `/`. Unset = no
restriction (any existing directory).

## Backpressure

The event stream evicts a client whose outbound buffer exceeds
`HARNESS_WS_MAX_BUFFER` (default 4 MB); it resyncs on reconnect. The web bridge
does the same for browser sockets (`WEB_WS_MAX_BUFFER`).

## Deferred: per-project sandbox

The next security step (not yet implemented) is a **per-project sandbox** — run
each project's tool execution inside a container/jail so a compromised or
mis-instructed agent can't touch the host beyond its project dir. The shared
secret gates *who* can drive the agent; the sandbox would limit *what* a driven
agent can do. Tracked as a follow-up.
