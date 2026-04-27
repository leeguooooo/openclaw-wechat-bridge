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

export type SendBody = {
  chatId: string;
  message: string;
  mentions?: string[];
};

export type SendResponse = {
  success?: boolean;
  messageId?: string;
  error?: string;
  message?: string;
};

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

  /** GET /health — probe used by the gateway's health monitor. */
  async checkHealth(): Promise<RequestJsonResult<BridgeHealth>> {
    return this.requestJson<BridgeHealth>("GET", "/health", { timeoutMs: 10_000 });
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
   * Returns the parsed response shape directly so caller can fan out
   * `success/messageId/error` to openclaw's SendResult.
   */
  async send(body: SendBody): Promise<RequestJsonResult<SendResponse>> {
    return this.requestJson<SendResponse>("POST", "/send", { body });
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

    for await (const chunk of response.body as AsyncIterable<Buffer>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const line = rawLine.replace(/\r$/, "");
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (!payload) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
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
      }
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
