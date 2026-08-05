// Node entry — full protocol surface including zod validation.
// Used by @pi/harness, @pi/web (server), and @pi/tui.
export { PROTOCOL_VERSION } from "./version.mjs";
export { OUT, IN, msg, makeDispatcher } from "./events.mjs";
export {
  projectRef,
  OUTBOUND_SCHEMAS,
  INBOUND_SCHEMAS,
  validateOutbound,
  validateInbound,
} from "./schemas.mjs";
export { createClient } from "./client.mjs";
