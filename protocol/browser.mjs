// Browser entry — dependency-free subset (no zod). The web server serves this
// file tree as a static asset so `public/*.html` can import the shared
// vocabulary and client instead of hand-rolling socket glue. Runtime validation
// lives at the node boundaries, not in the browser.
export { PROTOCOL_VERSION } from "./version.mjs";
export { OUT, IN, msg, makeDispatcher } from "./events.mjs";
export { createClient } from "./client.mjs";
