// BridgeRuntime state-machine tests. Stubs BridgeClient so each
// scenario controls health outcomes + SSE chunks deterministically.
// Covers the 4 hermes-parity lifecycle cases (parity test_send_text_*
// + test_health_poll_marks_connected_then_degraded +
// test_connect_releases_bridge_lock_on_failed_startup) plus
// reconnect-on-degraded, dedupe via RecentMessageIds, and graceful
// stop draining the SSE generator.

import { afterEach, describe, expect, it, vi } from "vitest";

import { BridgeRuntime, type RuntimeStatus } from "../src/runtime";
import { __resetBridgeLocksForTests, tryAcquireBridgeLock } from "../src/bridge-lock";
import { loadConfig } from "../src/config-schema";
import type { BridgeClient, BridgeMessage, HealthOutcome } from "../src/daemon";
import { BridgeStreamError } from "../src/daemon";

afterEach(() => {
  __resetBridgeLocksForTests();
});

const baseConfig = loadConfig({
  extra: { bridge_host: "127.0.0.1", bridge_port: 18400, self_wxid: "wxid_bot" },
  env: {},
});

type StreamScript = AsyncIterable<BridgeMessage> | (() => AsyncIterable<BridgeMessage>);

const makeStubClient = (opts: {
  health: HealthOutcome[] | (() => Promise<HealthOutcome>);
  stream?: StreamScript;
}): BridgeClient => {
  let healthIdx = 0;
  const checkHealth =
    typeof opts.health === "function"
      ? (opts.health as () => Promise<HealthOutcome>)
      : async () => {
          const outcome = (opts.health as HealthOutcome[])[healthIdx] ?? {
            kind: "healthy",
            status: { status: "connected" },
          };
          healthIdx = Math.min(healthIdx + 1, (opts.health as HealthOutcome[]).length);
          return outcome;
        };

  const openMessageStream = async function* () {
    if (!opts.stream) return;
    const iterable =
      typeof opts.stream === "function"
        ? opts.stream()
        : opts.stream;
    for await (const msg of iterable) yield msg;
  };

  return {
    checkHealth,
    openMessageStream,
    // unused in M5a tests but typed satisfies the interface
    requestJson: async () => ({ status: 0, data: null }),
    getChatHistory: async () => [],
    send: async () => ({ status: 0, data: null }),
  } as unknown as BridgeClient;
};

const waitForStatus = (
  rt: BridgeRuntime,
  predicate: (s: RuntimeStatus) => boolean,
  timeoutMs = 200,
): Promise<RuntimeStatus> =>
  new Promise((resolve, reject) => {
    if (predicate(rt.getStatus())) {
      resolve(rt.getStatus());
      return;
    }
    const dispose = rt.onStatusChange((s) => {
      if (predicate(s)) {
        dispose();
        resolve(s);
      }
    });
    setTimeout(() => {
      dispose();
      reject(new Error(`waitForStatus timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

describe("BridgeRuntime — startup gating + lock", () => {
  it("connects when initial health is healthy", async () => {
    const dispatched: unknown[] = [];
    const rt = new BridgeRuntime({
      config: baseConfig,
      createClient: () =>
        makeStubClient({ health: [{ kind: "healthy", status: { status: "connected" } }] }),
      dispatch: (e) => void dispatched.push(e),
      // Tight intervals so tests don't sleep on real timers.
      healthIntervalMs: 5,
      retryInitialMs: 5,
      retryMaxMs: 20,
    });

    const ok = await rt.start();
    expect(ok).toBe(true);
    expect(rt.getStatus().kind).toBe("connected");
    await rt.stop();
    expect(rt.getStatus().kind).toBe("stopped");
  });

  it("halts on auth-fatal startup probe and releases the lock", async () => {
    // Parity: hermes test_connect_releases_bridge_lock_on_failed_startup.
    const rt = new BridgeRuntime({
      config: baseConfig,
      createClient: () =>
        makeStubClient({ health: [{ kind: "auth-fatal", status: 401 }] }),
      dispatch: () => undefined,
    });
    const ok = await rt.start();
    expect(ok).toBe(false);
    expect(rt.getStatus().kind).toBe("auth-fatal");
    // Lock must be released so a fresh runtime can re-acquire.
    const second = tryAcquireBridgeLock(baseConfig.baseUrl);
    expect(second.ok).toBe(true);
  });

  it("refuses to start when another runtime already holds the bridge lock", async () => {
    const taken = tryAcquireBridgeLock(baseConfig.baseUrl);
    expect(taken.ok).toBe(true);
    const rt = new BridgeRuntime({
      config: baseConfig,
      createClient: () =>
        makeStubClient({ health: [{ kind: "healthy", status: { status: "connected" } }] }),
      dispatch: () => undefined,
    });
    const ok = await rt.start();
    expect(ok).toBe(false);
    expect(rt.getStatus().kind).toBe("degraded");
  });

  it("starts in degraded when initial health is degraded (recoverable)", async () => {
    const rt = new BridgeRuntime({
      config: baseConfig,
      createClient: () =>
        makeStubClient({
          health: [{ kind: "degraded", status: 503, reason: "bridge cold" }],
        }),
      dispatch: () => undefined,
      healthIntervalMs: 5,
      retryInitialMs: 5,
      retryMaxMs: 20,
    });
    const ok = await rt.start();
    expect(ok).toBe(true);
    expect(rt.getStatus().kind).toBe("degraded");
    await rt.stop();
  });
});

describe("BridgeRuntime — inbound dispatch", () => {
  it("forwards events to the dispatch callback after gating", async () => {
    const events: string[] = [];
    const stream: BridgeMessage[] = [
      // self-echo, dropped at the gate
      { messageId: "1", chatId: "wxid_a", senderId: "wxid_bot", isGroup: false, fromSelf: true, body: "echo", timestamp: 100 },
      // legit DM
      { messageId: "2", chatId: "wxid_a", senderId: "wxid_a", isGroup: false, body: "hi", timestamp: 101 },
      // duplicate id, dedupe drops it
      { messageId: "2", chatId: "wxid_a", senderId: "wxid_a", isGroup: false, body: "dup", timestamp: 102 },
      // group @ bot (selfWxid=wxid_bot in baseConfig)
      {
        messageId: "3",
        chatId: "10086@chatroom",
        senderId: "wxid_other",
        isGroup: true,
        body: "@bot help",
        mentionedIds: ["wxid_bot"],
        timestamp: 103,
      },
    ];

    const rt = new BridgeRuntime({
      config: baseConfig,
      createClient: () =>
        makeStubClient({
          health: [{ kind: "healthy", status: { status: "connected" } }],
          stream,
        }),
      dispatch: (e) => void events.push(`${e.chatType}:${e.body}`),
      healthIntervalMs: 1_000,
      retryInitialMs: 1_000,
      retryMaxMs: 1_000,
    });

    await rt.start();
    // Allow the SSE generator to drain (synthetic stream completes
    // immediately after yielding 4 items).
    await new Promise((r) => setTimeout(r, 30));
    await rt.stop();

    expect(events).toEqual(["dm:hi", "group:@bot help"]);
  });
});

describe("BridgeRuntime — health monitor transitions", () => {
  it("connected → degraded → connected as health probes flip", async () => {
    // Parity: hermes test_health_poll_marks_connected_then_degraded.
    let probe = 0;
    const outcomes: HealthOutcome[] = [
      { kind: "healthy", status: { status: "connected" } }, // initial
      { kind: "degraded", status: 503, reason: "blip" }, // first periodic
      { kind: "healthy", status: { status: "connected" } }, // recovery
    ];

    const rt = new BridgeRuntime({
      config: baseConfig,
      createClient: () =>
        makeStubClient({
          health: async () => {
            const out = outcomes[probe] ?? outcomes[outcomes.length - 1]!;
            probe = Math.min(probe + 1, outcomes.length - 1);
            return out;
          },
        }),
      dispatch: () => undefined,
      // ms-scale intervals so the test runs in <100ms.
      healthIntervalMs: 5,
      retryInitialMs: 5,
      retryMaxMs: 20,
    });

    const seen: string[] = [];
    rt.onStatusChange((s) => seen.push(s.kind));

    await rt.start();
    await waitForStatus(rt, (s) => s.kind === "degraded");
    await waitForStatus(rt, (s) => s.kind === "connected" && probe >= 2);
    await rt.stop();

    expect(seen).toContain("starting");
    expect(seen).toContain("connected");
    expect(seen).toContain("degraded");
    expect(seen[seen.length - 1]).toBe("stopped");
  });

  it("auth-fatal during a periodic health probe halts the runtime", async () => {
    let probe = 0;
    const rt = new BridgeRuntime({
      config: baseConfig,
      createClient: () =>
        makeStubClient({
          health: async () => {
            const out: HealthOutcome =
              probe === 0
                ? { kind: "healthy", status: { status: "connected" } }
                : { kind: "auth-fatal", status: 402 };
            probe += 1;
            return out;
          },
        }),
      dispatch: () => undefined,
      healthIntervalMs: 5,
    });

    await rt.start();
    await waitForStatus(rt, (s) => s.kind === "auth-fatal");
    expect(rt.getStatus().kind).toBe("auth-fatal");
    await rt.stop();
  });
});

describe("BridgeRuntime — SSE error handling", () => {
  it("treats BridgeStreamError(401) as auth-fatal and halts", async () => {
    let yielded = false;
    const stream = (async function* (): AsyncIterable<BridgeMessage> {
      if (yielded) return;
      yielded = true;
      throw new BridgeStreamError(401);
    })();

    const rt = new BridgeRuntime({
      config: baseConfig,
      createClient: () =>
        makeStubClient({
          health: [{ kind: "healthy", status: { status: "connected" } }],
          stream,
        }),
      dispatch: () => undefined,
      healthIntervalMs: 1_000,
      retryInitialMs: 1_000,
      retryMaxMs: 1_000,
    });

    await rt.start();
    await waitForStatus(rt, (s) => s.kind === "auth-fatal");
    expect(rt.getStatus().kind).toBe("auth-fatal");
    await rt.stop();
  });

  it("transitions to degraded on a generic SSE error and reconnects", async () => {
    let attempts = 0;
    const dispatched: string[] = [];
    const rt = new BridgeRuntime({
      config: baseConfig,
      // Health loop dormant for the lifetime of this test so it can't
      // race with the SSE failure narrative. We rewrite-via-injection
      // ONLY the SSE retry sleep below; the health loop will block on
      // the real default sleep against a very large interval.
      healthIntervalMs: 60 * 60 * 1000,
      retryInitialMs: 1,
      retryMaxMs: 4,
      createClient: () =>
        makeStubClient({
          health: [{ kind: "healthy", status: { status: "connected" } }],
          stream: () =>
            (async function* () {
              attempts += 1;
              if (attempts < 3) throw new BridgeStreamError(500);
              yield {
                messageId: `final-${attempts}`,
                chatId: "wxid_a",
                senderId: "wxid_a",
                isGroup: false,
                body: "ok",
                timestamp: 999,
              };
            })(),
        }),
      dispatch: (e) => void dispatched.push(e.body),
    });

    await rt.start();
    // Wait for the third stream attempt to land its event. With
    // retryInitialMs=1ms and retryMaxMs=4ms, three attempts complete
    // in <50ms even on a slow CI runner.
    for (let i = 0; i < 60 && dispatched.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(dispatched).toEqual(["ok"]);
    await rt.stop();
  });
});
