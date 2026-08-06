import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  OUT,
  IN,
  msg,
  makeDispatcher,
  validateOutbound,
  validateInbound,
} from "../index.mjs";

test("PROTOCOL_VERSION is a positive integer", () => {
  assert.ok(Number.isInteger(PROTOCOL_VERSION) && PROTOCOL_VERSION > 0);
});

test("hello builder + schema round-trip", () => {
  const projects = [{ id: "/p", name: "p", dir: "/p" }];
  const frame = msg.hello(PROTOCOL_VERSION, projects);
  assert.equal(frame.type, OUT.HELLO);
  const r = validateOutbound(frame);
  assert.ok(r.ok, r.error);
  assert.equal(r.value.version, PROTOCOL_VERSION);
});

test("delta builder + schema round-trip", () => {
  const frame = msg.delta("/p", "hi");
  const r = validateOutbound(frame);
  assert.ok(r.ok, r.error);
  assert.equal(r.value.text, "hi");
});

test("user inbound builder + schema round-trip", () => {
  const frame = msg.user("/p", "do the thing");
  assert.equal(frame.type, IN.USER);
  const r = validateInbound(frame);
  assert.ok(r.ok, r.error);
});

test("full outbound vocabulary round-trips through builders + schemas", () => {
  const frames = [
    msg.typing("/p"),
    msg.step("/p", "bash"),
    msg.usage("/p", 10, 20),
    msg.done("/p"),
    msg.error("/p", "nope"),
  ];
  for (const f of frames) {
    const r = validateOutbound(f);
    assert.ok(r.ok, `${f.type}/${f.phase ?? ""}: ${r.error}`);
  }
});

test("tool lifecycle: step (with id/args) + tool_end round-trip", () => {
  const start = msg.step("/p", "bash", "call-9", { cmd: "ls" });
  assert.equal(start.toolCallId, "call-9");
  assert.ok(validateOutbound(start).ok, validateOutbound(start).error);
  // step id/args are optional — bare step still validates
  assert.ok(validateOutbound(msg.step("/p", "bash")).ok);

  const end = msg.toolEnd("/p", "call-9", "bash", true);
  const r = validateOutbound(end);
  assert.ok(r.ok, r.error);
  assert.equal(r.value.ok, true);
  // tool_end requires toolCallId + ok
  assert.equal(validateOutbound({ type: OUT.TOOL_END, project: "/p", tool: "bash" }).ok, false);
});

test("resume frame round-trips (tool present or null)", () => {
  assert.ok(validateOutbound(msg.resume("/p", "partial output so far", "bash")).ok);
  const noTool = msg.resume("/p", "", null);
  const r = validateOutbound(noTool);
  assert.ok(r.ok, r.error);
  assert.equal(r.value.tool, null);
  // tool must be string|null, not undefined-as-missing
  assert.equal(validateOutbound({ type: OUT.RESUME, project: "/p", text: "x" }).ok, false);
});

test("abort inbound round-trips", () => {
  const r = validateInbound(msg.abort("/p"));
  assert.ok(r.ok, r.error);
});

test("malformed frames are rejected", () => {
  assert.equal(validateOutbound({ type: OUT.HELLO }).ok, false); // missing version/projects
  assert.equal(validateOutbound({ type: OUT.DELTA, project: "/p" }).ok, false); // missing text
  assert.equal(validateInbound({ type: IN.USER, project: "", text: "" }).ok, false); // empty strings
  assert.equal(validateOutbound({ type: "nope" }).ok, false); // unknown type
  assert.equal(validateInbound(null).ok, false);
});

test("dispatcher routes by type and falls back on unknown", () => {
  const seen = [];
  const dispatch = makeDispatcher(
    { [OUT.DELTA]: (f) => seen.push(["delta", f.text]) },
    (f) => seen.push(["unknown", f?.type]),
  );
  dispatch(msg.delta("/p", "x"));
  dispatch({ type: "weird" });
  assert.deepEqual(seen, [["delta", "x"], ["unknown", "weird"]]);
});
