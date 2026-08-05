// harnessClient — the pi-harness protocol layer, framework-free.
//
// HTTP control API + a single auto-reconnecting WebSocket. This is the exact
// protocol pi-web speaks; the TUI points straight at the harness (:5179).
//
// Events broadcast to ALL ws clients, so every event except `hello` carries a
// `project` field — the caller filters by it. Turn lifecycle per project:
//   typing → (delta|step|usage|subagent)* → done | error
// A lead is single-flight: sending while it's busy yields an `error` event.

import { createClient as createProtocolClient, PROTOCOL_VERSION } from "@pi/protocol";
import { WebSocket } from "ws";

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
    // connect(handlers) → { send(obj), sendUser(project,text), close() }.
    // The shared @pi/protocol client owns JSON parsing, auto-reconnect, socket-
    // error containment, and the version handshake. We just adapt its lifecycle
    // to this module's existing onEvent/onStatus contract.
    // handlers: { onEvent(obj), onStatus(...), onVersionMismatch({client,server}) }
    connect({ onEvent, onStatus, onVersionMismatch } = {}) {
      onStatus?.("connecting");
      const client = createProtocolClient({
        url: wsUrl,
        WebSocket,
        onOpen: () => onStatus?.("open"),
        onClose: () => onStatus?.("closed"),
        // Prefer the app's UI channel; fall back to console only if none wired.
        onVersionMismatch: (info) =>
          onVersionMismatch
            ? onVersionMismatch(info)
            : console.error(`[pi] protocol mismatch: client v${info.client} vs harness v${info.server}`),
      });
      // Every frame drives the existing onEvent callback, unchanged.
      client.on("*", (frame) => onEvent?.(frame));

      return {
        send(obj) {
          client.send(obj);
        },
        sendUser(project, text) {
          client.sendUser(project, text);
        },
        close() {
          client.close();
        },
      };
    },
  };
}
