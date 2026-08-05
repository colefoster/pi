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
