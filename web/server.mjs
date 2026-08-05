// pi-lead web app — serves the browser UI and bridges it to the harness service.
// Lives in its own repo (../pi); reaches the harness over HTTP/WS via HARNESS_URL.
// Static:  everything under ./public (index.html, tokens.css, …).
// HTTP:    /config, /projects, /manifest are proxied straight to the harness.
// WS:      browsers connect here; we keep ONE upstream WS to the harness, fan its
//          events out to every browser, and forward each browser's user turn upstream.
// The frontend is unchanged — it still talks to same-origin as before.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { PROTOCOL_VERSION, msg } from "@pi/protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
// The shared protocol package is served to the browser as static ESM so
// public/*.html can import the same vocabulary/client the node side uses. No
// build step: the browser entry (@pi/protocol/browser) is dependency-free.
const PROTOCOL_DIR = join(__dirname, "..", "protocol");

const PORT = Number(process.env.PORT || 5178);
// Bind loopback-only by default so the app is never exposed on the LAN/public
// interfaces — caddy (and local browsers) reach it via localhost; the tailnet
// reaches it through caddy. Set HOST=0.0.0.0 to expose it deliberately.
const HOST = process.env.HOST || "127.0.0.1";
const HARNESS_HTTP = (process.env.HARNESS_URL || "http://localhost:5179").replace(/\/$/, "");
const HARNESS_WS = HARNESS_HTTP.replace(/^http/, "ws");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css" };
const PROXY = new Set(["/config", "/projects", "/manifest", "/messages", "/health"]);

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

// Forward a control request to the harness, verbatim (path + query + body).
async function proxy(req, res) {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  try {
    const upstream = await fetch(HARNESS_HTTP + req.url, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
    res.end(text);
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "harness unreachable: " + (e?.message ?? e) }));
  }
}

const httpServer = createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (PROXY.has(url)) return proxy(req, res);

  // Serve the shared protocol tree (dependency-free browser ESM).
  if (url.startsWith("/protocol/")) {
    const rel = url.slice("/protocol/".length).replace(/\.\.+/g, ""); // no path traversal
    try {
      const buf = await readFile(join(PROTOCOL_DIR, rel));
      res.writeHead(200, { "content-type": MIME[extname(rel)] || "application/octet-stream" });
      return res.end(buf);
    } catch {
      res.writeHead(404);
      return res.end("not found");
    }
  }

  const file = url === "/" ? "/index.html" : url;
  try {
    const buf = await readFile(join(PUBLIC, file));
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

// ---- upstream: one persistent WS to the harness, auto-reconnecting -------
const browsers = new Set();
let upstream = null;

function broadcast(data) {
  for (const ws of browsers) {
    if (ws.readyState !== 1) continue;
    try { ws.send(data); } catch { browsers.delete(ws); }
  }
}
function connectUpstream() {
  upstream = new WebSocket(HARNESS_WS);
  upstream.on("open", () => console.log(`[web] connected to harness ${HARNESS_WS}`));
  upstream.on("message", (raw) => {
    // Harness sends its own per-connection "hello"; browsers get one synthesized
    // on connect, so drop the upstream one and forward everything else as-is.
    const s = raw.toString();
    try { if (JSON.parse(s)?.type === "hello") return; } catch { return; }
    broadcast(s);
  });
  upstream.on("close", () => {
    console.log("[web] harness connection closed — retrying in 1s");
    upstream = null;
    setTimeout(connectUpstream, 1000);
  });
  upstream.on("error", (e) => console.log("[web] harness ws error:", e?.message ?? e));
}
connectUpstream();

// ---- browsers: bridge each to the shared upstream ------------------------
const wss = new WebSocketServer({ server: httpServer });
wss.on("connection", async (ws) => {
  browsers.add(ws);
  // A dropped browser socket emits 'error' with no listener otherwise — fatal to
  // the process. Contain it here.
  ws.on("error", () => { browsers.delete(ws); });
  ws.on("close", () => browsers.delete(ws));
  ws.on("message", (raw) => {
    if (upstream && upstream.readyState === 1) upstream.send(raw.toString());
  });
  // Synthesize the hello the frontend expects on connect (projects from harness).
  try {
    const projects = await (await fetch(HARNESS_HTTP + "/projects")).json();
    if (ws.readyState === 1) ws.send(JSON.stringify(msg.hello(PROTOCOL_VERSION, projects)));
  } catch {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg.hello(PROTOCOL_VERSION, [])));
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[web] ready → http://localhost:${PORT} (bind ${HOST})  (harness: ${HARNESS_HTTP})`);
});
