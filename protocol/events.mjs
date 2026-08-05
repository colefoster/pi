// Wire vocabulary — dependency-free so both node and the browser can import it.
// The full type set is declared here up front; later phases add the matching
// zod schemas (node) and any builders, but the names live in one place.

/** Outbound: harness -> clients. */
export const OUT = Object.freeze({
  HELLO: "hello", // { version, projects }
  HISTORY: "history", // { project, messages }        (Phase 5)
  RESUME: "resume", // { project, text, tool }         (Phase 5)
  TYPING: "typing", // { project }
  DELTA: "delta", // { project, text }
  STEP: "step", // { project, tool, toolCallId, args } (args/id: Phase 4)
  TOOL_END: "tool_end", // { project, toolCallId, result, isError } (Phase 4)
  USAGE: "usage", // { project, input, output }
  SUBAGENT: "subagent", // { project, id, phase, ... }
  DONE: "done", // { project }
  ERROR: "error", // { project, text }
});

/** Inbound: clients -> harness. */
export const IN = Object.freeze({
  USER: "user", // { project, text }
  ABORT: "abort", // { project }                       (Phase 4)
});

// ---- message builders (dependency-free) ----------------------------------
// Keep outbound frames constructed in one place so field names never drift.

export const msg = {
  hello: (version, projects) => ({ type: OUT.HELLO, version, projects }),
  typing: (project) => ({ type: OUT.TYPING, project }),
  delta: (project, text) => ({ type: OUT.DELTA, project, text }),
  step: (project, tool) => ({ type: OUT.STEP, project, tool }),
  usage: (project, input, output) => ({ type: OUT.USAGE, project, input, output }),
  subagentStart: (project, id, task, model) => ({ type: OUT.SUBAGENT, project, id, phase: "start", task, model }),
  subagentEnd: (project, id, ok, result) => ({ type: OUT.SUBAGENT, project, id, phase: "end", ok, result }),
  done: (project) => ({ type: OUT.DONE, project }),
  error: (project, text) => ({ type: OUT.ERROR, project, text }),
  // inbound
  user: (project, text) => ({ type: IN.USER, project, text }),
  abort: (project) => ({ type: IN.ABORT, project }),
};

/**
 * Build a typed dispatcher. `handlers` maps a type string to a callback.
 * Returns a function you feed each decoded frame; unknown types hit `onUnknown`.
 */
export function makeDispatcher(handlers, onUnknown) {
  return (frame) => {
    const h = frame && handlers[frame.type];
    if (h) return h(frame);
    if (onUnknown) return onUnknown(frame);
  };
}
