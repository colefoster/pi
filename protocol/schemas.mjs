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

// ---- Phase 1 vocabulary (hello + delta + user). Extended in later phases. --
export const OUTBOUND_SCHEMAS = {
  [OUT.HELLO]: z.object({
    type: z.literal(OUT.HELLO),
    version: z.number().int(),
    projects: z.array(projectRef),
  }),
  [OUT.DELTA]: z.object({
    type: z.literal(OUT.DELTA),
    project: z.string(),
    text: z.string(),
  }),
};

export const INBOUND_SCHEMAS = {
  [IN.USER]: z.object({
    type: z.literal(IN.USER),
    project: z.string().min(1),
    text: z.string().min(1),
  }),
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
