// Transport-agnostic protocol client — dependency-free so the same code runs in
// node (inject the `ws` WebSocket) and the browser (inject the native
// WebSocket). It owns: connect + auto-reconnect, the version handshake check,
// typed event subscription, and typed senders. Frontends use this instead of
// hand-rolling `ws`/socket glue and hardcoding event-type strings.
import { PROTOCOL_VERSION } from "./version.mjs";
import { IN, makeDispatcher } from "./events.mjs";

/**
 * @param {object} opts
 * @param {string}   opts.url            ws URL, e.g. "ws://localhost:5179"
 * @param {Function} opts.WebSocket      a WebSocket constructor (node: `ws`; browser: native)
 * @param {string}  [opts.token]         shared secret; sent as ?token= (browsers can't set headers)
 * @param {boolean} [opts.reconnect]     auto-reconnect on close (default true)
 * @param {number}  [opts.reconnectMs]   backoff between reconnects (default 1000)
 * @param {Function}[opts.onOpen]
 * @param {Function}[opts.onClose]
 * @param {Function}[opts.onVersionMismatch]  ({ client, server }) => void
 */
export function createClient(opts) {
  const { url, WebSocket, token, reconnect = true, reconnectMs = 1000 } = opts;
  const handlers = Object.create(null);
  let ws = null;
  let closedByUser = false;

  const dispatch = makeDispatcher(handlers, (frame) => {
    const wildcard = handlers["*"];
    if (wildcard) wildcard(frame);
  });

  function fullUrl() {
    if (!token) return url;
    return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  }

  function connect() {
    ws = new WebSocket(fullUrl());
    // The `ws` package (node) exposes BOTH .on() and .addEventListener(); the
    // native browser WebSocket exposes only .addEventListener(). Bind exactly
    // one API — binding both double-fires every event. Presence of .on() means
    // we're on node's `ws`.
    const nodeStyle = typeof ws.on === "function";
    const bind = nodeStyle
      ? (name, fn) => ws.on(name, fn)
      : (name, fn) => ws.addEventListener(name, fn);

    bind("open", () => opts.onOpen?.());

    const onMessage = (data) => {
      let frame;
      try {
        frame = JSON.parse(typeof data === "string" ? data : data.toString());
      } catch {
        return;
      }
      if (frame?.type === "hello" && typeof frame.version === "number" && frame.version !== PROTOCOL_VERSION) {
        opts.onVersionMismatch?.({ client: PROTOCOL_VERSION, server: frame.version });
      }
      dispatch(frame);
    };
    // node `ws` .on("message") passes the raw data; browser addEventListener
    // passes a MessageEvent whose .data holds it.
    bind("message", (d) => onMessage(nodeStyle ? d : d.data));

    bind("close", () => {
      opts.onClose?.();
      if (reconnect && !closedByUser) setTimeout(connect, reconnectMs);
    });
    // Contain socket errors so they never bubble as unhandled (node) — the
    // close handler drives reconnect.
    bind("error", () => {});
  }

  connect();

  return {
    /** Subscribe to an event type ("*" catches everything). Returns an unsubscribe fn. */
    on(type, cb) {
      handlers[type] = cb;
      return () => {
        if (handlers[type] === cb) delete handlers[type];
      };
    },
    send(frame) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame));
    },
    sendUser(project, text) {
      this.send({ type: IN.USER, project, text });
    },
    sendAbort(project) {
      this.send({ type: IN.ABORT, project });
    },
    close() {
      closedByUser = true;
      try {
        ws?.close();
      } catch {}
    },
  };
}
