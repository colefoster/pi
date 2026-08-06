// pi harness service — the network face of the harness core.
// HTTP: GET/POST /config, GET/POST /projects, GET /manifest, GET /messages, GET /health.
// WS:   client sends { type:"user", project, text }; server streams the tagged
//       lifecycle events (hello/typing/step/usage/delta/done/error).
// The web app is the only expected client; browsers never talk to this directly.

import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { PROTOCOL_VERSION, OUT, IN, msg, validateInbound } from "@pi/protocol";
import { createHarness } from "./harness.mjs";

const PORT = Number(process.env.HARNESS_PORT || 5179);
// Loopback-only by default (the web app connects via localhost). Set
// HARNESS_HOST=0.0.0.0 only if running the harness on a separate box.
const HOST = process.env.HARNESS_HOST || "127.0.0.1";

// Shared-secret auth. When HARNESS_TOKEN is set, every request (HTTP except
// /health, and the WS upgrade) must present it — as `Authorization: Bearer <t>`,
// an `x-pi-token` header, or a `?token=` query param (browsers can't set headers
// on a WebSocket). When unset, auth is OFF and we say so loudly — fine for a
// trusted localhost box, not for anything exposed.
const TOKEN = process.env.HARNESS_TOKEN || "";
if (!TOKEN) console.warn("[harness] ⚠ HARNESS_TOKEN not set — running WITHOUT auth (localhost only)");

function tokenFrom(req) {
  const auth = req.headers?.["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  const hdr = req.headers?.["x-pi-token"];
  if (typeof hdr === "string" && hdr) return hdr;
  try { return new URL(req.url, "http://localhost").searchParams.get("token") || ""; } catch { return ""; }
}
function authOk(req) {
  if (!TOKEN) return true;
  return tokenFrom(req) === TOKEN;
}

let harness;
try {
  harness = await createHarness();
} catch (e) {
  // The core throws on unrecoverable startup failure (e.g. bad model config);
  // the service is where we decide that's fatal to the process.
  console.error(`[harness] failed to start: ${e?.message ?? e}`);
  process.exit(1);
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

const httpServer = createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];

  if (url === "/health") return json(res, 200, { ok: true });

  // Everything else is behind the shared secret (no-op when auth is off).
  if (!authOk(req)) return json(res, 401, { error: "unauthorized" });

  if (url === "/config" && req.method === "GET")
    return json(res, 200, await harness.getConfig());
  if (url === "/config" && req.method === "POST") {
    try {
      const s = harness.applySettings(JSON.parse((await readBody(req)) || "{}"));
      return json(res, 200, { provider: s.provider, model: s.model, thinking: s.thinking, tools: s.tools });
    } catch (e) {
      return json(res, 400, { error: e?.message ?? String(e) });
    }
  }

  if (url === "/manifest" && req.method === "GET") {
    const q = new URL(req.url, "http://localhost").searchParams;
    return json(res, 200, await harness.getManifest(q.get("project")));
  }

  // Conversation backscroll for a project (empty until its agent has been used).
  if (url === "/messages" && req.method === "GET") {
    const q = new URL(req.url, "http://localhost").searchParams;
    return json(res, 200, await harness.getMessages(q.get("project")));
  }

  if (url === "/projects" && req.method === "GET") return json(res, 200, harness.listProjects());
  if (url === "/projects" && req.method === "POST") {
    try {
      const { list, project } = harness.addProject(JSON.parse((await readBody(req)) || "{}"));
      return json(res, 200, { list, project });
    } catch (e) {
      return json(res, 400, { error: e?.message ?? String(e) });
    }
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// ---- websocket: fan harness events out; route user turns in --------------
const clients = new Set();

// Per-project in-flight turn state, so a client that attaches mid-turn can be
// caught up on the live tail (backscroll history comes over HTTP /messages).
const live = new Map(); // projectId -> { text, tool }
function trackLive(obj) {
  switch (obj.type) {
    case OUT.TYPING: live.set(obj.project, { text: "", tool: null }); break;
    case OUT.DELTA: { const s = live.get(obj.project); if (s) s.text += obj.text; break; }
    case OUT.STEP: { const s = live.get(obj.project); if (s) s.tool = obj.tool; break; }
    case OUT.TOOL_END: { const s = live.get(obj.project); if (s) s.tool = null; break; }
    case OUT.DONE:
    case OUT.ERROR: live.delete(obj.project); break;
  }
}

// Evict a client whose outbound buffer blows past this rather than letting it
// grow without bound (a stalled tab shouldn't balloon harness memory). It
// resyncs on reconnect.
const MAX_BUFFERED = Number(process.env.HARNESS_WS_MAX_BUFFER || 4 * 1024 * 1024);

harness.events.on("event", (obj) => {
  trackLive(obj);
  const s = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      try { ws.close(); } catch {}
      clients.delete(ws);
      continue;
    }
    // One flaky client must never abort delivery to the rest, nor escape as
    // an unhandled rejection back through emit().
    try { ws.send(s); } catch { clients.delete(ws); }
  }
});

const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", (ws, req) => {
  // Reject the upgrade if the shared secret is wrong/absent (no-op when off).
  if (!authOk(req)) {
    try { ws.close(1008, "unauthorized"); } catch {}
    return;
  }
  clients.add(ws);
  // Without this, a dropped/reset socket emits 'error' with no listener, which
  // is fatal to the whole process (Node throws on unhandled 'error').
  ws.on("error", () => { clients.delete(ws); });
  ws.send(JSON.stringify(msg.hello(PROTOCOL_VERSION, harness.listProjects())));
  // Catch a late joiner up on any turn currently streaming.
  for (const [project, s] of live) {
    if (s.text || s.tool) {
      try { ws.send(JSON.stringify(msg.resume(project, s.text, s.tool))); } catch {}
    }
  }
  ws.on("close", () => clients.delete(ws));
  ws.on("message", (raw) => {
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { return; }
    const { ok, value } = validateInbound(frame);
    if (!ok) return; // ignore anything not a valid inbound message
    if (value.type === IN.USER) harness.prompt(value.project, value.text); // fire-and-forget; emits its own events
    else if (value.type === IN.ABORT) harness.abort(value.project);
  });
});

httpServer.listen(PORT, HOST, () => {
  const list = harness.listProjects();
  console.log(`[harness] ${list.length} project(s): ${list.map((p) => p.name).join(", ")}`);
  console.log(`[harness] service ready → http://localhost:${PORT}`);
});
