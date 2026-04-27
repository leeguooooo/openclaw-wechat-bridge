// Regression tests for inbound gating. The five `test_build_event_*`
// cases come straight from hermes-agent/tests/gateway/platforms/test_wechat.py
// (post-fix state) so a behavior delta between the two adapters surfaces
// here before it reaches users. Three additional cases cover the M3
// review fixes (empty-string selfWxid, RecentMessageIds capacity guard,
// LRU eviction).

import { describe, expect, it } from "vitest";

import { buildInboundEvent, RecentMessageIds } from "../src/inbound-context";
import type { BridgeMessage } from "../src/daemon";

const baseInbound = (overrides: Partial<BridgeMessage> = {}): BridgeMessage => ({
  messageId: "mid-1",
  chatId: "10086@chatroom",
  senderId: "wxid_user1",
  senderName: "Alice",
  chatName: "design",
  isGroup: true,
  body: "hi",
  hasMedia: false,
  mediaType: "",
  mediaUrls: [],
  mentionedIds: [],
  quotedParticipant: "",
  botIds: [],
  fromSelf: false,
  isMentioned: false,
  timestamp: 1713859200,
  ...overrides,
});

describe("buildInboundEvent — gating parity with hermes-agent", () => {
  it("drops self-sent DM to break echo loop", () => {
    // Mirrors test_build_event_drops_self_sent_dm_to_break_echo_loop
    // in hermes-agent. fromSelf=true is the bridge-authoritative signal
    // that this row is the bot's own outbound; without dropping it the
    // adapter would re-process the bot's reply as new inbound.
    const event = buildInboundEvent(
      baseInbound({
        chatId: "wxid_user1",
        senderId: "wxid_bot",
        isGroup: false,
        fromSelf: true,
        body: "bot's own reply",
      }),
      { selfWxid: "wxid_bot", requireMentionInGroups: true },
    );
    expect(event).toBeNull();
  });

  it("drops group message when bot is not mentioned", () => {
    // test_build_event_drops_group_message_when_bot_not_mentioned
    const event = buildInboundEvent(
      baseInbound({
        senderId: "wxid_user1",
        isGroup: true,
        mentionedIds: ["wxid_user2"], // someone else, not the bot
        body: "hello team",
      }),
      { selfWxid: "wxid_bot", requireMentionInGroups: true },
    );
    expect(event).toBeNull();
  });

  it("keeps group message when bot is mentioned", () => {
    // test_build_event_keeps_group_message_when_bot_is_mentioned
    const event = buildInboundEvent(
      baseInbound({
        senderId: "wxid_user1",
        isGroup: true,
        mentionedIds: ["wxid_bot"],
        body: "@bot help",
      }),
      { selfWxid: "wxid_bot", requireMentionInGroups: true },
    );
    expect(event).not.toBeNull();
    expect(event?.chatType).toBe("group");
    expect(event?.body).toBe("@bot help");
    expect(event?.isMentioned).toBe(true);
  });

  it("keeps DM unconditionally — gating must not affect private chats", () => {
    // test_build_event_keeps_dm_unconditionally
    const event = buildInboundEvent(
      baseInbound({
        chatId: "wxid_user1",
        senderId: "wxid_user1",
        isGroup: false,
        mentionedIds: [],
        body: "private question",
      }),
      { selfWxid: "wxid_bot", requireMentionInGroups: true },
    );
    expect(event).not.toBeNull();
    expect(event?.chatType).toBe("dm");
  });

  it("skips gating when self_wxid is unset (fail-open by design)", () => {
    // test_build_event_skips_gating_when_self_wxid_unset
    // Operator hasn't told us which wxid is "us"; failing closed would
    // silently swallow every group message during first-time setup.
    const event = buildInboundEvent(
      baseInbound({
        senderId: "wxid_user1",
        isGroup: true,
        mentionedIds: [],
        body: "no self_wxid set",
      }),
      { selfWxid: null, requireMentionInGroups: true },
    );
    expect(event).not.toBeNull();
  });
});

describe("buildInboundEvent — M3 review fixes", () => {
  it("treats empty-string selfWxid as unset", () => {
    // The TS-strict `!== null` check would let "" through as a
    // configured value, but the bridge would never emit "" in
    // mentionedIds — so the gate would be perma-active for an empty
    // operator id. Fix: collapse empty/whitespace to null up-front.
    const event = buildInboundEvent(
      baseInbound({
        senderId: "wxid_user1",
        isGroup: true,
        mentionedIds: ["wxid_user2"],
      }),
      { selfWxid: "   ", requireMentionInGroups: true },
    );
    expect(event).not.toBeNull(); // gate disabled, message passes
  });

  it("drops malformed payloads (missing chatId)", () => {
    const event = buildInboundEvent(
      baseInbound({ chatId: "" }),
      { selfWxid: "wxid_bot", requireMentionInGroups: true },
    );
    expect(event).toBeNull();
  });

  it("drops malformed payloads (missing senderId)", () => {
    const event = buildInboundEvent(
      baseInbound({ senderId: "" }),
      { selfWxid: "wxid_bot", requireMentionInGroups: true },
    );
    expect(event).toBeNull();
  });

  it("drops sender on bridge-supplied botIds list", () => {
    const event = buildInboundEvent(
      baseInbound({ senderId: "wxid_bot", botIds: ["wxid_bot"], mentionedIds: ["wxid_bot"] }),
      { selfWxid: "wxid_bot", requireMentionInGroups: true },
    );
    expect(event).toBeNull();
  });

  it("infers media kind from mediaType (image / video / voice / document)", () => {
    const cases: Array<[string, string]> = [
      ["image/jpeg", "photo"],
      ["video/mp4", "video"],
      ["audio/mp3", "voice"],
      ["voice/ptt", "voice"],
      ["application/pdf", "document"],
    ];
    for (const [mediaType, expected] of cases) {
      const event = buildInboundEvent(
        baseInbound({
          senderId: "wxid_user1",
          isGroup: false,
          chatId: "wxid_user1",
          hasMedia: true,
          mediaType,
        }),
        { selfWxid: null, requireMentionInGroups: true },
      );
      expect(event?.kind).toBe(expected);
    }
  });
});

describe("RecentMessageIds — LRU dedupe", () => {
  it("returns true on first add, false on duplicate add", () => {
    const lru = new RecentMessageIds(4);
    expect(lru.add("a")).toBe(true);
    expect(lru.has("a")).toBe(true);
    expect(lru.add("a")).toBe(false);
  });

  it("evicts the oldest entry at capacity", () => {
    const lru = new RecentMessageIds(2);
    lru.add("a");
    lru.add("b");
    lru.add("c"); // forces eviction of "a"
    expect(lru.has("a")).toBe(false);
    expect(lru.has("b")).toBe(true);
    expect(lru.has("c")).toBe(true);
  });

  it("clamps a non-positive capacity to 1 to prevent unbounded growth", () => {
    // Without the capacity guard a `new RecentMessageIds(0)` would
    // skip the eviction branch on every add and grow indefinitely.
    const lru = new RecentMessageIds(0);
    lru.add("a");
    lru.add("b");
    expect(lru.has("a")).toBe(false); // "a" was evicted by "b"
    expect(lru.has("b")).toBe(true);
  });
});
