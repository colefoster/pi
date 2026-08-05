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
    msg.subagentStart("/p", "call-1", "dig into X", "gpt-5.6-sol"),
    msg.subagentEnd("/p", "call-1", true, "findings"),
    msg.subagentEnd("/p", "call-1", false, "boom"),
    msg.done("/p"),
    msg.error("/p", "nope"),
  ];
  for (const f of frames) {
    const r = validateOutbound(f);
    assert.ok(r.ok, `${f.type}/${f.phase ?? ""}: ${r.error}`);
  }
});

test("subagent discriminated union rejects mixed shapes", () => {
  // phase:start must not carry end-only fields as its whole shape
  assert.equal(validateOutbound({ type: OUT.SUBAGENT, project: "/p", id: "x", phase: "start" }).ok, false); // missing task
  assert.equal(validateOutbound({ type: OUT.SUBAGENT, project: "/p", id: "x", phase: "end", ok: true }).ok, false); // missing result
  assert.equal(validateOutbound({ type: OUT.SUBAGENT, project: "/p", id: "x", phase: "bogus" }).ok, false);
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
