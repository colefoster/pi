# pi-lead

An IM-style **"lead"** dev agent. You message it like a busy teammate; it does full-fidelity
work with tools under the hood and replies in 1–3 sentences. Built on the
[pi](https://pi.dev) agent SDK, running on your **ChatGPT/Codex subscription** (no per-token API billing).

A **sidebar of leads** — one per repo, each with its own persistent pi session, all
streaming independently. No subagents, no sandbox yet — the point is to feel the core.

## One-time setup

**1. Log pi into your ChatGPT subscription** (device-code, works over SSH).
Your shell aliases `pi` to `pnpm install`, and `pnpm exec pi` trips pnpm's dep-check —
so call the binary directly:

```bash
cd /Users/cole/Dev/pi
./node_modules/.bin/pi          # launches pi's TUI
# then inside pi:  type  /login  → pick "ChatGPT Plus/Pro (Codex)"  → follow the code flow
# quit pi once it says you're logged in
```

Credentials land in `~/.pi/agent/auth.json` and auto-refresh. The harness reads them automatically.

## Architecture

Two repos, split by concern. **This repo is the harness only** — the browser UI
lives next door in [`../pi-web`](../pi-web) and talks to the harness over HTTP/WS.

- **`harness/`** — the standalone agent service. Owns the pi model runtime, the
  leads (one session per repo), subagents, settings, and the projects registry.
  Exposes an HTTP control API (`/config`, `/projects`, `/manifest`, `/health`) and a
  WS that streams tagged lifecycle events. Knows nothing about browsers.
  - `harness/harness.mjs` — pure orchestration core; emits events, no networking.
  - `harness/service.mjs` — the HTTP + WS face of that core.
- **`../pi-web`** — the web app (separate repo). Serves its own `public/`, proxies the
  control API to the harness, and bridges browser WebSockets to the harness event
  stream. It's a thin edge; all agent logic lives here in the harness.

`projects.json` and `settings.json` live at the repo root and are owned by the harness.

## Run

Your global pnpm config is hardened (supply-chain policy) and its pre-run check
hard-fails on two transitive ignored-build deps, so **don't use `pnpm dev`** — run node directly.

**Harness** (this repo):

```bash
cd /Users/cole/Dev/pi
node harness/service.mjs        # harness API + event WS on :5179
```

**Web UI** (separate repo — run in another terminal):

```bash
cd /Users/cole/Dev/pi-web
node server.mjs                 # web app on :5178, reaches harness via HARNESS_URL
# open http://localhost:5178
```

The web app defaults to `HARNESS_URL=http://localhost:5179`; point it elsewhere to
run the harness on another box.

On startup it prints the models your subscription exposes. Confirmed available on your sub:
`gpt-5.6-sol/luna/terra`, `gpt-5.5`, `gpt-5.4`, **`gpt-5.4-mini`** (← the cheap one for future subagents),
`gpt-5.3-codex-spark`. To use a different one:

```bash
PI_MODEL=gpt-5.4-mini node harness/service.mjs
```

## Repos / leads

Each repo is a "lead" in the left sidebar. The list lives in **`projects.json`** (auto-seeded
with `vgc-engine` on first run). Two ways to add more:

- **In the UI** — click **＋ Add repo**, paste a path (`~` is fine), give it a name. It's saved
  to `projects.json` and its lead spins up lazily on first message.
- **By hand** — add `{ "id": "<abs-dir>", "name": "...", "dir": "<abs-dir>" }` to `projects.json`
  (`id` must equal the absolute dir) and refresh.

Leads are independent: fire one in `vgc-engine`, switch to another repo, fire a second — both
run at once, each with its own chat and a green dot in the sidebar while working.

## Config

Model and thinking level are editable at runtime from the **⚙ Settings** modal — the
dropdowns are populated from the models your subscription actually exposes (`GET /config`)
and a change is `POST`ed straight to the server (`POST /config`). It's validated
(`getModel` must resolve; thinking must be one of `off · minimal · low · medium · high ·
xhigh · max`), persisted to **`settings.json`**, and takes effect on each repo's **next
message** (cached leads are dropped and respawn with the new model/level; an in-flight
reply finishes on its old settings).

The env vars below are just the **defaults** — `settings.json` overrides them once you've
changed anything in the UI.

| var | default | meaning |
|-----|---------|---------|
| `PROJECT_DIR` | `/Users/cole/Dev/vgc-engine` | **seed** repo written to a fresh `projects.json` |
| `PI_MODEL` | `gpt-5.6-sol` | Codex model id (see startup log) — seeds `settings.json` |
| `PI_PROVIDER` | `openai-codex` | subscription provider — seeds `settings.json` |
| `PI_THINKING` | `medium` | reasoning level — seeds `settings.json` |
| `PORT` | `5178` | web app port (frontend) |
| `HARNESS_PORT` | `5179` | harness service port (API + event WS) |
| `HARNESS_URL` | `http://localhost:5179` | where the web app reaches the harness |

## What to poke at

- Does the **terse tone** feel right, or too clipped? → tweak `leadPrompt()` in `harness/harness.mjs`.
- Per-response status line shows **steps · time · tokens** (and `N agents` once subagents exist).

## Next (after the spike proves out)

- Subagents via the `pi-subagents` extension (delegate heavy work → the `agents` counter lights up).
- **Docker sandbox** — pi has no built-in permission system; don't run `bash` unsandboxed on a VPS.
- Your OTP auth for hosting on ash.
