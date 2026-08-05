# Plan: Multi-Client Re-Architecture of the `pi` Harness System

> Source PRD: `docs/prd-multi-client-rearch.md`

Tracer-bullet phases. Phase 1 is a thin end-to-end proof through every layer (harness → `@pi/protocol` → both frontends); each later phase widens it. Codebase is plain `.mjs` ESM — no TypeScript, no build step; runtime validation via zod, editor hints via JSDoc; tests via `node:test`.

## Architectural decisions

Durable decisions that apply across all phases:

- **Monorepo**: single pnpm workspace rooted at `/Users/cole/Dev/pi`, under one git repo. Members: `@pi/harness` (promoted from the current `harness/` subdir), `@pi/web` (was `pi-web`), `@pi/tui` (was `pi-tui`), `@pi/protocol` (new). Single lockfile.
- **Protocol package** `@pi/protocol` is the single source of truth for the wire contract: event/message zod schemas, a `PROTOCOL_VERSION` constant, and a thin typed client SDK (connect+token, auto-reconnect, typed `on()`/senders). No hand-rolled `ws`/`fetch` glue or hardcoded event strings in any frontend.
- **Transport**: HTTP control API + WS event stream on `:5179` (unchanged port). Daemon stays.
  - **HTTP routes**: `GET /health`, `GET|POST /config`, `GET /manifest?project=`, `GET /messages?project=`, `GET|POST /projects`. Mutating routes (`POST`) are token-gated.
  - **WS inbound**: `user`, `abort`.
  - **WS outbound**: `hello` (versioned), backscroll/`history`, `resume` (in-flight), `typing`, `delta`, tool-start (`step`), tool-end, `usage`, `subagent`, `done`, `error`.
- **State model**: on-disk SDK sessions (`SessionManager.continueRecent`) are the source of truth; the in-memory lead map is a lazily-rebuilt cache. Restart/settings-change must not lose conversation history. Subagents use `SessionManager.inMemory`.
- **Multi-client**: all attached clients may drive (send prompts); events fan out to all clients for a project; per-`send` try/catch; slow clients evicted via `ws.bufferedAmount` cap (buffer-cap-and-evict).
- **Auth**: single shared-secret token on the WS upgrade and mutating HTTP routes. `addProject` restricted to a configured root. Per-project sandbox is named but deferred (follow-up, out of scope).
- **Language/tests**: `.mjs` ESM throughout; `node:test` runner (built-in). Primary test targets are `@pi/protocol` (schema round-trips, version mismatch) and harness state-reconstruction (resume-vs-create, evict-on-reject, abort).

---

## Phase 0: Consolidate + stabilize

**User stories**: 1, 13, 15, 25

### What to build

Bring the three sibling directories under one git repo and one pnpm workspace without changing behavior, then apply the two trivial crash-fixes so the system is stable to develop against for every later phase.

- `git init` a single repo at `/Users/cole/Dev/pi`; bring `pi-web` and `pi-tui` in as workspace members (drop their separate npm/pnpm lockfiles for the single workspace lockfile).
- Add real `packages:` globs to `pnpm-workspace.yaml`; promote `harness/` into a `@pi/harness` package. Give web/tui their `@pi/*` package names.
- Add `ws.on("error", …)` to every client socket, and wrap each `ws.send` in the fan-out loop in try/catch.

### Acceptance criteria

- [ ] One git repo at the workspace root with an initial commit; `.gitignore` covers `node_modules`, session/state dirs, secrets.
- [ ] `pnpm install` at the root resolves all members from a single lockfile.
- [ ] Harness, web, and tui all still start and behave exactly as before the move.
- [ ] Killing/dropping a client connection (closed tab, `kill` the tui) does **not** crash the harness.
- [ ] A failing `send` to one client does not abort delivery to the others and produces no unhandled rejection.

---

## Phase 1: Tracer bullet — `@pi/protocol` end-to-end (one event)

**User stories**: 2, 3, 4, 5 (partial)

### What to build

Stand up the `@pi/protocol` package and prove the full pipeline with the versioned handshake plus exactly one representative event, before migrating the rest.

- Create `@pi/protocol` exporting: `PROTOCOL_VERSION`, a zod schema for `hello` and for one event (e.g. `delta`), and a minimal typed client SDK (connect with token placeholder, `on(type, handler)`, one typed sender).
- Harness imports the `hello`/event definitions from `@pi/protocol` and emits them validated.
- Both frontends consume the SDK for the handshake and that one event only (leaving their existing switch in place for the others, temporarily).

### Acceptance criteria

- [ ] `@pi/protocol` is a workspace member imported by `@pi/harness`, `@pi/web`, and `@pi/tui`.
- [ ] The `hello` frame carries `PROTOCOL_VERSION`.
- [ ] Both frontends complete the handshake and render the one migrated event via the shared SDK (not their hand-rolled code path).
- [ ] `node:test` covers the two schemas: valid frames pass, malformed frames are rejected.

---

## Phase 2: Migrate the full event vocabulary

**User stories**: 2, 5

### What to build

Move the entire wire contract onto `@pi/protocol` and delete the duplicated protocol logic from all three frontends.

- Add zod schemas for every remaining event (`typing`, `step`, `usage`, `subagent`, `done`, `error`) and inbound `user` to `@pi/protocol`.
- Harness emits every event through the shared definitions; SDK dispatches all of them typed.
- Remove the hand-rolled event switches in `pi-web/public/index.html`, `pi-web/public/harness.html`, and `pi-tui/src/app.mjs`, and the duplicated endpoint/proxy lists in `server.mjs`/`harnessClient.mjs`.
- Client SDK warns/refuses on a `PROTOCOL_VERSION` mismatch in `hello`.

### Acceptance criteria

- [ ] No event-type string literals remain hardcoded in any frontend; all flow through `@pi/protocol`.
- [ ] A version mismatch surfaces a clear message instead of silent mis-parsing.
- [ ] Both frontends behave identically to Phase 0 (visual/behavioral parity) but on shared code.
- [ ] `node:test` covers round-trips for every event schema.

---

## Phase 3: Reconstructable harness state

**User stories**: 6, 7, 17, 18, 20, 21, 24

### What to build

Make on-disk sessions the source of truth so restarts and settings changes are non-events, and fix the lifecycle bugs in the same pass.

- Resume via `SessionManager.continueRecent(project.dir)` when history exists; `create()` only for genuinely new projects. `getMessages()` returns real history from the resumed session.
- Evict a rejected lead-creation promise from the cache so the next prompt retries.
- Capture the `subscribe()` unsubscribe handle and call `AgentSession.dispose()` when a lead is replaced or a subagent run ends. Subagents use `SessionManager.inMemory`.
- Core throws on startup failure instead of calling `process.exit`.

### Acceptance criteria

- [ ] Restarting the harness preserves conversation history; both clients show real backscroll on reconnect.
- [ ] Changing a setting does not wipe history.
- [ ] A simulated transient lead-creation failure self-heals on the next prompt (project not bricked).
- [ ] Subagent runs leave no persisted session files.
- [ ] `node:test` covers: new→`create`, existing→`continueRecent`, history survives a simulated respawn, evict-on-reject.

---

## Phase 4: Cancel + tool lifecycle

**User stories**: 12, 19

### What to build

Add turn cancellation and full tool-execution visibility, exercising the protocol's extensibility.

- Inbound `abort` (`{type:"abort", project}`) routes to `AgentSession.abort()` for that project's live turn.
- Emit paired tool events: start carries `toolCallId` + `args`; end carries `toolCallId` + `result`/`isError`.
- Both frontends: a stop/cancel control, and tool rows that show args + success/failure.

### Acceptance criteria

- [ ] Sending `abort` stops an in-flight turn without restarting the process.
- [ ] Clients can correlate a tool's start and end by `toolCallId` and show whether it succeeded.
- [ ] New protocol members are defined in `@pi/protocol` and validated.
- [ ] `node:test` covers `abort` cancelling the live turn.

---

## Phase 5: Multi-client attach semantics

**User stories**: 8, 9, 10, 11, 14

### What to build

Make two clients on one live session first-class: a late joiner catches up fully, and slow clients can't degrade the harness.

- On attach: after `hello`, send the project's backscroll, then a `resume` frame describing any in-flight turn (accumulated partial text + running tool) so a mid-turn joiner is caught up.
- Fan-out to all attached clients per project; before each send check `ws.bufferedAmount` against a cap and evict (close) a client that exceeds it. A reconnect re-syncs it.

### Acceptance criteria

- [ ] Attaching a second client mid-turn shows full history **and** the currently-streaming output.
- [ ] A prompt from either client is seen by both.
- [ ] A deliberately stalled client is evicted at the buffer cap and can rejoin cleanly on reconnect; other clients are unaffected.

---

## Phase 6: Auth token

**User stories**: 16, 22 (sandbox named/deferred)

### What to build

Put a shared-secret boundary in front of the daemon and restrict project roots.

- Require a shared-secret token on the WS upgrade and on mutating HTTP routes (`POST /config`, `POST /projects`); reject missing/invalid tokens. Read-only routes require it too by default.
- `addProject` accepts only directories under a configured root.
- Both frontends supply the token via the SDK.
- Document the per-project sandbox boundary as the named next step (not implemented here).

### Acceptance criteria

- [ ] A WS upgrade or mutating request without the correct token is rejected.
- [ ] Both frontends connect and drive the agent using the token.
- [ ] `addProject` refuses a directory outside the configured root.
- [ ] The sandbox decision is documented as a deferred follow-up.
