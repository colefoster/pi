// A small, testable cache of lazily-created agents (one live agent session per
// project), keyed by project id. Deep module: the whole lifecycle contract —
// create-once, evict-a-failed-creation, dispose-on-clear — lives behind four
// methods and has no dependency on the SDK, so it can be unit-tested in
// isolation. The harness injects how an agent is disposed.

/**
 * @param {object} opts
 * @param {(agentOrPromise: any) => void} opts.dispose  tear down a (possibly still-pending) agent
 */
export function createAgentCache({ dispose }) {
  const map = new Map(); // id -> Promise<agent>

  return {
    /**
     * Return the cached agent promise for `key`, creating it via `factory` on
     * first use. A rejected creation is evicted (not cached forever), so one
     * transient failure never permanently bricks the key.
     */
    getOrCreate(key, factory) {
      let p = map.get(key);
      if (!p) {
        p = Promise.resolve().then(factory);
        p.catch(() => {
          if (map.get(key) === p) map.delete(key);
        });
        map.set(key, p);
      }
      return p;
    },
    has(key) {
      return map.has(key);
    },
    get(key) {
      return map.get(key);
    },
    /** Dispose every cached agent and empty the cache. */
    disposeAll() {
      for (const p of map.values()) dispose(p);
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}
