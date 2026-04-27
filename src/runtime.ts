// BridgeRuntime — orchestrates the long-lived connection between the
// plugin and the wechat-bridge daemon. Owns the bridge lock, the SSE
// consume loop with reconnect+backoff, and the health monitor.
//
// Inbound dispatch is intentionally not wired in this milestone (M5a).
// Callers pass a `dispatch` callback that receives normalized
// WeChatInboundEvents; M5b will replace it with openclaw's
// `dispatchInboundMessage` helper from `openclaw/plugin-sdk/reply-runtime`.
// Splitting this seam keeps the state machine fully unit-testable
// without dragging in the full openclaw reply pipeline.

import {
  BridgeClient,
  BridgeStreamError,
  type BridgeMessage,
} from "./daemon.js";
import {
  type WeChatBridgeConfig,
  HEALTH_CHECK_INTERVAL_MS,
  SSE_RETRY_DELAY_INITIAL_MS,
  SSE_RETRY_DELAY_MAX_MS,
} from "./config-schema.js";
import {
  buildInboundEvent,
  RecentMessageIds,
  type WeChatInboundEvent,
} from "./inbound-context.js";
import { tryAcquireBridgeLock, type BridgeLock } from "./bridge-lock.js";

export type RuntimeStatus =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "connected"; since: number }
  | { kind: "degraded"; reason: string; since: number }
  | { kind: "auth-fatal"; reason: string }
  | { kind: "stopped" };

export type RuntimeStatusListener = (status: RuntimeStatus) => void;

export type DispatchInbound = (event: WeChatInboundEvent) => void | Promise<void>;

export type BridgeRuntimeDeps = {
  config: WeChatBridgeConfig;
  /** Constructable for tests; default uses real BridgeClient. */
  createClient?: (config: WeChatBridgeConfig) => BridgeClient;
  /** M5a stub — replaced by openclaw dispatchInboundMessage in M5b. */
  dispatch: DispatchInbound;
  /** Override defaults so tests can shrink intervals to milliseconds. */
  healthIntervalMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
  /** Test seam for sleep so fake timers can drive the backoff path.
   *  The signal MUST be honored — stop() relies on it to interrupt
   *  long sleeps (a 20s health interval would otherwise block shutdown). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Initial cursor; defaults to (now - 5s) like the Python adapter. */
  initialCursor?: number;
};

/**
 * Abort-aware sleep. Resolves when EITHER the timeout fires OR the
 * supplied AbortSignal aborts. Without honoring the signal, `stop()`
 * would have to wait for the next health interval (potentially 20s)
 * before the loop noticed it should exit, blocking shutdown.
 */
const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

export class BridgeRuntime {
  private readonly client: BridgeClient;
  private readonly cfg: WeChatBridgeConfig;
  private readonly dispatch: DispatchInbound;
  private readonly healthIntervalMs: number;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly recent = new RecentMessageIds();

  private listeners: RuntimeStatusListener[] = [];
  private status: RuntimeStatus = { kind: "idle" };
  private lock: BridgeLock | null = null;
  private rootAbort: AbortController | null = null;
  private streamAbort: AbortController | null = null;
  private streamTask: Promise<void> | null = null;
  private healthTask: Promise<void> | null = null;
  private cursor: number;

  constructor(deps: BridgeRuntimeDeps) {
    this.cfg = deps.config;
    this.client = (deps.createClient ?? ((c) => new BridgeClient(c)))(this.cfg);
    this.dispatch = deps.dispatch;
    this.healthIntervalMs = deps.healthIntervalMs ?? HEALTH_CHECK_INTERVAL_MS;
    this.retryInitialMs = deps.retryInitialMs ?? SSE_RETRY_DELAY_INITIAL_MS;
    this.retryMaxMs = deps.retryMaxMs ?? SSE_RETRY_DELAY_MAX_MS;
    this.sleep = deps.sleep ?? defaultSleep;
    this.cursor = deps.initialCursor ?? Math.max(Math.floor(Date.now() / 1000) - 5, 0);
  }

  getStatus(): RuntimeStatus {
    return this.status;
  }

  onStatusChange(listener: RuntimeStatusListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Acquire the bridge lock, gate on a single /health probe, then spawn
   * the long-lived SSE + health tasks. Returns a `started` boolean so
   * callers can short-circuit registration if the bridge is unreachable
   * or auth-fatal.
   */
  async start(): Promise<boolean> {
    if (this.status.kind !== "idle" && this.status.kind !== "stopped") {
      return false;
    }

    this.setStatus({ kind: "starting" });

    const lock = tryAcquireBridgeLock(this.cfg.baseUrl);
    if (!lock.ok) {
      this.setStatus({
        kind: "degraded",
        reason: `Another consumer already holds the bridge lock for ${this.cfg.baseUrl}`,
        since: Date.now(),
      });
      return false;
    }
    this.lock = lock;

    // Initial health gate. Auth-fatal halts immediately; degraded is a
    // soft fail — we still spawn the loops so the health monitor can
    // recover when the bridge wakes back up.
    const initial = await this.client.checkHealth();
    if (initial.kind === "auth-fatal") {
      this.setStatus({
        kind: "auth-fatal",
        reason: `auth/subscription expired at startup (HTTP ${initial.status})`,
      });
      this.releaseLock();
      return false;
    }

    this.rootAbort = new AbortController();
    if (initial.kind === "healthy") {
      this.setStatus({ kind: "connected", since: Date.now() });
    } else {
      this.setStatus({ kind: "degraded", reason: initial.reason, since: Date.now() });
    }

    this.streamTask = this.runStreamLoop(this.rootAbort.signal);
    this.healthTask = this.runHealthLoop(this.rootAbort.signal);
    return true;
  }

  /**
   * Stop both tasks, drain the SSE response, release the lock. Safe to
   * call from any state — multiple stops collapse into a single
   * transition to "stopped".
   */
  async stop(): Promise<void> {
    if (this.status.kind === "idle" || this.status.kind === "stopped") {
      return;
    }
    this.rootAbort?.abort();
    this.streamAbort?.abort();
    const tasks = [this.streamTask, this.healthTask].filter(
      (t): t is Promise<void> => t !== null,
    );
    await Promise.allSettled(tasks);
    this.streamTask = null;
    this.healthTask = null;
    this.streamAbort = null;
    this.rootAbort = null;
    this.releaseLock();
    this.setStatus({ kind: "stopped" });
  }

  private async runStreamLoop(rootSignal: AbortSignal): Promise<void> {
    let backoff = this.retryInitialMs;
    while (!rootSignal.aborted) {
      const sseAbort = new AbortController();
      this.streamAbort = sseAbort;
      const onRootAbort = () => sseAbort.abort();
      rootSignal.addEventListener("abort", onRootAbort);

      try {
        for await (const msg of this.client.openMessageStream({
          since: this.cursor,
          abortSignal: sseAbort.signal,
        })) {
          if (rootSignal.aborted) break;
          this.processInbound(msg);
        }
        // Stream closed cleanly — bridge probably rotated or hit idle
        // timeout. Fall through to the reconnect path.
        backoff = this.retryInitialMs;
      } catch (err) {
        if (rootSignal.aborted) break;
        if (err instanceof BridgeStreamError && (err.status === 401 || err.status === 402)) {
          this.setStatus({
            kind: "auth-fatal",
            reason: `auth/subscription expired (HTTP ${err.status})`,
          });
          this.rootAbort?.abort();
          break;
        }
        const reason =
          err instanceof Error ? err.message : `SSE error: ${String(err)}`;
        this.setStatus({ kind: "degraded", reason, since: Date.now() });
      } finally {
        rootSignal.removeEventListener("abort", onRootAbort);
      }

      if (rootSignal.aborted) break;
      await this.sleep(backoff, rootSignal);
      backoff = Math.min(backoff * 2, this.retryMaxMs);
    }
  }

  private async runHealthLoop(rootSignal: AbortSignal): Promise<void> {
    while (!rootSignal.aborted) {
      await this.sleep(this.healthIntervalMs, rootSignal);
      if (rootSignal.aborted) break;

      let outcome;
      try {
        outcome = await this.client.checkHealth();
      } catch (err) {
        const reason =
          err instanceof Error ? err.message : `Health probe error: ${String(err)}`;
        this.setStatus({ kind: "degraded", reason, since: Date.now() });
        continue;
      }

      if (outcome.kind === "auth-fatal") {
        this.setStatus({
          kind: "auth-fatal",
          reason: `auth/subscription expired (HTTP ${outcome.status})`,
        });
        this.rootAbort?.abort();
        break;
      }
      if (outcome.kind === "degraded") {
        this.setStatus({ kind: "degraded", reason: outcome.reason, since: Date.now() });
        // Force the SSE loop to reconnect — the bridge may have just
        // come back online, and a stale long-lived stream wouldn't
        // notice without a kick.
        this.streamAbort?.abort();
        continue;
      }
      // healthy
      if (this.status.kind !== "connected") {
        this.setStatus({ kind: "connected", since: Date.now() });
      }
    }
  }

  private processInbound(msg: BridgeMessage): void {
    const messageId = (msg.messageId ?? "").toString().trim();
    if (messageId) {
      if (this.recent.has(messageId)) return;
      this.recent.add(messageId);
    }

    const ts = typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)
      ? msg.timestamp
      : null;
    if (ts !== null) this.cursor = Math.max(this.cursor, ts);

    const event = buildInboundEvent(msg, {
      selfWxid: this.cfg.selfWxid,
      requireMentionInGroups: this.cfg.requireMentionInGroups,
    });
    if (!event) return;

    // Fire-and-forget. M5b will route this through openclaw's
    // dispatchInboundMessage; for M5a the dispatcher is operator-supplied
    // so unit tests can assert on what the runtime would forward.
    Promise.resolve(this.dispatch(event)).catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      this.setStatus({ kind: "degraded", reason: `dispatch error: ${reason}`, since: Date.now() });
    });
  }

  private setStatus(next: RuntimeStatus): void {
    this.status = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        /* listener errors must not crash the runtime */
      }
    }
  }

  private releaseLock(): void {
    this.lock?.release();
    this.lock = null;
  }
}
