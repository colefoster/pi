# pi

A **thin, single-agent harness** on top of the [pi](https://pi.dev) agent SDK, running on
your **ChatGPT/Codex subscription** (no per-token API billing). One agent per repo, each
with its own persistent pi session, all streaming independently — reachable from a browser
or the terminal.

It's deliberately 1-ply: no lead persona, no subagents, no orchestration opinion baked in.
**The editable surface is the system prompt and the tool set** — everything else is plumbing.

## The surface you edit

- **System prompt** → `system-prompt.md` at the repo root. This file *is* the prompt. Edit it
  freely. A `.pi-prompt.md` inside any project's own directory overrides it for that repo;
  otherwise `system-prompt.md` is used everywhere. Placeholders `{dir}` (project's absolute
  path) and `{tools}` (active tool list) are interpolated. If neither file exists, a tiny
  built-in fallback is used. Changes apply to the next agent spawn (a settings change respawns
  all agents; otherwise the next new one picks it up).
- **Tools** → `settings.json` `"tools"` array. Pick any subset of the menu:
  `read · bash · edit · write · grep · find · ls`. Editable at runtime via `POST /config`.
- **Model / thinking** → `settings.json` (or the ⚙ Settings UI). Validated and persisted.

That's the whole opinion. The persona, the toolset, the reasoning level — all yours to change
in two files.

## One-time setup

**Log pi into your ChatGPT subscription** (device-code, works over SSH). Your shell aliases
`pi` to `pnpm install`, and `pnpm exec pi` trips pnpm's dep-check — so call the binary directly:

```bash
cd /Users/cole/Dev/pi
./node_modules/.bin/pi          # launches pi's TUI
# then inside pi:  type  /login  → pick "ChatGPT Plus/Pro (Codex)"  → follow the code flow
# quit pi once it says you're logged in
```

Credentials land in `~/.pi/agent/auth.json` and auto-refresh. The harness reads them automatically.

## Architecture

One pnpm workspace, split by concern:

- **`harness/`** (`@pi/harness`) — the standalone agent service. Owns the pi model runtime, the
  agents (one session per repo), settings, and the projects registry. Exposes an HTTP control
  API (`/config`, `/projects`, `/manifest`, `/messages`, `/health`) and a WS that streams
  tagged lifecycle events. Knows nothing about browsers.
  - `harness/harness.mjs` — pure orchestration core; emits events, no networking.
  - `harness/service.mjs` — the HTTP + WS face of that core (auth, backpressure, resume).
  - `harness/agentCache.mjs` — lazily-created one-agent-per-repo cache (create-once,
    evict-on-reject, dispose-on-clear).
- **`protocol/`** (`@pi/protocol`) — the single source of truth for the wire vocabulary:
  versioned events + message builders (dependency-free browser entry) and zod schemas (node).
- **`web/`** (`@pi/web`) — browser UI. A thin edge that serves `public/` and proxies + bridges
  to the harness over HTTP/WS. All agent logic lives in the harness, not here.
- **`tui/`** (`@pi/tui`) — terminal client. A peer of the web app: same protocol, same harness.

`projects.json` and `settings.json` live at the repo root and are owned by the harness
(gitignored runtime state).

## Run

Your global pnpm config is hardened (supply-chain policy) and its pre-run check hard-fails on
two transitive ignored-build deps, so **don't use `pnpm dev`** — run node directly.

**Harness** (required):

```bash
cd /Users/cole/Dev/pi
node harness/service.mjs        # harness API + event WS on :5179
```

**Web UI** (another terminal):

```bash
node web/server.mjs            # web app on :5178, reaches harness via HARNESS_URL
# open http://localhost:5178
```

**TUI** (alternative client):

```bash
node tui/cli.mjs               # terminal client against the same harness
```

On startup the harness prints the models your subscription exposes. Confirmed available on your
sub: `gpt-5.6-sol/luna/terra`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`.
To seed a different default:

```bash
PI_MODEL=gpt-5.4-mini node harness/service.mjs
```

## Auth

Set `HARNESS_TOKEN` to gate the harness: every HTTP route (except `/health`) and the WS upgrade
then requires it — as `Authorization: Bearer`, an `x-pi-token` header, or a `?token=` query. The
web bridge holds the token and injects it on every hop, so browsers never see it. Unset =
auth off (a loud warning prints; fine for trusted localhost only). Set `PI_PROJECT_ROOT` to
restrict which directories can be registered as projects. See `docs/security.md`.

## Repos / agents

Each repo is an agent in the client's sidebar. The list lives in **`projects.json`** (auto-seeded
with `vgc-engine` on first run). Add more:

- **In the UI** — **＋ Add repo**, paste a path (`~` is fine), give it a name. Its agent spins up
  lazily on first message.
- **By hand** — add `{ "id": "<abs-dir>", "name": "...", "dir": "<abs-dir>" }` to `projects.json`
  (`id` must equal the absolute dir) and refresh.

Agents are independent: fire one in `vgc-engine`, switch repos, fire a second — both run at once,
each with its own chat and a busy indicator while working.

## Config reference

The env vars below are just the **defaults** — `settings.json` overrides them once you've changed
anything in the UI or the file.

| var | default | meaning |
|-----|---------|---------|
| `PROJECT_DIR` | `/Users/cole/Dev/vgc-engine` | **seed** repo written to a fresh `projects.json` |
| `PI_MODEL` | `gpt-5.6-sol` | Codex model id (see startup log) — seeds `settings.json` |
| `PI_PROVIDER` | `openai-codex` | subscription provider — seeds `settings.json` |
| `PI_THINKING` | `medium` | reasoning level — seeds `settings.json` |
| `PI_VALIDATE` | (unset) | `1` = assert every outbound frame against the protocol schema (dev) |
| `PORT` | `5178` | web app port (frontend) |
| `HARNESS_PORT` | `5179` | harness service port (API + event WS) |
| `HARNESS_HOST` | `127.0.0.1` | harness bind host (set `0.0.0.0` only to expose deliberately) |
| `HARNESS_URL` | `http://localhost:5179` | where the web app reaches the harness |
| `HARNESS_TOKEN` | (unset) | shared-secret auth; unset = auth off (localhost only) |
| `PI_PROJECT_ROOT` | (unset) | if set, only dirs under it can be registered as projects |

## Next

- **Docker sandbox** — pi has no built-in permission system; don't run `bash` unsandboxed on a VPS.
- Per-project prompt/tool presets, if the single agent proves worth specializing per repo.
