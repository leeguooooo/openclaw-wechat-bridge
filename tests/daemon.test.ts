// Daemon HTTP/SSE behavior tests. Mock undici.request via vi.mock so
// each test controls the exact response shape. Five cases:
//   - getChatHistory accepts both raw-list and {data: list} shapes
//     (mirrors hermes test_get_chat_history_returns_list_payload +
//     test_get_chat_history_accepts_wrapped_list_payload)
//   - openMessageStream handles batched-array data: frames
//     (mirrors hermes test_consume_sse_response_accepts_list_payloads)
//   - openMessageStream flushes the trailing partial line on EOF
//     (M2 review fix)
//   - send retries on 503 then succeeds
//     (M2 review fix; bridges past hermes test_send_text_happy_path)
//   - checkHealth maps 401 -> auth-fatal and 503 -> degraded
//     (M2 review fix)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BridgeClient } from "../src/daemon";
import { loadConfig, type WeChatBridgeConfig } from "../src/config-schema";

type MockResponse = {
  statusCode: number;
  body: {
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  } & AsyncIterable<Buffer>;
};

const undiciMock = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock("undici", () => ({
  request: undiciMock.request,
}));

const makeJsonResponse = (status: number, payload: unknown): MockResponse => {
  const text = JSON.stringify(payload);
  return {
    statusCode: status,
    body: {
      json: async () => payload,
      text: async () => text,
      // satisfy AsyncIterable<Buffer>
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(text);
      },
    },
  };
};

const makeStreamResponse = (chunks: string[], status = 200): MockResponse => ({
  statusCode: status,
  body: {
    json: async () => ({}),
    text: async () => chunks.join(""),
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield Buffer.from(chunk);
    },
  },
});

const config: WeChatBridgeConfig = loadConfig({
  extra: { bridge_host: "127.0.0.1", bridge_port: 18400 },
  env: {},
});

beforeEach(() => {
  undiciMock.request.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("BridgeClient.getChatHistory — accepts both list and wrapped payloads", () => {
  it("returns a raw-array history payload", async () => {
    undiciMock.request.mockResolvedValueOnce(
      makeJsonResponse(200, [{ messageId: "1", body: "hi" }]),
    );
    const client = new BridgeClient(config);
    const rows = await client.getChatHistory("filehelper");
    expect(rows).toEqual([{ messageId: "1", body: "hi" }]);
  });

  it("unwraps a {data: [...]} history payload", async () => {
    undiciMock.request.mockResolvedValueOnce(
      makeJsonResponse(200, { data: [{ messageId: "2", body: "yo" }] }),
    );
    const client = new BridgeClient(config);
    const rows = await client.getChatHistory("filehelper");
    expect(rows).toEqual([{ messageId: "2", body: "yo" }]);
  });

  it("returns [] on non-200 status", async () => {
    undiciMock.request.mockResolvedValueOnce(makeJsonResponse(500, "error"));
    const client = new BridgeClient(config);
    const rows = await client.getChatHistory("filehelper");
    expect(rows).toEqual([]);
  });
});

describe("BridgeClient.openMessageStream — SSE consume", () => {
  it("dispatches each entry of a batched-array data: frame", async () => {
    // hermes test_consume_sse_response_accepts_list_payloads parity
    const batched =
      'data: [{"messageId":"a","chatId":"filehelper","senderId":"filehelper","body":"hi"},' +
      '{"messageId":"b","chatId":"filehelper","senderId":"filehelper","body":"yo"}]\n\n';
    undiciMock.request.mockResolvedValueOnce(makeStreamResponse([batched]));
    const client = new BridgeClient(config);
    const seen: string[] = [];
    for await (const evt of client.openMessageStream({ since: 0 })) {
      seen.push(String(evt.messageId ?? ""));
    }
    expect(seen).toEqual(["a", "b"]);
  });

  it("dispatches a single-object data: frame", async () => {
    const single = 'data: {"messageId":"only","chatId":"filehelper","senderId":"filehelper"}\n\n';
    undiciMock.request.mockResolvedValueOnce(makeStreamResponse([single]));
    const client = new BridgeClient(config);
    const seen: string[] = [];
    for await (const evt of client.openMessageStream({ since: 0 })) {
      seen.push(String(evt.messageId ?? ""));
    }
    expect(seen).toEqual(["only"]);
  });

  it("flushes the trailing partial line on EOF (M2 review fix)", async () => {
    // Stream ends without a final \n. Old behavior: drop the last
    // event silently. New: flush the buffered remainder once iteration
    // ends. Without this, a bridge graceful close mid-frame loses
    // the last message.
    const noTrailingNewline = 'data: {"messageId":"final","chatId":"x","senderId":"x"}';
    undiciMock.request.mockResolvedValueOnce(makeStreamResponse([noTrailingNewline]));
    const client = new BridgeClient(config);
    const seen: string[] = [];
    for await (const evt of client.openMessageStream({ since: 0 })) {
      seen.push(String(evt.messageId ?? ""));
    }
    expect(seen).toEqual(["final"]);
  });

  it("skips heartbeat (`:`) and unknown event types", async () => {
    const mixed =
      ":\n" + // heartbeat
      "event: ping\n" + // bridge can advertise other event types
      'data: {"messageId":"keep","chatId":"x","senderId":"x"}\n\n';
    undiciMock.request.mockResolvedValueOnce(makeStreamResponse([mixed]));
    const client = new BridgeClient(config);
    const seen: string[] = [];
    for await (const evt of client.openMessageStream({ since: 0 })) {
      seen.push(String(evt.messageId ?? ""));
    }
    expect(seen).toEqual(["keep"]);
  });
});

describe("BridgeClient.send — retry on 503", () => {
  it("retries up to 3 times on 503 then succeeds", async () => {
    // Avoid eating ~3s of real backoff per attempt while still proving
    // the retry path. setTimeout via fake timers; we only need to
    // verify the call count and final result.
    vi.useFakeTimers();
    try {
      undiciMock.request
        .mockResolvedValueOnce(makeJsonResponse(503, { error: "transient" }))
        .mockResolvedValueOnce(makeJsonResponse(503, { error: "still transient" }))
        .mockResolvedValueOnce(makeJsonResponse(200, { success: true, messageId: "abc" }));
      const client = new BridgeClient(config);
      const sendPromise = client.send({ wxid: "filehelper", text: "hi" });
      // run pending timers (the linear backoff between retries)
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await sendPromise;
      expect(result.status).toBe(200);
      expect(result.data?.success).toBe(true);
      expect(undiciMock.request).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT retry 401 (auth-fatal — returned immediately)", async () => {
    undiciMock.request.mockResolvedValueOnce(
      makeJsonResponse(401, { error: "auth_expired" }),
    );
    const client = new BridgeClient(config);
    const result = await client.send({ wxid: "filehelper", text: "hi" });
    expect(result.status).toBe(401);
    expect(undiciMock.request).toHaveBeenCalledTimes(1);
  });
});

describe("BridgeClient.checkHealth — status mapping", () => {
  it("maps 200 + status:connected → healthy", async () => {
    undiciMock.request.mockResolvedValueOnce(
      makeJsonResponse(200, { status: "connected", hijackArmed: true }),
    );
    const client = new BridgeClient(config);
    const outcome = await client.checkHealth();
    expect(outcome.kind).toBe("healthy");
  });

  it("maps 401 → auth-fatal (no retry)", async () => {
    undiciMock.request.mockResolvedValueOnce(makeJsonResponse(401, { error: "expired" }));
    const client = new BridgeClient(config);
    const outcome = await client.checkHealth();
    expect(outcome.kind).toBe("auth-fatal");
  });

  it("maps 503 → degraded with retryable reason", async () => {
    undiciMock.request.mockResolvedValueOnce(makeJsonResponse(503, { error: "busy" }));
    const client = new BridgeClient(config);
    const outcome = await client.checkHealth();
    expect(outcome.kind).toBe("degraded");
    if (outcome.kind === "degraded") {
      expect(outcome.reason).toMatch(/temporarily unavailable/);
    }
  });

  it("maps 200 + status:disconnected → degraded", async () => {
    undiciMock.request.mockResolvedValueOnce(
      makeJsonResponse(200, { status: "disconnected" }),
    );
    const client = new BridgeClient(config);
    const outcome = await client.checkHealth();
    expect(outcome.kind).toBe("degraded");
  });
});
