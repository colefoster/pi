// Hermetic tests for the lead cache — no SDK, no sessions. Exercises the
// lifecycle contract the harness depends on: create-once, evict-on-reject,
// dispose-on-clear.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLeadCache } from "../leadCache.mjs";

const noopDispose = () => {};

test("creates once and caches the same promise", async () => {
  let calls = 0;
  const cache = createLeadCache({ dispose: noopDispose });
  const factory = () => Promise.resolve({ n: ++calls });

  const a = cache.getOrCreate("k", factory);
  const b = cache.getOrCreate("k", factory);
  assert.equal(a, b, "same key returns the same cached promise");
  assert.equal((await a).n, 1);
  assert.equal(calls, 1, "factory ran exactly once");
  assert.equal(cache.size, 1);
  assert.ok(cache.has("k"));
});

test("evicts a rejected creation so the next call retries", async () => {
  let attempt = 0;
  const cache = createLeadCache({ dispose: noopDispose });
  const factory = () => {
    attempt += 1;
    return attempt === 1 ? Promise.reject(new Error("transient")) : Promise.resolve({ ok: true });
  };

  await assert.rejects(cache.getOrCreate("k", factory), /transient/);
  // give the .catch eviction a microtask to run
  await Promise.resolve();
  assert.equal(cache.has("k"), false, "failed creation was evicted, not cached forever");

  const retry = await cache.getOrCreate("k", factory);
  assert.deepEqual(retry, { ok: true }, "next call retries cleanly");
  assert.equal(attempt, 2);
});

test("disposeAll disposes every lead (awaiting resolution) and empties", async () => {
  const disposed = [];
  const cache = createLeadCache({
    dispose: (p) => Promise.resolve(p).then((lead) => disposed.push(lead.id)).catch(() => {}),
  });
  cache.getOrCreate("a", () => Promise.resolve({ id: "a" }));
  cache.getOrCreate("b", () => Promise.resolve({ id: "b" }));
  assert.equal(cache.size, 2);

  cache.disposeAll();
  assert.equal(cache.size, 0, "cache emptied synchronously");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(disposed.sort(), ["a", "b"], "each lead disposed once resolved");
});

test("disposeAll on a still-pending, never-resolving lead does not throw", () => {
  const cache = createLeadCache({ dispose: (p) => Promise.resolve(p).catch(() => {}) });
  cache.getOrCreate("slow", () => new Promise(() => {})); // never resolves
  assert.doesNotThrow(() => cache.disposeAll());
  assert.equal(cache.size, 0);
});
