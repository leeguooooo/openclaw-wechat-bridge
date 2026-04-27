// Per-process bridge lock. One openclaw gateway process should never
// open more than one SSE consume loop against the same wechat-bridge —
// the bridge serializes consumers per-cursor and the second connection
// kicks the first off, causing message loss + churn.
//
// Python adapter uses an OS-level pid-file lock keyed by
// (`wechat-bridge`, baseUrl) — see hermes-agent/gateway/platforms/base.py
// `_acquire_platform_lock`. We don't ship a cross-process equivalent
// here because openclaw runs as a single Node process per machine; if
// the operator spawns two gateway processes against one bridge, both
// will get the lock individually and discover the SSE-side conflict
// at runtime via the bridge's 409 response. M5b will wire that into
// the runtime's auth-fatal style halt.
//
// The Map is keyed by `wechat-bridge:${baseUrl}` so multiple bridge
// configs (different ports, different hosts) on the same machine each
// get their own slot.

const locks = new Map<string, symbol>();

export type BridgeLock = {
  ok: true;
  release: () => void;
};

export type BridgeLockResult = BridgeLock | { ok: false };

export function tryAcquireBridgeLock(baseUrl: string): BridgeLockResult {
  const key = `wechat-bridge:${baseUrl}`;
  if (locks.has(key)) return { ok: false };
  const token = Symbol(key);
  locks.set(key, token);
  return {
    ok: true,
    release: () => {
      // Compare-and-delete so a delayed release from a previous owner
      // doesn't accidentally release the new owner's lock.
      if (locks.get(key) === token) locks.delete(key);
    },
  };
}

/** Test-only: clear all locks. Not exported through the package
 *  index — vitest can reach it directly. */
export function __resetBridgeLocksForTests(): void {
  locks.clear();
}
