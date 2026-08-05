// pi-tui App — root component + UI, wired to the harness over HTTP/WS.
//
// One global WebSocket; events are broadcast to all clients so we filter every
// event by its `project` field into a per-project session slice. The turn
// lifecycle (typing → delta/step/usage/subagent → done|error) drives the chat.

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import htm from "htm";
import { createClient } from "./harnessClient.mjs";
import { OUT } from "@pi/protocol";

const html = htm.bind(React.createElement);

// A fresh per-project session slice.
const emptySession = () => ({
  messages: [], // { role: "you"|"lead"|"error", text, ts? }
  loaded: false, // history fetched?
  streaming: "", // in-flight assistant text
  busy: false,
  unread: false, // lead replied while this repo was in the background
  lastTool: "", // most recent tool the lead invoked (for the status line)
  steps: 0,
  agents: 0,
  tokensIn: 0,
  tokensOut: 0,
});

// Roughly how many terminal rows a message occupies, given the real inner text
// width, so we can page the log without overflowing the frame (Ink won't scroll
// for us). `textWidth` is the content width AFTER the box's border + padding.
const estLines = (text, textWidth) => {
  const w = Math.max(1, textWidth);
  let n = 1; // label/first line
  for (const line of String(text).split("\n")) n += Math.max(1, Math.ceil((line.length || 1) / w));
  return n + 1; // + spacing
};

// HH:MM for a message timestamp (number ms or ISO string); "" if absent/invalid.
const fmtTime = (ts) => {
  if (ts == null) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function App({ harnessUrl }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const client = useRef(createClient(harnessUrl)).current;
  const conn = useRef(null);

  const [projects, setProjects] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [sessions, setSessions] = useState({}); // id -> session slice
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState("connecting"); // ws status
  const [mode, setMode] = useState("chat"); // chat | addRepo | config | inspector
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState(""); // transient footer message
  const [scroll, setScroll] = useState(0); // backscroll offset in rows (0 = live tail)

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const flashTimer = useRef(null);

  const rows = (stdout?.rows || 24);
  const cols = (stdout?.columns || 80);

  // --- helpers ---------------------------------------------------------------
  const patchSession = useCallback((id, fn) => {
    setSessions((prev) => {
      const cur = prev[id] || emptySession();
      return { ...prev, [id]: { ...cur, ...fn(cur) } };
    });
  }, []);

  // One live notice at a time — a new flash cancels the previous timer so they
  // don't stomp each other (B3).
  const flash = useCallback((msg) => {
    setNotice(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setNotice(""), 2500);
  }, []);
  useEffect(() => () => flashTimer.current && clearTimeout(flashTimer.current), []);

  // --- initial load + websocket ---------------------------------------------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [projs, cfg] = await Promise.all([client.getProjects(), client.getConfig().catch(() => null)]);
        if (!alive) return;
        setProjects(projs);
        setConfig(cfg);
        if (projs.length) setActiveId((cur) => cur || projs[0].id);
      } catch (e) {
        if (alive) flash("load failed: " + e.message);
      }
    })();

    conn.current = client.connect({
      onStatus: (s) => alive && setStatus(s),
      // Surface a protocol mismatch on the app's notice line, not just the console.
      onVersionMismatch: ({ client: c, server }) =>
        alive && flash(`harness protocol v${server} — restart the TUI (client v${c})`),
      // Dispatch keys off OUT.* constants — no bare event-type string literals.
      onEvent: (m) => {
        if (!alive) return;
        if (m.type === OUT.HELLO) {
          if (Array.isArray(m.projects)) setProjects(m.projects);
          return;
        }
        const id = m.project;
        if (!id) return;
        switch (m.type) {
          case OUT.TYPING:
            patchSession(id, () => ({ busy: true, streaming: "", steps: 0, agents: 0, tokensIn: 0, tokensOut: 0, lastTool: "" }));
            break;
          case OUT.DELTA:
            patchSession(id, (s) => ({ streaming: s.streaming + (m.text || "") }));
            break;
          case OUT.STEP:
            patchSession(id, (s) => ({ steps: s.steps + 1, lastTool: m.tool || s.lastTool }));
            break;
          case OUT.SUBAGENT:
            if (m.phase === "start") patchSession(id, (s) => ({ agents: s.agents + 1, lastTool: "subagent" }));
            break;
          case OUT.USAGE:
            patchSession(id, (s) => ({ tokensIn: s.tokensIn + (m.input | 0), tokensOut: s.tokensOut + (m.output | 0) }));
            break;
          case OUT.DONE:
            patchSession(id, (s) => ({
              busy: false,
              streaming: "",
              lastTool: "",
              // badge the reply as unread if it landed in a background repo (E1).
              unread: id !== activeIdRef.current ? true : s.unread,
              messages: s.streaming.trim()
                ? [...s.messages, { role: "lead", text: s.streaming.trim(), ts: Date.now() }]
                : s.messages,
            }));
            break;
          case OUT.ERROR:
            patchSession(id, (s) => ({
              busy: false,
              streaming: "",
              lastTool: "",
              unread: id !== activeIdRef.current ? true : s.unread,
              messages: [
                ...s.messages,
                ...(s.streaming.trim() ? [{ role: "lead", text: s.streaming.trim(), ts: Date.now() }] : []),
                { role: "error", text: m.text || "error", ts: Date.now() },
              ],
            }));
            break;
        }
      },
    });

    return () => {
      alive = false;
      conn.current?.close();
    };
  }, [client, patchSession, flash]);

  // --- on repo switch: snap to live tail, clear its unread badge, lazy-load ---
  useEffect(() => {
    if (!activeId) return;
    setScroll(0);
    patchSession(activeId, () => ({ unread: false }));
    const s = sessions[activeId];
    if (s && s.loaded) return;
    let alive = true;
    client
      .getMessages(activeId)
      .then((history) => {
        if (!alive) return;
        const mapped = (history || []).map((m) => ({
          role: m.role === "user" ? "you" : "lead",
          text: m.text,
          ts: m.ts ?? null,
        }));
        // Only seed history if nothing has been appended in the meantime — a
        // message sent/streamed during the fetch must not be clobbered (B1).
        patchSession(activeId, (cur) => ({
          loaded: true,
          messages: mapped.length && cur.messages.length === 0 ? mapped : cur.messages,
        }));
      })
      .catch(() => alive && patchSession(activeId, () => ({ loaded: true })));
    return () => {
      alive = false;
    };
  }, [activeId, client, patchSession]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- actions ---------------------------------------------------------------
  const cycleProject = (dir) => {
    if (projects.length < 2) return;
    const i = projects.findIndex((p) => p.id === activeId);
    const next = projects[(i + dir + projects.length) % projects.length];
    setActiveId(next.id);
  };

  const send = () => {
    const text = input.trim();
    if (!text || !activeId) return;
    const s = sessions[activeId] || emptySession();
    if (s.busy) {
      flash("lead is still working on the last one…");
      return;
    }
    // Don't fire into a dead socket — it'd queue silently and spin forever (B5).
    if (status !== "open") {
      flash("harness offline — message not sent");
      return;
    }
    patchSession(activeId, (cur) => ({ messages: [...cur.messages, { role: "you", text, ts: Date.now() }], busy: true }));
    conn.current?.sendUser(activeId, text);
    setInput("");
    setScroll(0); // snap back to the live tail
  };

  // --- layout + chat viewport geometry ---------------------------------------
  const active = projects.find((p) => p.id === activeId);
  const sess = (activeId && sessions[activeId]) || emptySession();

  const bodyHeight = Math.max(6, rows - 5); // minus header + status + input + borders
  const sidebarW = Math.min(28, Math.max(16, Math.floor(cols * 0.22)));
  const logW = cols - sidebarW - 3;

  // Resolve exactly which bubbles are visible for the current scroll offset, so
  // the key handler and ChatLog share one source of truth (E2). Scroll is a row
  // offset from the bottom; 0 = live tail.
  const chatView = (() => {
    const innerW = Math.max(1, logW - 4); // border(2) + paddingX(2)
    const bubbles = [...sess.messages];
    if (sess.streaming) bubbles.push({ role: "lead", text: sess.streaming, live: true });
    const costs = bubbles.map((b) => estLines(b.text, innerW));
    const totalRows = costs.reduce((a, b) => a + b, 0);
    const viewRows = Math.max(1, bodyHeight - 2); // inside the log's border
    const maxScroll = Math.max(0, totalRows - viewRows);
    const off = Math.min(scroll, maxScroll);
    const budget = maxScroll > 0 ? viewRows - 1 : viewRows; // reserve a hint row

    // Special case: the newest bubble alone is taller than the viewport and
    // we're at the live tail. Ink can't tail-align a Box, so clip the text to
    // its last lines — keeps the freshest tokens of a long stream on screen.
    if (off === 0 && bubbles.length && costs[bubbles.length - 1] > budget) {
      const b = bubbles[bubbles.length - 1];
      const keep = Math.max(1, budget - 2); // leave room for the label + hint rows
      const clipped = String(b.text).split("\n").slice(-keep).join("\n");
      return { shown: [{ ...b, text: clipped }], maxScroll, hiddenAbove: true, hiddenBelow: false };
    }

    const shown = [];
    let skipped = 0;
    let used = 0;
    let firstIdx = bubbles.length;
    for (let i = bubbles.length - 1; i >= 0; i--) {
      if (skipped < off) {
        skipped += costs[i];
        continue;
      }
      if (used + costs[i] > budget && shown.length) break;
      shown.unshift(bubbles[i]);
      used += costs[i];
      firstIdx = i;
    }
    return { shown, maxScroll, hiddenAbove: firstIdx > 0, hiddenBelow: off > 0 };
  })();

  // --- global keybindings ----------------------------------------------------
  useInput((inputChar, key) => {
    // Ctrl+C always quits (modals get one chance to cancel first).
    if (key.ctrl && inputChar === "c") {
      if (mode !== "chat") return setMode("chat");
      conn.current?.close();
      exit();
      return;
    }
    if (mode !== "chat") {
      if (key.escape) setMode("chat");
      return; // modal owns the rest of the keys
    }
    if (key.tab && key.shift) return cycleProject(-1);
    if (key.tab) return cycleProject(1);
    if (key.ctrl && inputChar === "n") return setMode("addRepo");
    if (key.ctrl && inputChar === "o") return openConfig();
    if (key.ctrl && inputChar === "g") return openInspector();
    // Backscroll (chat mode). Up/Down arrows are free here — the single-line
    // input ignores them — so use them for line scroll; PageUp/Down for a page.
    const pg = Math.max(3, bodyHeight - 4);
    if (key.pageUp) return setScroll((v) => Math.min(chatView.maxScroll, v + pg));
    if (key.pageDown) return setScroll((v) => Math.max(0, v - pg));
    if (key.upArrow) return setScroll((v) => Math.min(chatView.maxScroll, v + 2));
    if (key.downArrow) return setScroll((v) => Math.max(0, v - 2));
  });

  const openConfig = async () => {
    try {
      const cfg = await client.getConfig();
      setConfig(cfg);
      setMode("config");
    } catch (e) {
      flash("config load failed: " + e.message);
    }
  };

  const [manifest, setManifest] = useState(null);
  const openInspector = async () => {
    if (!activeId) return;
    try {
      setManifest(await client.getManifest(activeId));
      setMode("inspector");
    } catch (e) {
      flash("manifest failed: " + e.message);
    }
  };

  // Modals replace the body (rather than stacking under the input bar) so the
  // fixed-height frame never clips their borders.
  const modal =
    mode === "addRepo"
      ? html`<${AddRepoModal}
          client=${client}
          onDone=${(project, list) => {
            if (list) setProjects(list);
            if (project) setActiveId(project.id);
            setMode("chat");
            flash("added " + (project?.name || "repo"));
          }}
          onCancel=${() => setMode("chat")}
        />`
      : mode === "config"
        ? html`<${ConfigModal}
            config=${config}
            onApply=${async (patch) => {
              try {
                await client.postConfig(patch);
                setConfig(await client.getConfig());
                flash("config applied (next message uses it)");
              } catch (e) {
                flash("apply failed: " + e.message);
              }
              setMode("chat");
            }}
            onCancel=${() => setMode("chat")}
          />`
        : mode === "inspector"
          ? html`<${InspectorModal} manifest=${manifest} onClose=${() => setMode("chat")} />`
          : null;

  return html`
    <${Box} flexDirection="column" width=${cols} height=${rows}>
      <${Header} status=${status} project=${active} harnessUrl=${harnessUrl} />
      ${status !== "open" && !modal
        ? html`<${Box} paddingX=${1}><${Text} backgroundColor="yellow" color="black"> ${
            status === "connecting" ? "connecting to harness…" : "harness offline — reconnecting…"
          } <//><//>`
        : null}
      ${modal
        ? html`<${Box} flexGrow=${1} alignItems="center" justifyContent="center">${modal}<//>`
        : html`<${Box} flexGrow=${1}>
            <${Sidebar} projects=${projects} activeId=${activeId} sessions=${sessions} width=${sidebarW} height=${bodyHeight} />
            <${ChatLog} view=${chatView} width=${logW} height=${bodyHeight} project=${active} />
          <//>`}
      <${StatusLine} session=${sess} config=${config} notice=${notice} scrolled=${chatView.hiddenBelow} />
      ${mode === "chat"
        ? html`<${InputBar} value=${input} onChange=${setInput} onSubmit=${send} busy=${sess.busy} />`
        : html`<${Box} paddingX=${1}><${Text} color="gray" dimColor>Esc to cancel<//><//>`}
    <//>
  `;
}

// --- Header ------------------------------------------------------------------
function Header({ status, project, harnessUrl }) {
  const dot = status === "open" ? html`<${Text} color="green">●<//>` : html`<${Text} color="yellow">○<//>`;
  return html`
    <${Box} paddingX=${1} justifyContent="space-between">
      <${Box}>
        <${Text} bold color="cyan">π <//>
        <${Text} bold>${project ? project.name : "no project"}<//>
        ${project ? html`<${Text} color="gray"> · ${project.dir}<//>` : null}
      <//>
      <${Box}>
        ${dot}<${Text} color="gray"> ${status} · ${harnessUrl.replace(/^https?:\/\//, "")}<//>
      <//>
    <//>
  `;
}

// --- Sidebar -----------------------------------------------------------------
function Sidebar({ projects, activeId, sessions, width, height }) {
  return html`
    <${Box} flexDirection="column" width=${width} height=${height} borderStyle="round" borderColor="gray" paddingX=${1}>
      <${Text} bold color="gray">REPOS<//>
      ${projects.map((p) => {
        const on = p.id === activeId;
        const s = sessions[p.id];
        const busy = s?.busy;
        const unread = s?.unread && !on;
        return html`
          <${Box} key=${p.id}>
            <${Text} color=${on ? "cyan" : unread ? "white" : "white"} bold=${on || unread}>
              ${on ? "▸ " : "  "}${p.name}
            <//>
            ${busy
              ? html`<${Text} color="yellow"> ●<//>`
              : unread
                ? html`<${Text} color="magenta"> ●<//>`
                : null}
          <//>
        `;
      })}
      ${projects.length === 0 ? html`<${Text} color="gray" dimColor>none — Ctrl+N to add<//>` : null}
    <//>
  `;
}

// --- ChatLog -----------------------------------------------------------------
// Dumb renderer: App resolves which bubbles are visible (view.shown) and the
// scroll indicators; this just paints them.
function ChatLog({ view, width, height, project }) {
  const { shown, hiddenAbove, hiddenBelow } = view;
  const color = (r) => (r === "you" ? "green" : r === "error" ? "red" : "white");
  const label = (r) => (r === "you" ? "you" : r === "error" ? "!!" : "lead");

  return html`
    <${Box} flexDirection="column" width=${width} height=${height} borderStyle="round" borderColor="gray" paddingX=${1} overflow="hidden">
      ${hiddenAbove ? html`<${Text} color="gray" dimColor>▲ more above — ↑/PgUp<//>` : null}
      ${shown.length === 0
        ? html`<${Text} color="gray" dimColor>${project ? "no messages yet — say something below" : "add a repo with Ctrl+N"}<//>`
        : shown.map((b, i) => {
            const t = fmtTime(b.ts);
            return html`
              <${Box} key=${i} flexDirection="column" marginBottom=${1}>
                <${Box}>
                  <${Text} bold color=${color(b.role)}>${label(b.role)}${b.live ? " ▍" : ""}<//>
                  ${t ? html`<${Text} color="gray" dimColor> ${t}<//>` : null}
                <//>
                <${Text} color=${b.role === "error" ? "red" : undefined} wrap="wrap">${b.text}<//>
              <//>
            `;
          })}
      ${hiddenBelow ? html`<${Text} color="gray" dimColor>▼ more below — ↓/PgDn · sending snaps to latest<//>` : null}
    <//>
  `;
}

// --- StatusLine --------------------------------------------------------------
function StatusLine({ session, config, notice, scrolled }) {
  const rightDefault = config ? `${config.model} · ${config.thinking}` : "";
  const tool = session.busy && session.lastTool ? ` · ⚙ ${session.lastTool}` : "";
  return html`
    <${Box} paddingX=${1} justifyContent="space-between">
      <${Box}>
        ${session.busy
          ? html`<${Text} color="yellow"><${Spinner} type="dots" /> working<//>`
          : html`<${Text} color="gray">idle<//>`}
        ${session.busy || session.steps || session.agents
          ? html`<${Text} color="gray">  ·  ${session.steps} tools${session.agents ? ` · ${session.agents} agents` : ""}${
              session.tokensOut ? ` · ${session.tokensIn + session.tokensOut} tok` : ""
            }${tool}<//>`
          : null}
        ${scrolled ? html`<${Text} color="cyan">  ·  ⇅ scrolled<//>` : null}
      <//>
      <${Text} color=${notice ? "magenta" : "gray"} dimColor=${!notice}>
        ${notice || rightDefault}
      <//>
    <//>
  `;
}

// --- InputBar ----------------------------------------------------------------
function InputBar({ value, onChange, onSubmit, busy }) {
  return html`
    <${Box} paddingX=${1}>
      <${Text} color=${busy ? "yellow" : "cyan"}>${busy ? "… " : "› "}<//>
      <${TextInput}
        value=${value}
        onChange=${onChange}
        onSubmit=${onSubmit}
        placeholder=${busy ? "lead is working — send is blocked until it replies" : "message the lead   (Tab switch · ↑/PgUp scroll · Ctrl+N add · Ctrl+O model · Ctrl+G inspect · Ctrl+C quit)"}
      />
    <//>
  `;
}

// --- AddRepoModal ------------------------------------------------------------
function AddRepoModal({ client, onDone, onCancel }) {
  const [dir, setDir] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const d = dir.trim();
    if (!d) return onCancel();
    setBusy(true);
    try {
      const { list, project } = await client.addProject({ dir: d });
      onDone(project, list);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return html`
    <${Overlay} title="Add repo">
      <${Text} color="gray">Absolute path or ~ (Enter to add, Esc to cancel)<//>
      <${Box} marginTop=${1}>
        <${Text} color="cyan">dir › <//>
        ${busy ? html`<${Text} color="yellow">adding…<//>` : html`<${TextInput} value=${dir} onChange=${setDir} onSubmit=${submit} placeholder="/Users/cole/Dev/…" />`}
      <//>
      ${err ? html`<${Text} color="red">${err}<//>` : null}
    <//>
  `;
}

// --- ConfigModal -------------------------------------------------------------
// Two cyclable rows: Model and Thinking. ←/→ change value, Tab switches row,
// Enter applies, Esc cancels.
function ConfigModal({ config, onApply, onCancel }) {
  const models = (config?.models || []).map((m) => m.id);
  const modelList = models.length ? models : [config?.model].filter(Boolean);
  const levels = config?.thinkingLevels || ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

  const [row, setRow] = useState(0); // 0 model, 1 thinking
  const [mi, setMi] = useState(Math.max(0, modelList.indexOf(config?.model)));
  const [ti, setTi] = useState(Math.max(0, levels.indexOf(config?.thinking)));

  useInput((_input, key) => {
    if (key.escape) return onCancel();
    if (key.return) return onApply({ model: modelList[mi], thinking: levels[ti] });
    if (key.tab) return setRow((r) => (r + 1) % 2);
    if (key.upArrow) return setRow(0);
    if (key.downArrow) return setRow(1);
    const delta = key.leftArrow ? -1 : key.rightArrow ? 1 : 0;
    if (!delta) return;
    if (row === 0 && modelList.length) setMi((i) => (i + delta + modelList.length) % modelList.length);
    if (row === 1 && levels.length) setTi((i) => (i + delta + levels.length) % levels.length);
  });

  const Row = (idx, name, val) => html`
    <${Box} key=${name}>
      <${Text} color=${row === idx ? "cyan" : "gray"} bold=${row === idx}>${row === idx ? "▸ " : "  "}${name.padEnd(9)}<//>
      <${Text} color=${row === idx ? "white" : "gray"}>‹ ${val} ›<//>
    <//>
  `;

  return html`
    <${Overlay} title="Model / thinking">
      <${Text} color="gray">Tab switch · ←/→ change · Enter apply · Esc cancel<//>
      <${Box} marginTop=${1} flexDirection="column">
        ${Row(0, "model", modelList[mi] || "—")}
        ${Row(1, "thinking", levels[ti] || "—")}
      <//>
    <//>
  `;
}

// --- InspectorModal ----------------------------------------------------------
function InspectorModal({ manifest, onClose }) {
  useInput((_i, key) => {
    if (key.escape || key.return) onClose();
  });
  if (!manifest) return html`<${Overlay} title="Inspector"><${Text} color="gray">loading…<//><//>`;
  return html`
    <${Overlay} title=${`Inspector — ${manifest.project?.name || ""}`}>
      <${Text}><${Text} color="gray">model    <//>${manifest.provider}/${manifest.model} · ${manifest.thinking}<//>
      <${Text}><${Text} color="gray">tools    <//>${(manifest.toolNames || []).join(", ")}<//>
      <${Text}><${Text} color="gray">subagent <//>${manifest.subagent?.enabled ? `${manifest.subagent.model} · ${manifest.subagent.thinking}` : "off"}<//>
      <${Box} marginTop=${1} flexDirection="column">
        <${Text} color="gray">system prompt<//>
        <${Text} wrap="wrap">${(manifest.systemPrompt || "").slice(0, 600)}${(manifest.systemPrompt || "").length > 600 ? "…" : ""}<//>
      <//>
      <${Box} marginTop=${1}><${Text} color="gray" dimColor>Enter / Esc to close<//><//>
    <//>
  `;
}

// --- Overlay (modal chrome) --------------------------------------------------
function Overlay({ title, children }) {
  return html`
    <${Box} borderStyle="double" borderColor="cyan" flexDirection="column" paddingX=${1} marginX=${1}>
      <${Text} bold color="cyan">${title}<//>
      ${children}
    <//>
  `;
}
