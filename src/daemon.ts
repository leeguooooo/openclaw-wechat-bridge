// HTTP/SSE client for the local wechat-bridge daemon. Mirrors what the
// Python adapter (hermes-agent/gateway/platforms/wechat.py) does over
// aiohttp; we use undici here because openclaw's other channel plugins
// (e.g. signal) standardize on it and the streaming API maps cleanly
// onto the bridge's SSE shape.
//
// Three concerns lives here, intentionally co-located:
//   1. Unary requests (`requestJson`) — JSON GET/POST, normalized status
//      mapping (200/401/402/503), bearer header injection.
//   2. Streaming SSE consume (`openMessageStream`) — async-iterable of
//      payloads, accepts BOTH single-event (`data: {...}`) and batched
//      (`data: [...]`) frames. Heartbeats (`:`) are dropped silently.
//   3. Health probe + history fetch — unary helpers tuned to the
//      bridge's documented response shape.
//
// All three honor the constants in config-schema.ts so the timing
// behavior matches the Python adapter run-for-run.

import { request } from "undici";

import {
  HTTP_CONNECT_TIMEOUT_MS,
  HTTP_READ_TIMEOUT_MS,
  SEND_RETRYABLE_STATUSES,
  SSE_READ_TIMEOUT_MS,
  type WeChatBridgeConfig,
} from "./config-schema.js";

export type BridgeHealthStatus = "connected" | "disconnected" | "degraded" | "unknown";

export type BridgeHealth = {
  status: BridgeHealthStatus;
  hijackArmed?: boolean;
  wechatPid?: number;
  uptime?: number;
};

/**
 * Bridge SSE message shape, normalized. Field names match the bridge's
 * `--shape hermes` payload exactly so this type doubles as the
 * inbound-event source of truth for inbound-context.ts (M3).
 */
export type BridgeMessage = {
  messageId?: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  chatName?: string;
  isGroup?: boolean;
  body?: string;
  hasMedia?: boolean;
  mediaType?: string;
  mediaUrls?: string[];
  mentionedIds?: string[];
  quotedParticipant?: string;
  botIds?: string[];
  fromSelf?: boolean;
  isMentioned?: boolean;
  timestamp?: number;
};

export type RequestJsonResult<T = unknown> = {
  status: number;
  data: T | null;
};

/**
 * `/send` body shape. Bridge v1.10.39 unified the field names across
 * `--shape native` and `--shape hermes` to `{wxid, text}` — earlier
 * versions accepted `{chatId, message}` under `--shape hermes`. Live
 * test on 192.168.0.190 against bridge 1.10.39:
 *   {chatId, message} -> 400 missing field `wxid`
 *   {wxid, message}   -> 400 missing field `text`
 *   {wxid, text}      -> accepted, send dispatched
 *
 * Pinning to {wxid, text} aligns with the current and future contract;
 * operators on older 1.10.x bridges will see a 400 here and need to
 * upgrade. Documented in the v0.0.2 CHANGELOG.
 */
export type SendBody = {
  wxid: string;
  text: string;
  mentions?: string[];
};

/**
 * Bridge v1.10.39 send response. Successful send sets
 * `{status: "sent"}` plus a messageId; failures land in `status:
 * "failed"` with rich diagnostic fields. `success` is the legacy
 * boolean we still read defensively for backward compat with older
 * bridges that hadn't migrated to the tagged status string.
 */
export type SendResponse = {
  success?: boolean;
  status?: "sent" | "failed";
  messageId?: string;
  error?: string;
  message?: string;
  reason?: string;
  user_facing_zh?: string;
  delivered_verified?: boolean;
};

/**
 * Health outcome mapped from a raw `/health` probe. The runtime layer
 * maps each variant onto openclaw's platform-state model; collapsing
 * the mapping into one place here matches the Python adapter's
 * `_check_health_once` (wechat.py:308-336) so the runtime can stay
 * dumb about HTTP status codes.
 */
export type HealthOutcome =
  | { kind: "healthy"; status: BridgeHealth }
  | { kind: "auth-fatal"; status: number }
  | { kind: "degraded"; reason: string; status: number };

const SEND_MAX_ATTEMPTS = 3;
const SEND_BACKOFF_BASE_MS = 1_000;

/**
 * Build standard request headers — Bearer iff configured, plus the
 * `Accept` header that signals to wechat-bridge we can handle either a
 * JSON body or an SSE stream. The header is identical to what the
 * Python adapter sends so bridge-side logging stays interchangeable.
 */
function requestHeaders(config: WeChatBridgeConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
  };
  if (config.bridgeBearer) {
    headers.Authorization = `Bearer ${config.bridgeBearer}`;
  }
  return headers;
}

export class BridgeClient {
  private readonly config: WeChatBridgeConfig;

  constructor(config: WeChatBridgeConfig) {
    this.config = config;
  }

  /**
   * One-shot JSON request. Status is returned alongside parsed body so
   * callers can distinguish 401/402 (auth-expired, fatal) from 503
   * (transient, retryable) from network timeouts (also retryable).
   * Body parse errors collapse into status=0 + data=null — same as the
   * Python adapter's behavior.
   */
  async requestJson<T = unknown>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; timeoutMs?: number } = {},
  ): Promise<RequestJsonResult<T>> {
    const url = `${this.config.baseUrl}${path}`;
    const timeout = options.timeoutMs ?? HTTP_READ_TIMEOUT_MS;

    // Use a permissive Parameters<typeof request>[1] rather than
    // Dispatcher.RequestOptions: the latter requires `path`, but the
    // (url, options) overload of `request` derives path from the url.
    const init: Parameters<typeof request>[1] = {
      method,
      headers: {
        ...requestHeaders(this.config),
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      headersTimeout: HTTP_CONNECT_TIMEOUT_MS,
      bodyTimeout: timeout,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    };

    try {
      const response = await request(url, init);
      let parsed: T | null = null;
      try {
        parsed = (await response.body.json()) as T;
      } catch {
        // Non-JSON body (or empty). Drain to free the connection.
        try {
          await response.body.text();
        } catch {
          /* ignore */
        }
      }
      return { status: response.statusCode, data: parsed };
    } catch (err) {
      // Network error (DNS, ECONNREFUSED, timeout). Surface status=0 so
      // callers reach the same retry path as a 5xx.
      void err;
      return { status: 0, data: null };
    }
  }

  /**
   * GET /health — probe used by the gateway's health monitor.
   *
   * Returns a tagged outcome so the runtime layer can stay decoupled
   * from HTTP status codes:
   *   - 200 with `{status: "connected"}`  → healthy
   *   - 200 with any other status string  → degraded
   *   - 401 or 402                         → auth-fatal (don't retry)
   *   - 503 / other non-200 / network err → degraded (retryable)
   *
   * Mirrors the branch structure of wechat.py:308-336 so behavior is
   * identical to hermes-agent run-for-run.
   */
  async checkHealth(): Promise<HealthOutcome> {
    const { status, data } = await this.requestJson<BridgeHealth>("GET", "/health", {
      timeoutMs: 10_000,
    });
    if (status === 401 || status === 402) {
      return { kind: "auth-fatal", status };
    }
    if (status !== 200) {
      // 0 = transport error; 503 = bridge says retry; anything else
      // (404, 500, 502 from a misconfigured proxy) collapses to the
      // same retryable-degraded path.
      return {
        kind: "degraded",
        status,
        reason:
          status === 0
            ? "WeChat bridge unreachable"
            : status === 503
              ? "WeChat bridge temporarily unavailable (503)"
              : `WeChat bridge health check failed (${status})`,
      };
    }
    const bridgeStatus = String((data?.status ?? "unknown")).trim().toLowerCase();
    if (bridgeStatus === "connected") {
      return { kind: "healthy", status: data ?? { status: "connected" } };
    }
    return {
      kind: "degraded",
      status,
      reason: `WeChat bridge status is ${bridgeStatus || "unknown"}`,
    };
  }

  /**
   * GET /chat/:wxid/history — best-effort recent message fetch.
   *
   * Bridge has shipped both raw-list and `{data: list}`-wrapped
   * payloads across versions; we accept both so the plugin doesn't
   * silently drop history rows after a bridge upgrade. Same tolerance
   * the Python adapter has (gateway/platforms/wechat.py:266-294).
   */
  async getChatHistory(
    chatId: string,
    options: { limit?: number; since?: number; until?: number } = {},
  ): Promise<BridgeMessage[]> {
    const params: string[] = [`limit=${Math.max(1, options.limit ?? 20)}`];
    if (options.since !== undefined) params.push(`since=${Math.trunc(options.since)}`);
    if (options.until !== undefined) params.push(`until=${Math.trunc(options.until)}`);
    const path = `/chat/${encodeURIComponent(chatId)}/history?${params.join("&")}`;
    const { status, data } = await this.requestJson<unknown>("GET", path, { timeoutMs: 15_000 });
    if (status !== 200 || data == null) return [];
    if (Array.isArray(data)) return data as BridgeMessage[];
    if (typeof data === "object" && Array.isArray((data as { data?: unknown }).data)) {
      return (data as { data: BridgeMessage[] }).data;
    }
    return [];
  }

  /**
   * POST /send — outbound text message. Bridge accepts a `mentions`
   * field that maps to atuserlist on the WeChat side; we forward it
   * iff the caller supplied one.
   *
   * Retries up to SEND_MAX_ATTEMPTS times on `SEND_RETRYABLE_STATUSES`
   * (currently just 503). Backoff is linear+jitter, capped at
   * SEND_BACKOFF_BASE_MS * attempt. Mirrors the Python adapter's retry
   * shape (wechat.py:200-254 + wechat.py:568-579) so a transient bridge
   * blip doesn't surface as a user-visible send failure when both
   * implementations would retry past it.
   *
   * 401/402 are NOT retried — auth-expired is fatal up the call chain
   * and retrying just delays the user-visible error.
   */
  async send(body: SendBody): Promise<RequestJsonResult<SendResponse>> {
    let last: RequestJsonResult<SendResponse> = { status: 0, data: null };
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt += 1) {
      last = await this.requestJson<SendResponse>("POST", "/send", { body });
      if (!SEND_RETRYABLE_STATUSES.has(last.status) || attempt === SEND_MAX_ATTEMPTS) {
        return last;
      }
      // Linear backoff with mild jitter — keep total worst-case at ~3s
      // so the caller's outer timeout budget (~10-30s) isn't blown on
      // retry alone.
      const jitter = Math.floor(Math.random() * 250);
      await sleep(SEND_BACKOFF_BASE_MS * attempt + jitter);
    }
    return last;
  }

  /**
   * GET /messages/stream — SSE consume.
   *
   * Yields one BridgeMessage per inbound event. The bridge's `--shape
   * hermes` mode currently emits a single `data: {...}` per frame, but
   * earlier versions batched multiple events into one `data: [...]`
   * frame; we accept both so a bridge downgrade doesn't break us.
   *
   * Heartbeats (lines starting with `:`) and unknown event types are
   * silently dropped. The caller is expected to translate `cursor`
   * advancement back to `since` on reconnect — we deliberately do NOT
   * track cursor state in the client because reconnect logic belongs
   * with the runtime, not the transport.
   */
  async *openMessageStream(opts: {
    since: number;
    abortSignal?: AbortSignal;
  }): AsyncGenerator<BridgeMessage, void, void> {
    const url = `${this.config.baseUrl}/messages/stream?since=${Math.trunc(opts.since)}`;
    const response = await request(url, {
      method: "GET",
      headers: requestHeaders(this.config),
      headersTimeout: HTTP_CONNECT_TIMEOUT_MS,
      bodyTimeout: SSE_READ_TIMEOUT_MS,
      signal: opts.abortSignal,
    });

    if (response.statusCode !== 200) {
      // Drain the body so the dispatcher can recycle the socket; let
      // the runtime layer interpret the status code (auth/degraded/etc).
      try {
        await response.body.text();
      } catch {
        /* ignore */
      }
      throw new BridgeStreamError(response.statusCode);
    }

    const decoder = new TextDecoder();
    let buffer = "";

    const tryProcessLine = function* (
      this: void,
      raw: string,
    ): Generator<BridgeMessage, void, void> {
      const line = raw.replace(/\r$/, "");
      if (!line || line.startsWith(":")) return;
      if (!line.startsWith("data:")) return;
      const payload = line.slice("data:".length).trim();
      if (!payload) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry && typeof entry === "object") {
            yield entry as BridgeMessage;
          }
        }
      } else if (parsed && typeof parsed === "object") {
        yield parsed as BridgeMessage;
      }
    };

    for await (const chunk of response.body as AsyncIterable<Buffer>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        yield* tryProcessLine(rawLine);
      }
    }

    // Flush: drain any remaining bytes in the decoder (multi-byte char
    // boundaries) and yield the trailing partial line if the stream
    // ended without a final \n. Without this, a bridge graceful close
    // mid-frame can drop the last event we should have processed.
    buffer += decoder.decode();
    if (buffer.length > 0) {
      yield* tryProcessLine(buffer);
    }
  }
}

export class BridgeStreamError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`bridge SSE returned status ${status}`);
    this.name = "BridgeStreamError";
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
