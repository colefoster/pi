// pi-lead harness service — the network face of the harness core.
// HTTP: GET/POST /config, GET/POST /projects, GET /manifest, GET /messages, GET /health.
// WS:   client sends { type:"user", project, text }; server streams the tagged
//       lifecycle events (hello/typing/step/usage/subagent/delta/done/error).
// The web app is the only expected client; browsers never talk to this directly.

import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { createHarness } from "./harness.mjs";

const PORT = Number(process.env.HARNESS_PORT || 5179);
// Loopback-only by default (the web app connects via localhost). Set
// HARNESS_HOST=0.0.0.0 only if running the harness on a separate box.
const HOST = process.env.HARNESS_HOST || "127.0.0.1";
const harness = await createHarness();

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

  if (url === "/config" && req.method === "GET")
    return json(res, 200, await harness.getConfig());
  if (url === "/config" && req.method === "POST") {
    try {
      const s = harness.applySettings(JSON.parse((await readBody(req)) || "{}"));
      return json(res, 200, { provider: s.provider, model: s.model, thinking: s.thinking, subagent: s.subagent });
    } catch (e) {
      return json(res, 400, { error: e?.message ?? String(e) });
    }
  }

  if (url === "/manifest" && req.method === "GET") {
    const q = new URL(req.url, "http://localhost").searchParams;
    return json(res, 200, await harness.getManifest(q.get("project")));
  }

  // Conversation backscroll for a project (empty until its lead has been used).
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
harness.events.on("event", (obj) => {
  const s = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState !== 1) continue;
    // One flaky client must never abort delivery to the rest, nor escape as
    // an unhandled rejection back through emit().
    try { ws.send(s); } catch { clients.delete(ws); }
  }
});

const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", (ws) => {
  clients.add(ws);
  // Without this, a dropped/reset socket emits 'error' with no listener, which
  // is fatal to the whole process (Node throws on unhandled 'error').
  ws.on("error", () => { clients.delete(ws); });
  ws.send(JSON.stringify({ type: "hello", projects: harness.listProjects() }));
  ws.on("close", () => clients.delete(ws));
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== "user" || !msg.text || !msg.project) return;
    harness.prompt(msg.project, msg.text); // fire-and-forget; it emits its own events
  });
});

httpServer.listen(PORT, HOST, () => {
  const list = harness.listProjects();
  console.log(`[harness] ${list.length} project(s): ${list.map((p) => p.name).join(", ")}`);
  console.log(`[harness] service ready → http://localhost:${PORT}`);
});
