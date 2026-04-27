// Translate a bridge SSE payload into a normalized inbound event for
// the openclaw runtime. Behavior mirrors hermes-agent's
// `_build_message_event` (gateway/platforms/wechat.py:463-505) so
// switching from hermes to openclaw doesn't change which messages
// reach the agent.
//
// All gating policy lives here, in priority order:
//   1. Drop malformed payloads (no chatId or senderId).
//   2. Drop bridge-marked self-sends (fromSelf=true). Required to
//      break the DM echo loop where the bot's reply comes back through
//      SSE and gets re-processed as new inbound. See hermes-agent
//      commit 6486889a for the live customer report.
//   3. Drop messages from operator's own bot identities (botIds list).
//   4. Drop group messages where operator isn't @-tagged, when
//      `requireMentionInGroups` is on AND `selfWxid` is configured.
//      DMs always bypass. See hermes-agent commit 878dc9ae.
//   5. Otherwise pass through with `kind` derived from the bridge's
//      hasMedia/mediaType signals.

import type { BridgeMessage } from "./daemon.js";

/**
 * Inbound event normalized from a bridge SSE payload. Field shape stays
 * close to BridgeMessage so the runtime can decide which fields it
 * actually exposes to openclaw's ChannelEvent without re-translating.
 */
export type WeChatInboundEvent = {
  kind: "text" | "photo" | "video" | "voice" | "document";
  chatType: "dm" | "group";
  chatId: string;
  senderId: string;
  senderName: string;
  chatName: string;
  body: string;
  mentionedIds: readonly string[];
  isMentioned: boolean;
  mediaUrls: readonly string[];
  mediaType: string;
  messageId: string | null;
  timestamp: number | null;
  raw: BridgeMessage;
};

/** Static config consulted on every inbound. Stays read-only. */
export type InboundContextOptions = {
  selfWxid: string | null;
  requireMentionInGroups: boolean;
  /** Wxids the operator considers "us"; messages from these senders
   *  are dropped even when fromSelf is missing. */
  botIds?: readonly string[];
};

const cleanString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const cleanList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const cleaned = cleanString(entry);
    if (cleaned) out.push(cleaned);
  }
  return out;
};

const inferKind = (msg: BridgeMessage): WeChatInboundEvent["kind"] => {
  if (!msg.hasMedia) return "text";
  const mediaType = (msg.mediaType ?? "").toLowerCase();
  if (mediaType.includes("image")) return "photo";
  if (mediaType.includes("video")) return "video";
  if (mediaType.includes("audio") || mediaType.includes("voice") || mediaType.includes("ptt")) {
    return "voice";
  }
  return "document";
};

/**
 * Build a normalized inbound event from a bridge SSE payload, or
 * return `null` if the payload should be dropped.
 *
 * Returning `null` means "do not propagate to the agent" and is used
 * for malformed payloads, self-echo, bot-identity messages, and
 * group messages that don't @-tag the operator. Logging is intentionally
 * the caller's job — this function stays pure so it can be unit-tested
 * without a logger fixture.
 */
export function buildInboundEvent(
  msg: BridgeMessage | null | undefined,
  options: InboundContextOptions,
): WeChatInboundEvent | null {
  if (!msg || typeof msg !== "object") return null;

  const chatId = cleanString(msg.chatId);
  const senderId = cleanString(msg.senderId);
  if (!chatId || !senderId) return null;

  // Self-echo guard. Highest priority because it's the only thing
  // standing between us and an infinite DM reply loop.
  if (msg.fromSelf === true) return null;

  // Operator-configured bot identities. The bridge always sets
  // botIds=[] today, but operators may inject their own list via
  // adapter config; respect both sources.
  const payloadBotIds = new Set(cleanList(msg.botIds));
  if (options.botIds) {
    for (const id of options.botIds) {
      const cleaned = cleanString(id);
      if (cleaned) payloadBotIds.add(cleaned);
    }
  }
  if (payloadBotIds.has(senderId)) return null;

  const isGroup = Boolean(msg.isGroup);
  const mentionedIds = cleanList(msg.mentionedIds);
  const isMentionedFlag = msg.isMentioned === true || (
    options.selfWxid !== null && mentionedIds.includes(options.selfWxid)
  );

  // Group gating. Bypassed for DMs and when selfWxid is unset
  // (operator hasn't told us who "we" are; degrade to allow-through
  // rather than silently swallowing every group message).
  if (isGroup && options.requireMentionInGroups && options.selfWxid !== null) {
    if (!mentionedIds.includes(options.selfWxid)) {
      return null;
    }
  }

  const kind = inferKind(msg);
  const mediaUrls = cleanList(msg.mediaUrls);

  return {
    kind,
    chatType: isGroup ? "group" : "dm",
    chatId,
    senderId,
    senderName: cleanString(msg.senderName),
    chatName: cleanString(msg.chatName),
    body: typeof msg.body === "string" ? msg.body : "",
    mentionedIds,
    isMentioned: isMentionedFlag,
    mediaUrls,
    mediaType: cleanString(msg.mediaType).toLowerCase(),
    messageId: cleanString(msg.messageId) || null,
    timestamp: typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)
      ? msg.timestamp
      : null,
    raw: msg,
  };
}

/**
 * Bounded LRU set used by the SSE consumer to dedupe payloads that
 * carry an explicit `messageId`. The bridge can replay events on
 * reconnect (cursor-based stream) and we don't want the agent to wake
 * twice for the same message.
 *
 * Using two structures (deque + Set) keeps O(1) "have I seen this?"
 * lookups while bounding memory; same data structure as the Python
 * adapter at wechat.py:79-80.
 */
export class RecentMessageIds {
  private readonly capacity: number;
  private readonly order: string[] = [];
  private readonly seen = new Set<string>();

  constructor(capacity = 256) {
    this.capacity = capacity;
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  /** Returns true iff the id was new (and was therefore added). */
  add(id: string): boolean {
    if (this.seen.has(id)) return false;
    if (this.order.length === this.capacity) {
      const expired = this.order.shift();
      if (expired !== undefined) this.seen.delete(expired);
    }
    this.order.push(id);
    this.seen.add(id);
    return true;
  }
}
