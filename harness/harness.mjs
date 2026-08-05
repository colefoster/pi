// pi-lead harness — pure orchestration core, no HTTP/WS.
// One lazily-created pi "lead" session per repo, plus cheap read-only subagents.
// Emits tagged lifecycle events via `events` (EventEmitter, channel "event");
// the service layer forwards those to the network. Auth: pi's ChatGPT/Codex subscription.

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";
import { msg } from "@pi/protocol";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  DefaultResourceLoader,
  getAgentDir,
  defineTool,
} from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, ".."); // repo root — where projects.json / settings.json live

// ---- config -------------------------------------------------------------
const PROVIDER = process.env.PI_PROVIDER || "openai-codex";
const MODEL_ID = process.env.PI_MODEL || "gpt-5.6-sol";
const AGENT_DIR = getAgentDir();
const PROJECTS_FILE = join(ROOT, "projects.json");
const SETTINGS_FILE = join(ROOT, "settings.json");
const DEFAULT_DIR = process.env.PROJECT_DIR || "/Users/cole/Dev/vgc-engine";
const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
// Sub-agent: a cheaper, read-only worker the lead can delegate heavy digs to.
const SUBAGENT_TOOLS = ["read", "grep", "find", "ls"];
const SUBAGENT_MODEL = process.env.PI_SUBAGENT_MODEL || "gpt-5.4-mini";
const THINKING = process.env.PI_THINKING || "medium";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const leadPrompt = (dir, subEnabled = true) => `You are "lead", a senior dev teammate messaging Cole over IM.

You have tools (${TOOLS.join(", ")}) and full access to the project at ${dir}.${subEnabled ? `
You also have a "subagent" tool: delegate a self-contained, read-only investigation to a
cheaper worker when a question needs a heavy multi-file dig. It returns findings with
file:line refs; you summarize. Use it to keep your own context lean — but for quick lookups,
just use your own tools directly.` : ""}
ALWAYS check the code/state before answering — never guess.

How you communicate (this is the important part):
- Reply like a text message: 1-3 short sentences. Lead with the answer.
- No walls of text, no headers, no bullet dumps unless Cole explicitly asks to expand.
- Surface at most ONE decision or question per message.
- If you found or did a lot, give the one-line upshot and offer to expand ("want the details?") instead of dumping it.
- Do the heavy thinking and work silently via tools; only the conclusion reaches Cole.
- Plain language, low ceremony. It's fine to be direct.`;

const subagentPrompt = (dir) => `You are a focused sub-agent running ONE delegated investigation for the lead dev, inside the project at ${dir}.
Use your read-only tools (${SUBAGENT_TOOLS.join(", ")}) to actually inspect the code — never guess.
You cannot ask follow-up questions: the lead can't reply. Do the work, then return a tight,
self-contained answer — the concrete findings with file:line references, no preamble.`;

// ---- projects registry (projects.json is the source of truth) -----------
// shape: [{ id, name, dir }]   id === absolute dir (unique)
function expandHome(p) {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}
function loadProjects() {
  if (!existsSync(PROJECTS_FILE)) {
    const seed = [{ id: DEFAULT_DIR, name: basename(DEFAULT_DIR), dir: DEFAULT_DIR }];
    writeFileSync(PROJECTS_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
  try {
    return JSON.parse(readFileSync(PROJECTS_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveProjects(list) {
  writeFileSync(PROJECTS_FILE, JSON.stringify(list, null, 2));
}
function addProject({ name, dir }) {
  const raw = String(dir || "").trim();
  if (!raw) throw new Error("dir is required");
  const abs = resolve(expandHome(raw));
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`not a directory: ${abs}`);
  }
  const list = loadProjects();
  if (list.some((p) => p.id === abs)) return { list, project: list.find((p) => p.id === abs) };
  const project = { id: abs, name: (name || "").trim() || basename(abs), dir: abs };
  list.push(project);
  saveProjects(list);
  return { list, project };
}

// ---- harness settings (settings.json overrides env-var defaults) --------
// shape: { provider, model, thinking } — the live config every new lead uses.
function loadSettings() {
  const base = {
    provider: PROVIDER,
    model: MODEL_ID,
    thinking: THINKING,
    subagent: { enabled: true, model: SUBAGENT_MODEL, thinking: THINKING },
  };
  if (!existsSync(SETTINGS_FILE)) return base;
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    // nested subagent block merges field-wise so old settings.json files upgrade cleanly
    return { ...base, ...saved, subagent: { ...base.subagent, ...(saved.subagent || {}) } };
  } catch {
    return base;
  }
}
function saveSettings(s) {
  writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

// Build the harness. Async because it spins up the shared ModelRuntime and
// resolves the configured model before returning a usable instance.
export async function createHarness() {
  const events = new EventEmitter();
  const emit = (obj) => events.emit("event", obj);

  const settings = loadSettings();

  // ---- model (shared across leads) --------------------------------------
  console.log(`[harness] provider/model: ${settings.provider}/${settings.model} · thinking: ${settings.thinking}`);
  const modelRuntime = await ModelRuntime.create();
  try {
    const available = await modelRuntime.getAvailable();
    const names = (available ?? []).map((m) => m?.id ?? m?.modelId ?? JSON.stringify(m));
    console.log(`[harness] auth-available models (${names.length}):`, names.join(", ") || "(none — run /login?)");
  } catch (e) {
    console.log("[harness] could not enumerate models:", e?.message ?? e);
  }
  let model;
  try {
    model = modelRuntime.getModel(settings.provider, settings.model);
    if (!model) throw new Error("model not found for provider");
  } catch (e) {
    console.error(`[harness] getModel(${settings.provider}, ${settings.model}) failed: ${e?.message ?? e}`);
    console.error("[harness] Set PI_MODEL to one of the available ids above, then restart.");
    process.exit(1);
  }

  // List currently-authenticated models for the settings UI (id/name/provider).
  async function availableModels() {
    try {
      const list = await modelRuntime.getAvailable();
      return (list ?? []).map((m) => ({
        id: m?.id ?? m?.modelId,
        name: m?.name ?? m?.id ?? m?.modelId,
        provider: m?.provider,
        reasoning: !!m?.reasoning,
      })).filter((m) => m.id);
    } catch {
      return [];
    }
  }

  // Apply a settings change: validate, swap the shared model, persist, and drop
  // cached leads so each respawns lazily with the new model/thinking level.
  // (In-flight prompts keep their old session reference and finish uninterrupted.)
  function applySettings(next) {
    const provider = (next.provider ?? settings.provider).trim();
    const modelId = (next.model ?? settings.model).trim();
    const thinking = (next.thinking ?? settings.thinking).trim();

    if (!THINKING_LEVELS.includes(thinking))
      throw new Error(`invalid thinking level: ${thinking}`);
    const nextModel = modelRuntime.getModel(provider, modelId);
    if (!nextModel) throw new Error(`unknown model: ${provider}/${modelId}`);

    // sub-agent config (nested, all fields optional — merge over current)
    const sub = { ...settings.subagent, ...(next.subagent || {}) };
    sub.enabled = !!sub.enabled;
    sub.model = String(sub.model ?? SUBAGENT_MODEL).trim();
    sub.thinking = String(sub.thinking ?? thinking).trim();
    if (!THINKING_LEVELS.includes(sub.thinking))
      throw new Error(`invalid sub-agent thinking level: ${sub.thinking}`);
    if (!modelRuntime.getModel(provider, sub.model))
      throw new Error(`unknown sub-agent model: ${provider}/${sub.model}`);

    model = nextModel;
    settings.provider = provider;
    settings.model = modelId;
    settings.thinking = thinking;
    settings.subagent = sub;
    saveSettings(settings);
    leadPromises.clear();
    console.log(
      `[harness] settings updated → ${provider}/${modelId} · thinking: ${thinking} · ` +
      `sub-agent ${sub.enabled ? sub.model + "/" + sub.thinking : "off"} (leads will respawn)`,
    );
    return settings;
  }

  // ---- leads: one lazily-created pi session per project -----------------
  const leadPromises = new Map(); // id -> Promise<{ session, busy }>

  // Live tool manifest for the inspector. Tools are identical across leads, so
  // we capture the resolved definitions (name/description/JSON-schema/source)
  // from the first lead that spins up — this auto-reflects any customTools too.
  let toolManifest = null;
  function captureManifest(session) {
    if (toolManifest) return;
    try {
      const active = new Set(session.getActiveToolNames?.() ?? TOOLS);
      const defs = (session.getAllTools?.() ?? [])
        .filter((t) => active.has(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description ?? "",
          schema: t.parameters ?? null,
          guidelines: t.promptGuidelines ?? [],
          source: TOOLS.includes(t.name) ? "builtin" : "custom",
        }));
      if (defs.length) toolManifest = defs;
    } catch (e) {
      console.log("[harness] tool introspection failed:", e?.message ?? e);
    }
  }
  // Ensure the manifest is populated; lazily spins up the first lead if none exist yet.
  async function ensureManifest() {
    if (toolManifest) return toolManifest;
    const list = loadProjects();
    if (list.length) { try { await getLead(list[0]); } catch {} }
    return toolManifest;
  }

  // Run one nested, read-only session on the cheap model and return its final text.
  async function runSubagent(project, task) {
    const subModel = modelRuntime.getModel(settings.provider, settings.subagent.model) || model;
    const loader = new DefaultResourceLoader({
      cwd: project.dir,
      agentDir: AGENT_DIR,
      systemPromptOverride: () => subagentPrompt(project.dir),
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: project.dir,
      model: subModel,
      modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.create(project.dir),
      tools: SUBAGENT_TOOLS,
      thinkingLevel: settings.subagent.thinking,
    });
    await session.prompt(task);
    return session.getLastAssistantText() || "(sub-agent returned nothing)";
  }

  // A "subagent" tool bound to one project. The lead calls it to delegate a dig;
  // we emit start/end events so the inspector's Subagents panel lights up.
  function makeSubagentTool(project) {
    return defineTool({
      name: "subagent",
      label: "Delegate to sub-agent",
      description:
        "Delegate a focused, read-only investigation of this repo to a cheaper sub-agent. " +
        "Give it a single self-contained task (it cannot ask follow-ups); it returns findings " +
        "with file:line references. Use for heavy multi-file exploration you don't want cluttering your own context.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Self-contained instruction: exactly what to find or investigate, with enough context to act alone.",
          },
        },
        required: ["task"],
      },
      async execute(toolCallId, params) {
        const task = String(params?.task || "").trim();
        if (!task) return { content: [{ type: "text", text: "error: empty task" }], details: {} };
        emit({ type: "subagent", project: project.id, id: toolCallId, phase: "start", task, model: settings.subagent.model });
        try {
          const text = await runSubagent(project, task);
          emit({ type: "subagent", project: project.id, id: toolCallId, phase: "end", ok: true, result: text });
          return { content: [{ type: "text", text }], details: { model: settings.subagent.model } };
        } catch (e) {
          const msg = e?.message ?? String(e);
          emit({ type: "subagent", project: project.id, id: toolCallId, phase: "end", ok: false, result: msg });
          return { content: [{ type: "text", text: "sub-agent failed: " + msg }], details: {} };
        }
      },
    });
  }

  // Translate raw pi session events into the tagged wire events the UI consumes.
  function routeEvent(projectId, event) {
    switch (event.type) {
      case "message_update": {
        const a = event.assistantMessageEvent;
        if (a?.type === "text_delta" && a.delta) emit(msg.delta(projectId, a.delta));
        break;
      }
      case "tool_execution_start":
        emit({ type: "step", project: projectId, tool: event.toolName });
        break;
      case "turn_end": {
        const m = event.message;
        if (m?.role === "assistant" && m.usage) {
          emit({ type: "usage", project: projectId, input: m.usage.input | 0, output: m.usage.output | 0 });
        }
        break;
      }
    }
  }

  async function createLead(project) {
    const loader = new DefaultResourceLoader({
      cwd: project.dir,
      agentDir: AGENT_DIR,
      systemPromptOverride: () => leadPrompt(project.dir, settings.subagent.enabled),
    });
    await loader.reload();
    const subEnabled = settings.subagent.enabled;
    const { session } = await createAgentSession({
      cwd: project.dir,
      model,
      modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.create(project.dir),
      tools: subEnabled ? [...TOOLS, "subagent"] : [...TOOLS],
      customTools: subEnabled ? [makeSubagentTool(project)] : [],
      thinkingLevel: settings.thinking,
    });
    const lead = { session, busy: false };
    captureManifest(session);
    session.subscribe((event) => routeEvent(project.id, event));
    console.log(`[harness] spun up lead for ${project.name} (${project.dir})`);
    return lead;
  }
  function getLead(project) {
    if (!leadPromises.has(project.id)) leadPromises.set(project.id, createLead(project));
    return leadPromises.get(project.id);
  }

  // Run one user turn against a project's lead. Emits typing/done/error (and,
  // through the session, delta/step/usage/subagent). Never throws — failures
  // surface as an "error" event so the caller can stay a thin forwarder.
  async function prompt(projectId, text) {
    const project = loadProjects().find((p) => p.id === projectId);
    if (!project) return emit({ type: "error", project: projectId, text: "unknown project" });

    let lead;
    try {
      lead = await getLead(project);
    } catch (e) {
      return emit({ type: "error", project: project.id, text: "couldn't start lead: " + (e?.message ?? e) });
    }
    if (lead.busy) return emit({ type: "error", project: project.id, text: "still working on the last one…" });

    lead.busy = true;
    emit({ type: "typing", project: project.id });
    try {
      await lead.session.prompt(text);
      emit({ type: "done", project: project.id });
    } catch (e) {
      emit({ type: "error", project: project.id, text: e?.message ?? String(e) });
    } finally {
      lead.busy = false;
    }
  }

  // Conversation backscroll for a project's lead, so a freshly-connected client
  // (the TUI) can render history instead of only future events. Reads the SDK's
  // persisted session.messages and flattens to { role, text, ts } — only the
  // user/assistant turns that map to chat bubbles (tool results, thinking,
  // tool calls and custom bookkeeping messages are dropped). Returns [] if the
  // lead hasn't been spawned yet (no session, nothing to replay).
  async function getMessages(projectId) {
    const project = loadProjects().find((p) => p.id === projectId);
    if (!project || !leadPromises.has(project.id)) return [];
    let session;
    try {
      ({ session } = await leadPromises.get(project.id));
    } catch {
      return [];
    }
    const textOf = (content) => {
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .filter((c) => c?.type === "text" && c.text)
        .map((c) => c.text)
        .join("");
    };
    const out = [];
    for (const m of session.messages ?? []) {
      if (m?.role !== "user" && m?.role !== "assistant") continue;
      const text = textOf(m.content).trim();
      if (!text) continue;
      out.push({ role: m.role, text, ts: m.timestamp ?? null });
    }
    return out;
  }

  // Full harness snapshot for the inspector: model, thinking, resolved tools
  // (with schemas), and the exact system prompt for the requested repo.
  async function getManifest(projectId) {
    const tools = await ensureManifest();
    const list = loadProjects();
    const proj = list.find((p) => p.id === projectId) || list[0];
    const dir = proj ? proj.dir : DEFAULT_DIR;
    return {
      provider: settings.provider,
      model: settings.model,
      thinking: settings.thinking,
      toolNames: TOOLS,
      tools: tools || TOOLS.map((n) => ({ name: n, description: "", schema: null, source: "builtin" })),
      systemPrompt: leadPrompt(dir, settings.subagent.enabled),
      subagent: settings.subagent,
      subagentTools: SUBAGENT_TOOLS,
      subagentSystemPrompt: subagentPrompt(dir),
      project: proj ? { id: proj.id, name: proj.name, dir: proj.dir } : null,
    };
  }

  // The runtime config the settings UI reads (GET /config).
  async function getConfig() {
    return {
      provider: settings.provider,
      model: settings.model,
      thinking: settings.thinking,
      tools: TOOLS,
      thinkingLevels: THINKING_LEVELS,
      models: await availableModels(),
      subagent: settings.subagent,
      subagentTools: SUBAGENT_TOOLS,
    };
  }

  return {
    events, // EventEmitter — `.on("event", obj => …)`
    listProjects: loadProjects,
    addProject,
    getConfig,
    applySettings,
    getManifest,
    getMessages,
    prompt,
  };
}
