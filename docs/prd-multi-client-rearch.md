# PRD: Multi-Client Re-Architecture of the `pi` Harness System

> Status: Draft · Owner: Cole · Type: Architecture
> Scope: `pi` (harness), `pi-web`, `pi-tui`

## Problem Statement

I have three separate, non-versioned project directories — `pi` (the harness/engine), `pi-web` (browser UI), and `pi-tui` (terminal UI). The harness is a long-lived daemon on `:5179` holding all live agent state; the two frontends are thin clients that talk to it over a bespoke HTTP + WebSocket protocol.

The system works when it's just me, alone, on localhost, with one client at a time. But the architecture has three structural problems that make it fragile and slow to evolve:

1. **The protocol is tribal knowledge copied into three places.** The harness emits 8 event-type strings (`hello`, `typing`, `delta`, `step`, `usage`, `subagent`, `done`, `error`) and accepts one inbound shape (`{type:"user",project,text}`). These exact strings are re-hardcoded by hand in `pi-web/public/index.html`, `pi-web/public/harness.html`, and `pi-tui/src/app.mjs` — plus `pi-web/server.mjs` special-cases `hello` and the HTTP proxy path set. There is no version field and no shared definition. Renaming or adding an event silently breaks both clients with no way to detect the mismatch.

2. **State lives only in RAM, but the SDK already persists it to disk.** The harness always calls `SessionManager.create()` (a fresh session) on every lead spin-up — including after a process restart or a settings change. It never uses `SessionManager.continueRecent()`. So conversation memory is silently wiped on every restart, even though "persistent session" is the whole pitch, and `getMessages()` (built for reconnect backscroll) returns `[]` forever afterward. The architecture and the storage layer disagree about who owns the truth.

3. **The design assumes one client, but I want multiple.** I want `pi-web` and `pi-tui` attached to the *same live session simultaneously* — co-driving one agent. Today a late joiner gets nothing useful (no backscroll, no in-flight state), a slow client can balloon server memory unbounded, and there is no auth on a channel that drives an **unsandboxed shell**.

On top of the structural issues, a prior review surfaced concrete bugs that this re-arch should absorb (see Further Notes).

## Solution

Consolidate the three directories into **one pnpm workspace** and re-shape the system around a **shared, versioned protocol** and a **reconstructable harness** that treats on-disk sessions as the source of truth.

From my perspective as the user:

- I open `pi-web` in a browser and `pi-tui` in a terminal, both pointed at the same harness. **Both show the same conversation, live.** Either one can send a prompt; the other sees the agent respond in real time.
- If a client **joins mid-turn**, it immediately gets the full backscroll *and* the currently-streaming partial output — no blank screen, no waiting for the next turn.
- If I **restart the harness** or **change a setting**, nothing is lost. Clients reconnect and see their real history.
- A **dropped connection** (laptop sleep, wifi blip, closed tab) never crashes the harness or degrades the other clients.
- The harness requires a **shared-secret token** to connect, so a random browser tab can't silently drive my shell.
- Adding or changing a protocol event means editing **one package**; both frontends pick up the typed definition and the version bumps.

## User Stories

1. As a developer, I want `pi-web` and `pi-tui` to be members of a single pnpm workspace alongside the harness, so that shared code lives in one place and I run one install.
2. As a developer, I want a shared `@pi/protocol` package that defines every event type and message shape once, so that the clients stop re-hardcoding strings.
3. As a developer, I want the protocol package to validate messages at runtime (zod), so that a malformed frame is rejected with a clear error instead of corrupting client state.
4. As a developer, I want a versioned `hello` handshake, so that a client connecting to an incompatible harness is told so instead of silently mis-parsing events.
5. As a developer, I want a tiny typed client SDK in `@pi/protocol`, so that `pi-web` and `pi-tui` stop hand-rolling `ws` glue and HTTP fetch wrappers.
6. As a user, I want the harness to resume the most recent on-disk session for a project instead of creating a new one, so that my conversation survives restarts and settings changes.
7. As a user, I want `getMessages()` to return real history after a restart, so that reconnecting shows my backscroll.
8. As a user, I want to attach a second client to a live session and immediately see the full conversation history, so that I can switch devices without losing context.
9. As a user, I want a client that joins mid-turn to receive the in-flight streaming buffer, so that I see the response currently being generated, not a blank turn.
10. As a user, I want any attached client to be able to send a prompt, so that I can drive the agent from whichever surface is in front of me.
11. As a user, I want to see prompts and responses from *other* attached clients, so that co-driving one agent from two surfaces stays coherent.
12. As a user, I want to cancel an in-flight turn, so that a stuck or wrong-headed run can be stopped without restarting the whole process.
13. As a user, I want a dropped or flaky client connection to never crash the harness, so that one bad socket doesn't take down every project for every client.
14. As a user, I want a slow client to be capped and evicted rather than allowed to balloon server memory, so that one stalled tab can't degrade the harness.
15. As a user, I want one client's send failure to not block event delivery to the other clients, so that fan-out is resilient.
16. As a user, I want a shared-secret token required on both the WS upgrade and the mutating HTTP routes, so that only my trusted clients can drive the agent.
17. As a developer, I want a transient lead-creation failure to be retried on the next prompt instead of permanently bricking the project, so that a momentary auth blip is self-healing.
18. As a developer, I want agent sessions and their subscriptions to be disposed when replaced, so that toggling settings or running many subagents doesn't leak sessions and listeners.
19. As a user, I want tool execution to report both start and end (with args and success/failure), so that clients can show what a tool did and whether it worked.
20. As a developer, I want subagent runs to use ephemeral in-memory sessions, so that delegated digs don't litter the project's session directory with throwaway files.
21. As a developer, I want the "pure core" harness to not call `process.exit()`, so that it can be embedded and tested independently of the service process.
22. As a developer, I want a named decision about where sandboxing lives (per-project sandbox), so that the security boundary is deliberate even if implemented later.
23. As a developer, I want the protocol package's message contracts covered by tests, so that a breaking change to the wire format is caught before it ships.
24. As a developer, I want the harness's state-reconstruction logic (resume vs create) covered by tests, so that the "restart is a non-event" guarantee doesn't silently regress.
25. As a developer, I want the three directories under version control, so that this re-arch and future changes have history.

## Implementation Decisions

### Repository / workspace
- **Consolidate into one pnpm workspace** rooted at `the repo root`. Add real `packages:` globs to `pnpm-workspace.yaml` (currently it has none — it only pins build/release settings, so it is not actually a multi-package workspace today).
- Promote the harness from a bare subdir of the `pi-lead` package into its own workspace package (e.g. `@pi/harness`). Fold `pi-web` → `@pi/web` and `pi-tui` → `@pi/tui` as workspace members. Replace their separate lockfiles (`pi-web` uses npm, `pi-tui` uses its own pnpm lock) with the single workspace lockfile.
- **Language stays plain `.mjs` (ESM), no TypeScript build step.** The codebase is 100% `.mjs` with no `tsconfig` and no build pipeline; introducing TS is explicitly out of scope. Types come from **zod schemas (runtime) + JSDoc annotations (editor hints)**, which give validation and autocomplete without a compile step.

### `@pi/protocol` package (the backbone)
- Owns the single source of truth for the wire contract:
  - The set of **event types** and their payload shapes (currently `hello`, `typing`, `delta`, `step`, `usage`, `subagent`, `done`, `error` — extended below).
  - The **inbound message types** (currently just `user`; extended with `abort` below).
  - **zod schemas** for every message, used by both the harness (validate inbound, shape outbound) and the client SDK (validate inbound).
  - A **`PROTOCOL_VERSION`** constant included in the `hello` frame; the client SDK refuses / warns on a version mismatch.
- Exposes a **thin typed client SDK**: connect (with token), auto-reconnect, typed `on(eventType, handler)` subscription, and typed senders (`sendUser`, `sendAbort`). Both frontends consume this instead of hand-rolling `ws` + `fetch`. This replaces the duplicated protocol switch in `index.html`, `harness.html`, and `app.mjs`, and the HTTP proxy/endpoint lists in `server.mjs` and `harnessClient.mjs`.

### Protocol extensions
- **Versioned `hello`**: `{type:"hello", version, projects}`.
- **New inbound `abort`**: `{type:"abort", project}` → cancels the in-flight turn for that project.
- **Tool lifecycle**: keep `step`/`start` but add a paired **tool-end** event carrying `toolCallId`, `args` (on start), and `result`/`isError` (on end), so clients can correlate and show success/failure. `step` currently forwards only `toolName`.
- **In-flight resume frame**: when a client attaches, after `hello` the harness sends the project's **backscroll** followed by a **resume frame** describing any turn currently streaming (accumulated partial text + which tool is running), so a mid-turn joiner is fully caught up.

### Harness state model (reconstructable, not authoritative)
- **On-disk SDK sessions are the source of truth.** The in-memory lead map becomes a **lazily-rebuilt cache**.
- On lead spin-up, use **`SessionManager.continueRecent(project.dir)`** when prior history exists, falling back to `create()` only for a genuinely new project. Restart and settings changes must **not** wipe conversation memory.
- On attach / `getMessages()`, return real history sourced from the resumed session.
- **Fix the poisoned-cache bug**: on a rejected lead-creation promise, evict it from the cache so the next prompt retries cleanly instead of bricking the project forever.
- **Lifecycle**: capture the `subscribe()` unsubscribe handle and call `AgentSession.dispose()` when a lead is replaced (settings change) or a subagent run completes. No more leaked sessions/listeners.
- **Subagents** use an **ephemeral in-memory session** (`SessionManager.inMemory`) instead of `create()`, so delegated runs don't persist throwaway session files.
- **Cancellation**: wire `abort` through to `AgentSession.abort()` for the project's live turn.
- **Core stays pure**: replace the direct `process.exit(1)` on startup failure with a thrown error; the service process decides whether to exit.

### Multi-client semantics
- **Prompt ownership**: *all* attached clients may send prompts freely. No driver/turn-ownership concept in v1.
- **Fan-out**: events broadcast to all attached clients for the project. Each `ws.send` is individually guarded (try/catch) so one failing socket never aborts delivery to the others or escapes as an unhandled rejection.
- **Backpressure**: before sending, check `ws.bufferedAmount` against a cap; a client that exceeds it is **evicted** (closed) rather than allowed to accumulate unbounded buffer. (Buffer-cap-and-evict; a resync on reconnect restores it.)
- **Connection hardening**: every client socket gets a `ws.on("error", …)` handler so a dropped/flaky connection is contained, never process-fatal.

### Auth & security boundary
- **Shared-secret token** required on both the **WS upgrade** and the **mutating HTTP routes** (`POST /config`, `POST /projects`). Read-only routes may stay open on loopback, or also require the token (decide during build; default to requiring it everywhere).
- **Sandboxing is a named, deferred decision**: the target is a **per-project sandbox** (e.g. container) around the unsandboxed `bash`/`edit`/`write` tools. Not built in this PRD, but the boundary is documented so it isn't retrofitted blindly. `addProject` should also restrict accepted directories to a configured root.

### API contract summary (post-change)
- **HTTP** (token-gated where mutating): `GET /health`, `GET|POST /config`, `GET /manifest?project=`, `GET /messages?project=`, `GET|POST /projects`.
- **WS inbound**: `user`, `abort`.
- **WS outbound**: `hello` (versioned), `history`/backscroll, `resume` (in-flight), `typing`, `delta`, `step`/tool-start, `tool-end`, `usage`, `subagent`, `done`, `error`.

## Testing Decisions

- **What makes a good test here**: assert *external behavior* at a module's interface, not internals. For the protocol, that means "a valid frame round-trips and an invalid frame is rejected." For the harness, that means "after a simulated restart, history is preserved" — observed through the public surface (`getMessages`, emitted events), not by inspecting private maps.
- **`@pi/protocol` is the primary test target** (it's a deep module with a small, stable, high-value interface):
  - Every message schema accepts its valid shape and rejects malformed input.
  - Version-mismatch handling in the client SDK.
  - Encode/decode round-trips for each event type.
- **Harness state-reconstruction** is the second target:
  - New project → `create`; existing project with history → `continueRecent`; history survives a simulated respawn.
  - Rejected lead-creation is evicted (next call retries, not bricked).
  - `abort` cancels the in-flight turn.
- **Prior art / runner**: no test setup exists in any dir today. `pi-tui` already lists `ink-testing-library` as a devDependency, implying a Node-based runner is acceptable — standardize on **`node:test`** (built-in, no new heavy dep) for the protocol and harness packages.
- **Frontend UI is not unit-tested** in this PRD beyond the shared client SDK; the SDK's typed surface is what carries coverage.

## Out of Scope

- **TypeScript migration / any build step.** Stays plain `.mjs` + zod + JSDoc.
- **Actually implementing the sandbox** (containerization of tool execution). The boundary is named and deferred to a follow-up.
- **Multi-tenant / multi-user auth** (accounts, per-user tokens, RBAC). A single shared secret is the ceiling for v1 — this is still a personal tool.
- **Driver/turn-ownership or presence UI** (who's typing, locking). v1 is all-clients-can-drive, no presence.
- **Deploying to `ash` / exposing beyond localhost + tailnet.** No public exposure in this PRD.
- **Rewriting the frontends' visual design.** Only their protocol/transport layer changes (swap hand-rolled glue for the SDK).
- **Persistence of anything beyond what the SDK's `SessionManager` already stores on disk.**

## Further Notes

Known bugs from a prior review that this re-arch folds in (cited as motivation, not as separate scope):

- **Crash on any dropped connection** — no `ws.on("error")` on client sockets; an unhandled `'error'` event kills the whole process. → Fixed by connection hardening.
- **Silent conversation-memory loss on restart/settings change** — `SessionManager.create()` used on every respawn instead of `continueRecent()`. → Fixed by the reconstructable-state model.
- **Permanent project brick on one transient failure** — a rejected `createLead()` promise is cached forever. → Fixed by evict-on-reject.
- **Session/listener leak** — `AgentSession.dispose()` and the `subscribe()` unsubscribe handle are never called. → Fixed by lifecycle management.
- **One bad client aborts fan-out** — `ws.send()` loop has no try/catch, exception escapes as unhandled rejection. → Fixed by per-send guarding.
- **No cancel/abort** in the protocol; **`tool_execution_end` never routed**; **subagents use `create()` not `inMemory()`**. → Fixed by protocol extensions + subagent session change.

Additional context:
- Current SDK: `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` both at **0.81.1**; Node **≥ 22.19**.
- The three dirs are **not git repos**. Recommend `git init` (single monorepo repo at `the repo root` after consolidation) before starting, so the re-arch has history.
- Suggested phasing: (1) workspace consolidation + `git init`; (2) `@pi/protocol` + swap both frontends onto the SDK (kills duplication, adds versioning); (3) reconstructable harness state + lifecycle/bug fixes; (4) multi-client attach semantics (backscroll + resume frame, backpressure); (5) auth token; (6) [follow-up] per-project sandbox.
