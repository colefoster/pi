// Bump on any breaking change to the wire vocabulary or message shapes.
// The client compares this against the version in the harness `hello` frame and
// surfaces a mismatch instead of silently mis-parsing.
export const PROTOCOL_VERSION = 1;
