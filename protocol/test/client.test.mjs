// Integration test: drive createClient against a real ws server (node side,
// injecting the `ws` WebSocket) to exercise connect + version handshake +
// typed dispatch + outbound sends end-to-end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket } from "ws";
import { createClient } from "../client.mjs";
import { PROTOCOL_VERSION, msg, OUT } from "../index.mjs";

function withServer(onConnection) {
  const wss = new WebSocketServer({ port: 0 });
  return new Promise((resolve) => {
    wss.on("listening", () => {
      wss.on("connection", onConnection);
      resolve({ url: `ws://127.0.0.1:${wss.address().port}`, close: () => wss.close() });
    });
  });
}

test("client connects, receives typed events, and sends user turns", async () => {
  const received = [];
  const server = await withServer((ws) => {
    ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    ws.send(JSON.stringify(msg.hello(PROTOCOL_VERSION, [])));
    ws.send(JSON.stringify(msg.delta("/p", "streamed")));
  });

  const deltas = [];
  const client = createClient({ url: server.url, WebSocket, reconnect: false });
  await new Promise((r) => {
    client.on(OUT.HELLO, () => {});
    client.on(OUT.DELTA, (f) => {
      deltas.push(f.text);
      r();
    });
  });
  assert.deepEqual(deltas, ["streamed"]);

  client.sendUser("/p", "go");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(received.at(-1), { type: "user", project: "/p", text: "go" });

  client.close();
  server.close();
});

test("version mismatch is surfaced, not silently swallowed", async () => {
  const server = await withServer((ws) => {
    ws.send(JSON.stringify(msg.hello(PROTOCOL_VERSION + 99, [])));
  });

  let client;
  const mismatch = await new Promise((resolve) => {
    client = createClient({
      url: server.url,
      WebSocket,
      reconnect: false,
      onVersionMismatch: (info) => resolve(info),
    });
    client.on("*", () => {});
  });
  assert.equal(mismatch.client, PROTOCOL_VERSION);
  assert.equal(mismatch.server, PROTOCOL_VERSION + 99);
  client.close();
  server.close();
});
