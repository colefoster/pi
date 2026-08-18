// pi harness — pure orchestration core, no HTTP/WS.
// One lazily-created agent session per repo. This is a thin 1-ply harness: the
// editable surface is the system prompt (a file) and the tool set (settings.json).
// Emits tagged lifecycle events via `events` (EventEmitter, channel "event");
// the service layer forwards those to the network. Auth: pi's ChatGPT/Codex subscription.

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";
import { msg, validateOutbound } from "@pi/protocol";
import { createAgentCache } from "./agentCache.mjs";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, ".."); // repo root — projects.json / settings.json / system-prompt.md live here

// ---- config -------------------------------------------------------------
const PROVIDER = process.env.PI_PROVIDER || "openai-codex";
const MODEL_ID = process.env.PI_MODEL || "gpt-5.6-sol";
const AGENT_DIR = getAgentDir();
const PROJECTS_FILE = join(ROOT, "projects.json");
const SETTINGS_FILE = join(ROOT, "settings.json");
const PROMPT_FILE = join(ROOT, "system-prompt.md"); // default prompt for every repo
const PROJECT_PROMPT = ".pi-prompt.md"; // per-repo override, read from the project dir
const DEFAULT_DIR = process.env.PROJECT_DIR || process.cwd();
// The full tool menu an agent can be given. settings.tools picks from this set;
// the config UI offers exactly these as choices.
const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const DEFAULT_TOOLS = [...ALL_TOOLS];
const THINKING = process.env.PI_THINKING || "medium";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// Built-in fallback, used only when neither system-prompt.md nor a per-project
// .pi-prompt.md exists. Kept deliberately minimal — the prompt is meant to be
// edited in the file, not here.
const FALLBACK_PROMPT = `You are a coding agent with full access to the project at {dir}.
Use your tools to inspect the actual code or state before answering — never guess.
Be concise and lead with the answer.`;

function expandHome(p) {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

// The system prompt is a file, so editing it — not code — changes agent behavior.
// Precedence: per-project .pi-prompt.md > root system-prompt.md > built-in
// fallback. Read fresh on every spawn, so an edit takes effect on the next agent
// (a settings change respawns every agent; otherwise it applies to the next new
// one). {dir} and {tools} are interpolated.
function loadPromptTemplate(projectDir) {
  const override = join(projectDir, PROJECT_PROMPT);
  try { if (existsSync(override)) return readFileSync(override, "utf8"); } catch {}
  try { if (existsSync(PROMPT_FILE)) return readFileSync(PROMPT_FILE, "utf8"); } catch {}
  return FALLBACK_PROMPT;
}
function renderPrompt(projectDir, tools) {
  return loadPromptTemplate(projectDir)
    .replaceAll("{dir}", projectDir)
    .replaceAll("{tools}", tools.join(", "))
    .trim();
}

// ---- projects registry (projects.json is the source of truth) -----------
// shape: [{ id, name, dir }]   id === absolute dir (unique)
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
// Optional allowlist root: when PI_PROJECT_ROOT is set, only directories under
// it can be registered, so the control API can't point an agent at ~/.ssh or /.
const PROJECT_ROOT = process.env.PI_PROJECT_ROOT ? resolve(expandHome(process.env.PI_PROJECT_ROOT)) : "";
function withinRoot(abs) {
  if (!PROJECT_ROOT) return true;
  return abs === PROJECT_ROOT || abs.startsWith(PROJECT_ROOT + "/");
}
function addProject({ name, dir }) {
  const raw = String(dir || "").trim();
  if (!raw) throw new Error("dir is required");
  const abs = resolve(expandHome(raw));
  if (!withinRoot(abs)) throw new Error(`dir must be under ${PROJECT_ROOT}`);
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
// shape: { provider, model, thinking, tools } — the live config every new agent uses.
function loadSettings() {
  const base = { provider: PROVIDER, model: MODEL_ID, thinking: THINKING, tools: DEFAULT_TOOLS };
  if (!existsSync(SETTINGS_FILE)) return base;
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    const tools = Array.isArray(saved.tools) && saved.tools.length ? saved.tools : base.tools;
    return {
      provider: saved.provider ?? base.provider,
      model: saved.model ?? base.model,
      thinking: saved.thinking ?? base.thinking,
      tools,
    };
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
  // In dev (PI_VALIDATE=1) assert every outbound frame matches the protocol
  // schema before it hits the wire, so a drift shows up here, not in a client.
  const validate = process.env.PI_VALIDATE === "1";
  const emit = (obj) => {
    if (validate) {
      const r = validateOutbound(obj);
      if (!r.ok) console.warn(`[harness] invalid outbound ${obj?.type}: ${r.error}`);
    }
    events.emit("event", obj);
  };

  const settings = loadSettings();

  // ---- model (shared across agents) -------------------------------------
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
    // Stay a pure core: surface the failure to the caller (the service decides
    // whether to exit the process) instead of killing it from inside.
    throw new Error(
      `getModel(${settings.provider}, ${settings.model}) failed: ${e?.message ?? e}. ` +
      `Set PI_MODEL to one of the available ids, then restart.`,
    );
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

  // Apply a settings change: validate, swap the shared model / tool set, persist,
  // and drop cached agents so each respawns lazily with the new config.
  // (In-flight prompts keep their old session reference and finish uninterrupted.)
  function applySettings(next) {
    const provider = (next.provider ?? settings.provider).trim();
    const modelId = (next.model ?? settings.model).trim();
    const thinking = (next.thinking ?? settings.thinking).trim();

    if (!THINKING_LEVELS.includes(thinking))
      throw new Error(`invalid thinking level: ${thinking}`);
    const nextModel = modelRuntime.getModel(provider, modelId);
    if (!nextModel) throw new Error(`unknown model: ${provider}/${modelId}`);

    // Tool set — validate against the known menu so a typo can't silently brick
    // every agent at session-creation time.
    let tools = settings.tools;
    if (next.tools !== undefined) {
      if (!Array.isArray(next.tools) || !next.tools.length)
        throw new Error("tools must be a non-empty array");
      const cleaned = next.tools.map((t) => String(t).trim()).filter(Boolean);
      const unknown = cleaned.filter((t) => !ALL_TOOLS.includes(t));
      if (unknown.length)
        throw new Error(`unknown tool(s): ${unknown.join(", ")} (allowed: ${ALL_TOOLS.join(", ")})`);
      tools = [...new Set(cleaned)];
    }

    model = nextModel;
    settings.provider = provider;
    settings.model = modelId;
    settings.thinking = thinking;
    settings.tools = tools;
    saveSettings(settings);
    // Dispose the old agents (tears down their subscriptions + sessions) before
    // dropping them, so each respawns lazily with the new model/thinking/tools.
    agents.disposeAll();
    console.log(
      `[harness] settings updated → ${provider}/${modelId} · thinking: ${thinking} · ` +
      `tools: ${tools.join(",")} (agents will respawn)`,
    );
    return settings;
  }

  // ---- agents: one lazily-created pi session per project ----------------
  const agents = createAgentCache({ dispose: disposeAgent });

  // Live tool manifest for the inspector. Tools are identical across agents, so
  // we capture the resolved definitions (name/description/JSON-schema/source)
  // from the first agent that spins up.
  let toolManifest = null;
  function captureManifest(session) {
    if (toolManifest) return;
    try {
      const active = new Set(session.getActiveToolNames?.() ?? settings.tools);
      const defs = (session.getAllTools?.() ?? [])
        .filter((t) => active.has(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description ?? "",
          schema: t.parameters ?? null,
          guidelines: t.promptGuidelines ?? [],
          source: ALL_TOOLS.includes(t.name) ? "builtin" : "custom",
        }));
      if (defs.length) toolManifest = defs;
    } catch (e) {
      console.log("[harness] tool introspection failed:", e?.message ?? e);
    }
  }
  // Ensure the manifest is populated; lazily spins up the first agent if none exist yet.
  async function ensureManifest() {
    if (toolManifest) return toolManifest;
    const list = loadProjects();
    if (list.length) { try { await getAgent(list[0]); } catch {} }
    return toolManifest;
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
        emit(msg.step(projectId, event.toolName, event.toolCallId, event.args));
        break;
      case "tool_execution_end":
        emit(msg.toolEnd(projectId, event.toolCallId, event.toolName, !event.isError));
        break;
      case "turn_end": {
        const m = event.message;
        if (m?.role === "assistant" && m.usage) {
          emit(msg.usage(projectId, m.usage.input | 0, m.usage.output | 0));
        }
        break;
      }
    }
  }

  async function createAgent(project) {
    const tools = settings.tools;
    const loader = new DefaultResourceLoader({
      cwd: project.dir,
      agentDir: AGENT_DIR,
      systemPromptOverride: () => renderPrompt(project.dir, tools),
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: project.dir,
      model,
      modelRuntime,
      resourceLoader: loader,
      // Resume the project's most recent on-disk session (creates a new one only
      // if none exists), so a harness restart or settings-change respawn keeps
      // conversation memory instead of silently wiping it.
      sessionManager: SessionManager.continueRecent(project.dir),
      tools,
      thinkingLevel: settings.thinking,
    });
    captureManifest(session);
    // Capture the unsubscribe handle so disposeAgent() can tear the listener down
    // when this agent is replaced (settings change) — otherwise subscriptions and
    // sessions leak with every respawn.
    const unsubscribe = session.subscribe((event) => routeEvent(project.id, event));
    const agent = { session, busy: false, unsubscribe };
    console.log(`[harness] spun up agent for ${project.name} (${project.dir})`);
    return agent;
  }
  function disposeAgent(agentOrPromise) {
    Promise.resolve(agentOrPromise)
      .then((agent) => {
        try { agent?.unsubscribe?.(); } catch {}
        try { agent?.session?.dispose?.(); } catch {}
      })
      .catch(() => {}); // an agent that never resolved has nothing to dispose
  }
  function getAgent(project) {
    // The cache creates lazily and evicts a failed creation so one transient
    // failure never permanently bricks the project.
    return agents.getOrCreate(project.id, () => createAgent(project));
  }

  // Run one user turn against a project's agent. Emits typing/done/error (and,
  // through the session, delta/step/usage). Never throws — failures surface as
  // an "error" event so the caller can stay a thin forwarder.
  async function prompt(projectId, text) {
    const project = loadProjects().find((p) => p.id === projectId);
    if (!project) return emit(msg.error(projectId, "unknown project"));

    let agent;
    try {
      agent = await getAgent(project);
    } catch (e) {
      return emit(msg.error(project.id, "couldn't start agent: " + (e?.message ?? e)));
    }
    if (agent.busy) return emit(msg.error(project.id, "still working on the last one…"));

    agent.busy = true;
    emit(msg.typing(project.id));
    try {
      await agent.session.prompt(text);
      emit(msg.done(project.id));
    } catch (e) {
      emit(msg.error(project.id, e?.message ?? String(e)));
    } finally {
      agent.busy = false;
    }
  }

  // Cancel a project's in-flight turn (if any). No-op when the agent isn't live
  // or isn't busy. The aborted prompt() rejects and surfaces its own event.
  async function abort(projectId) {
    if (!agents.has(projectId)) return;
    try {
      const agent = await agents.get(projectId);
      if (agent?.busy) await agent.session.abort();
    } catch {
      // an agent mid-creation or a benign abort race — nothing to cancel
    }
  }

  // Conversation backscroll for a project's agent, so a freshly-connected client
  // (the TUI) can render history instead of only future events. Reads the SDK's
  // persisted session.messages and flattens to { role, text, ts } — only the
  // user/assistant turns that map to chat bubbles (tool results, thinking,
  // tool calls and custom bookkeeping messages are dropped). Returns [] if the
  // agent hasn't been spawned yet (no session, nothing to replay).
  async function getMessages(projectId) {
    const project = loadProjects().find((p) => p.id === projectId);
    if (!project) return [];
    // Resume the agent (continueRecent under the hood) so backscroll is real even
    // right after a restart, before any new prompt. Cached, so this spawns once.
    let session;
    try {
      ({ session } = await getAgent(project));
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
      toolNames: settings.tools,
      tools: tools || settings.tools.map((n) => ({ name: n, description: "", schema: null, source: "builtin" })),
      systemPrompt: renderPrompt(dir, settings.tools),
      project: proj ? { id: proj.id, name: proj.name, dir: proj.dir } : null,
    };
  }

  // The runtime config the settings UI reads (GET /config).
  async function getConfig() {
    return {
      provider: settings.provider,
      model: settings.model,
      thinking: settings.thinking,
      tools: settings.tools,
      toolChoices: ALL_TOOLS,
      thinkingLevels: THINKING_LEVELS,
      models: await availableModels(),
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
    abort,
  };
}
