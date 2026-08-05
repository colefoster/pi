// harnessClient — the pi-harness protocol layer, framework-free.
//
// HTTP control API + a single auto-reconnecting WebSocket. This is the exact
// protocol pi-web speaks; the TUI points straight at the harness (:5179).
//
// Events broadcast to ALL ws clients, so every event except `hello` carries a
// `project` field — the caller filters by it. Turn lifecycle per project:
//   typing → (delta|step|usage|subagent)* → done | error
// A lead is single-flight: sending while it's busy yields an `error` event.

import WebSocket from "ws";

export function createClient(harnessUrl) {
  const http = harnessUrl.replace(/\/$/, "");
  const wsUrl = http.replace(/^http/, "ws");

  async function req(path, opts) {
    const res = await fetch(http + path, {
      headers: { "content-type": "application/json" },
      ...opts,
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(body?.error || `${res.status} ${res.statusText}`);
    return body;
  }

  return {
    http,
    wsUrl,

    // ---- HTTP ----
    health: () => req("/health"),
    getProjects: () => req("/projects"),
    addProject: (project) => req("/projects", { method: "POST", body: JSON.stringify(project) }),
    getConfig: () => req("/config"),
    postConfig: (patch) => req("/config", { method: "POST", body: JSON.stringify(patch) }),
    getManifest: (id) => req(`/manifest?project=${encodeURIComponent(id)}`),
    getMessages: (id) => req(`/messages?project=${encodeURIComponent(id)}`),

    // ---- WebSocket ----
    // connect(handlers) → { send(obj), close() }. Auto-reconnects with backoff.
    // handlers: { onEvent(obj), onStatus("connecting"|"open"|"closed") }
    connect({ onEvent, onStatus } = {}) {
      let ws = null;
      let closed = false;
      let backoff = 500;
      const queue = []; // messages sent while the socket is down

      const open = () => {
        if (closed) return;
        onStatus?.("connecting");
        ws = new WebSocket(wsUrl);

        ws.on("open", () => {
          backoff = 500;
          onStatus?.("open");
          while (queue.length && ws.readyState === WebSocket.OPEN) ws.send(queue.shift());
        });
        ws.on("message", (raw) => {
          let obj;
          try {
            obj = JSON.parse(raw.toString());
          } catch {
            return;
          }
          onEvent?.(obj);
        });
        ws.on("close", () => {
          onStatus?.("closed");
          if (closed) return;
          setTimeout(open, backoff);
          backoff = Math.min(backoff * 2, 8000);
        });
        // Swallow errors — the close handler drives reconnection.
        ws.on("error", () => {});
      };

      open();

      return {
        send(obj) {
          const s = JSON.stringify(obj);
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(s);
          else queue.push(s);
        },
        sendUser(project, text) {
          this.send({ type: "user", project, text });
        },
        close() {
          closed = true;
          try {
            ws?.close();
          } catch {}
        },
      };
    },
  };
}
