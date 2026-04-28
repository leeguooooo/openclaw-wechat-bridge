import { afterEach, describe, expect, it } from "vitest";

import {
  __resetBridgeLocksForTests,
  tryAcquireBridgeLock,
} from "../src/bridge-lock";

afterEach(() => {
  __resetBridgeLocksForTests();
});

describe("tryAcquireBridgeLock", () => {
  it("grants a lock for an unlocked baseUrl", () => {
    const result = tryAcquireBridgeLock("http://127.0.0.1:18400");
    expect(result.ok).toBe(true);
  });

  it("rejects a second acquire on the same baseUrl until released", () => {
    const first = tryAcquireBridgeLock("http://127.0.0.1:18400");
    const second = tryAcquireBridgeLock("http://127.0.0.1:18400");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (first.ok) first.release();
    const third = tryAcquireBridgeLock("http://127.0.0.1:18400");
    expect(third.ok).toBe(true);
  });

  it("isolates locks across distinct baseUrls", () => {
    const a = tryAcquireBridgeLock("http://127.0.0.1:18400");
    const b = tryAcquireBridgeLock("http://192.0.2.1:18400");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("ignores a stale release from a previous owner (compare-and-delete)", () => {
    // Owner A acquires, owner B releases A by accident? With
    // compare-and-delete on token equality, B's release is a no-op.
    const ownerA = tryAcquireBridgeLock("http://127.0.0.1:18400");
    expect(ownerA.ok).toBe(true);
    if (ownerA.ok) ownerA.release();
    const ownerB = tryAcquireBridgeLock("http://127.0.0.1:18400");
    expect(ownerB.ok).toBe(true);
    if (ownerA.ok) ownerA.release(); // A's stale release after B took over
    // B should still hold the lock — a third acquire must fail.
    const thirdTry = tryAcquireBridgeLock("http://127.0.0.1:18400");
    expect(thirdTry.ok).toBe(false);
  });
});
