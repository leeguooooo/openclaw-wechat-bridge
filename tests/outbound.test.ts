// M4 outbound tests. Mock BridgeClient.send to fully control return
// shapes per call. Five hermes parity cases:
//   - test_send_text_happy_path
//   - test_send_401_logs_clear_error_without_retry
//   - test_send_reply_to_degrades_silently_without_replyto
//   - test_send_includes_mention_targets_from_metadata
// plus M4-specific chunking and "mentions only on first chunk" coverage.

import { describe, expect, it, vi } from "vitest";

import { sendMessage, chunkContent } from "../src/outbound";
import { MAX_MESSAGE_LENGTH } from "../src/config-schema";
import type { BridgeClient, RequestJsonResult, SendResponse } from "../src/daemon";

type Stub = Pick<BridgeClient, "send">;

const stubClient = (
  responses: Array<RequestJsonResult<SendResponse>>,
): { client: Stub; sendMock: ReturnType<typeof vi.fn> } => {
  const sendMock = vi.fn();
  for (const r of responses) sendMock.mockResolvedValueOnce(r);
  return { client: { send: sendMock as unknown as BridgeClient["send"] }, sendMock };
};

describe("sendMessage — happy path + parity with hermes", () => {
  it("returns ok with messageId on a single 200 response", async () => {
    // test_send_text_happy_path
    const { client, sendMock } = stubClient([
      { status: 200, data: { success: true, messageId: "msg-1" } },
    ]);
    const result = await sendMessage(client as BridgeClient, {
      chatId: "wxid_123",
      content: "hello from openclaw",
    });
    expect(result).toEqual({ kind: "ok", messageId: "msg-1" });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const body = sendMock.mock.calls[0]?.[0];
    // Bridge v1.10.39 wire shape: {wxid, text}.
    expect(body).toEqual({ wxid: "wxid_123", text: "hello from openclaw" });
  });

  it("returns auth-fatal on 401 without continuing (parity test_send_401_*)", async () => {
    const { client, sendMock } = stubClient([
      { status: 401, data: { success: false, error: "auth_expired" } },
      // would never be consumed:
      { status: 200, data: { success: true, messageId: "should-not-fire" } },
    ]);
    const result = await sendMessage(client as BridgeClient, {
      chatId: "wxid_123",
      content: "x".repeat(MAX_MESSAGE_LENGTH * 2 + 1), // would be 3 chunks if it kept going
    });
    expect(result.kind).toBe("auth-fatal");
    if (result.kind === "auth-fatal") {
      expect(result.status).toBe(401);
    }
    expect(sendMock).toHaveBeenCalledTimes(1); // bailed before chunk 2
  });

  it("returns reply-degraded on 400 + reply_not_supported", async () => {
    // test_send_reply_to_degrades_silently_without_replyto
    const { client } = stubClient([
      {
        status: 400,
        data: { success: false, error: "reply_not_supported" },
      },
    ]);
    const result = await sendMessage(client as BridgeClient, {
      chatId: "wxid_123",
      content: "hi",
      replyTo: "msg-prev",
    });
    expect(result.kind).toBe("reply-degraded");
  });

  it("forwards mentions only on the FIRST chunk", async () => {
    // test_send_includes_mention_targets_from_metadata + chunking
    const { client, sendMock } = stubClient([
      { status: 200, data: { success: true, messageId: "msg-1" } },
      { status: 200, data: { success: true, messageId: "msg-2" } },
    ]);
    // 2 chunks: MAX + 100 chars total
    const content = "a".repeat(MAX_MESSAGE_LENGTH) + "b".repeat(100);
    const result = await sendMessage(client as BridgeClient, {
      chatId: "wxid_123",
      content,
      mentions: ["wxid_alice", "wxid_bob"],
    });
    expect(result).toEqual({ kind: "ok", messageId: "msg-2" });
    expect(sendMock).toHaveBeenCalledTimes(2);
    const first = sendMock.mock.calls[0]?.[0];
    const second = sendMock.mock.calls[1]?.[0];
    expect(first?.mentions).toEqual(["wxid_alice", "wxid_bob"]);
    expect(second?.mentions).toBeUndefined();
  });

  it("treats whitespace-only content as no-op success", async () => {
    const { client, sendMock } = stubClient([]);
    const result = await sendMessage(client as BridgeClient, {
      chatId: "wxid_123",
      content: "   \n\t  ",
    });
    expect(result).toEqual({ kind: "ok", messageId: null });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("dedupes and trims mention list before forwarding", async () => {
    const { client, sendMock } = stubClient([
      { status: 200, data: { success: true, messageId: "msg-1" } },
    ]);
    await sendMessage(client as BridgeClient, {
      chatId: "wxid_123",
      content: "hi",
      mentions: [" wxid_alice ", "wxid_alice", "  ", "wxid_bob"],
    });
    const body = sendMock.mock.calls[0]?.[0];
    expect(body?.mentions).toEqual(["wxid_alice", "wxid_bob"]);
  });

  it("surfaces unknown 5xx errors with the bridge's error message", async () => {
    const { client } = stubClient([
      { status: 500, data: { success: false, message: "internal" } },
    ]);
    const result = await sendMessage(client as BridgeClient, {
      chatId: "wxid_123",
      content: "hi",
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.status).toBe(500);
      expect(result.reason).toBe("internal");
    }
  });

  it("treats 200 + success:false as error (bridge logical failure)", async () => {
    const { client } = stubClient([
      { status: 200, data: { success: false, error: "delivery_verify_timeout" } },
    ]);
    const result = await sendMessage(client as BridgeClient, {
      chatId: "wxid_123",
      content: "hi",
    });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("delivery_verify_timeout");
    }
  });
});

describe("chunkContent", () => {
  it("returns a single chunk when content fits", () => {
    expect(chunkContent("hi", MAX_MESSAGE_LENGTH)).toEqual(["hi"]);
  });

  it("hard-cuts when no convenient newline boundary exists", () => {
    const content = "a".repeat(MAX_MESSAGE_LENGTH + 10);
    const chunks = chunkContent(content, MAX_MESSAGE_LENGTH);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.length).toBe(MAX_MESSAGE_LENGTH);
    expect(chunks[1]?.length).toBe(10);
  });

  it("prefers a newline boundary in the last quarter of the window", () => {
    // 4096-char window; place a newline at position 3500 (within last
    // quarter starts at 3072) so the splitter prefers it over the hard
    // cut at 4096.
    const head = "a".repeat(3500);
    const tail = "b".repeat(700); // 4200 total ≥ MAX, so two chunks
    const content = `${head}\n${tail}`;
    const chunks = chunkContent(content, MAX_MESSAGE_LENGTH);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.endsWith("\n")).toBe(true);
    expect(chunks[0]?.length).toBe(3501); // through the \n
    expect(chunks[1]).toBe(tail);
  });
});
