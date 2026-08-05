// zod schemas — the runtime contract. Node-only (imports zod); the browser
// entry deliberately omits this so it stays dependency-free. Validation happens
// at the node boundaries (harness emits validated; the web server validates on
// the way through), which is enough to keep the browser honest.
import { z } from "zod";
import { OUT, IN } from "./events.mjs";

export const projectRef = z.object({
  id: z.string(),
  name: z.string(),
  dir: z.string(),
});

const project = z.string();

export const OUTBOUND_SCHEMAS = {
  [OUT.HELLO]: z.object({
    type: z.literal(OUT.HELLO),
    version: z.number().int(),
    projects: z.array(projectRef),
  }),
  [OUT.RESUME]: z.object({
    type: z.literal(OUT.RESUME),
    project,
    text: z.string(),
    tool: z.string().nullable(),
  }),
  [OUT.TYPING]: z.object({ type: z.literal(OUT.TYPING), project }),
  [OUT.DELTA]: z.object({ type: z.literal(OUT.DELTA), project, text: z.string() }),
  [OUT.STEP]: z.object({
    type: z.literal(OUT.STEP),
    project,
    tool: z.string(),
    toolCallId: z.string().optional(),
    args: z.any().optional(),
  }),
  [OUT.TOOL_END]: z.object({
    type: z.literal(OUT.TOOL_END),
    project,
    toolCallId: z.string(),
    tool: z.string(),
    ok: z.boolean(),
  }),
  [OUT.USAGE]: z.object({
    type: z.literal(OUT.USAGE),
    project,
    input: z.number().int(),
    output: z.number().int(),
  }),
  // subagent is polymorphic on `phase`.
  [OUT.SUBAGENT]: z.discriminatedUnion("phase", [
    z.object({
      type: z.literal(OUT.SUBAGENT),
      project,
      id: z.string(),
      phase: z.literal("start"),
      task: z.string(),
      model: z.string().optional(),
    }),
    z.object({
      type: z.literal(OUT.SUBAGENT),
      project,
      id: z.string(),
      phase: z.literal("end"),
      ok: z.boolean(),
      result: z.string(),
    }),
  ]),
  [OUT.DONE]: z.object({ type: z.literal(OUT.DONE), project }),
  [OUT.ERROR]: z.object({ type: z.literal(OUT.ERROR), project, text: z.string() }),
};

export const INBOUND_SCHEMAS = {
  [IN.USER]: z.object({
    type: z.literal(IN.USER),
    project: z.string().min(1),
    text: z.string().min(1),
  }),
  [IN.ABORT]: z.object({ type: z.literal(IN.ABORT), project: z.string().min(1) }),
};

function pick(schemas, frame) {
  const schema = frame && typeof frame.type === "string" ? schemas[frame.type] : undefined;
  if (!schema) return { ok: false, error: `unknown or unschematized type: ${frame?.type}` };
  const r = schema.safeParse(frame);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.message };
}

/** Validate a frame the harness is about to emit. */
export const validateOutbound = (frame) => pick(OUTBOUND_SCHEMAS, frame);
/** Validate a frame arriving from a client. */
export const validateInbound = (frame) => pick(INBOUND_SCHEMAS, frame);
