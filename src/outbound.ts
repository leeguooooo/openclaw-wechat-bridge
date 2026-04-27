// Outbound send pipeline. Mirrors hermes-agent's WeChatAdapter.send
// (gateway/platforms/wechat.py:189-241) so behavior on the wire is the
// same regardless of which adapter the operator is running.
//
// Stays a pure function over a BridgeClient: no global state, no
// gateway hooks, no logging. M5's ChannelPlugin wiring will translate
// the SendOutcome here into openclaw's SendResult shape.

import type { BridgeClient, SendBody, SendResponse } from "./daemon.js";
import type { RequestJsonResult } from "./daemon.js";
import { MAX_MESSAGE_LENGTH } from "./config-schema.js";

/**
 * Result returned by `sendMessage`. Tagged so callers can fan out
 * each terminal state into the right openclaw runtime signal:
 *   - "ok": message landed; messageId is the LAST chunk's id (Python parity)
 *   - "auth-fatal": 401/402 — operator's subscription expired; do NOT retry
 *   - "unsupported": 501 — bridge doesn't accept this send shape
 *   - "reply-degraded": 400 with `error: reply_not_supported` — bridge
 *     doesn't accept replyTo yet; we sent the plain text successfully
 *   - "error": any other failure (4xx, 5xx after retries, transport)
 */
export type SendOutcome =
  | { kind: "ok"; messageId: string | null }
  | { kind: "auth-fatal"; status: 401 | 402; reason: string }
  | { kind: "unsupported"; status: 501; reason: string }
  | { kind: "reply-degraded"; messageId: string | null }
  | { kind: "error"; status: number; reason: string };

export type SendInput = {
  chatId: string;
  content: string;
  /** Wxids to @-mention. The bridge translates these into atuserlist
   *  on the WeChat side. Forwarded only on the FIRST chunk to match
   *  the Python adapter's behavior — repeating mentions on every chunk
   *  would notify the recipient N times for one logical message. */
  mentions?: readonly string[];
  /** Optional reply target. Currently degraded silently — the bridge
   *  doesn't accept replyTo yet, so we send plain text. */
  replyTo?: string;
};

const AUTH_FATAL_REASON = "auth/subscription expired — operator must re-activate";

const cleanString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const cleanMentions = (input: SendInput["mentions"]): string[] => {
  if (!input) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    const cleaned = cleanString(entry);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
};

/**
 * Split text into chunks of at most `maxLen` chars. Splits on a
 * trailing newline if one falls in the last quarter of the chunk
 * (preserves paragraph structure); otherwise hard-cuts. Empty input
 * yields one empty chunk so the caller can detect "nothing to send"
 * upstream — but `sendMessage` short-circuits before this is hit.
 */
export function chunkContent(content: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (content.length <= maxLen) return [content];
  const out: string[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const end = Math.min(cursor + maxLen, content.length);
    let cut = end;
    if (end < content.length) {
      // Prefer breaking on a newline within the last quarter of the
      // window so paragraph boundaries survive the split.
      const minBreak = cursor + Math.floor(maxLen * 0.75);
      const lastNl = content.lastIndexOf("\n", end - 1);
      if (lastNl >= minBreak) cut = lastNl + 1;
    }
    out.push(content.slice(cursor, cut));
    cursor = cut;
  }
  return out;
}

const responseError = (
  data: SendResponse | null | undefined,
  fallback: string,
): string => {
  if (!data) return fallback;
  return cleanString(data.message ?? data.error ?? fallback) || fallback;
};

/**
 * Send `content` to `chatId`, splitting into chunks that fit the
 * bridge's MAX_MESSAGE_LENGTH. Returns the last chunk's outcome —
 * Python adapter does the same thing (only the final chunk's
 * messageId / error survives), so an operator switching adapters sees
 * the same return shape.
 */
export async function sendMessage(
  client: BridgeClient,
  input: SendInput,
): Promise<SendOutcome> {
  // Empty body short-circuits — Python returns success(message_id=None);
  // we return the same so callers can fan-out without tripping a
  // misleading retry path.
  if (!input.content || !input.content.trim()) {
    return { kind: "ok", messageId: null };
  }

  const mentions = cleanMentions(input.mentions);
  const chunks = chunkContent(input.content, MAX_MESSAGE_LENGTH);
  let lastMessageId: string | null = null;

  for (let i = 0; i < chunks.length; i += 1) {
    const body: SendBody = {
      chatId: input.chatId,
      message: chunks[i] ?? "",
    };
    if (mentions.length > 0 && i === 0) {
      body.mentions = [...mentions];
    }

    const result: RequestJsonResult<SendResponse> = await client.send(body);
    const { status, data } = result;

    if (status === 401 || status === 402) {
      return { kind: "auth-fatal", status, reason: AUTH_FATAL_REASON };
    }
    if (status === 400 && data?.error === "reply_not_supported") {
      // Bridge doesn't accept replyTo yet. Python falls back to the
      // last successful chunk's id; we do the same.
      return { kind: "reply-degraded", messageId: lastMessageId };
    }
    if (status === 501) {
      return {
        kind: "unsupported",
        status: 501,
        reason: "WeChat bridge does not support this send operation (501)",
      };
    }
    if (status !== 200) {
      return {
        kind: "error",
        status,
        reason: responseError(data, `WeChat bridge error (${status})`),
      };
    }
    if (data && data.success === false) {
      return {
        kind: "error",
        status: 200,
        reason: responseError(data, "WeChat bridge send failed"),
      };
    }
    lastMessageId = cleanString(data?.messageId) || lastMessageId;
  }

  return { kind: "ok", messageId: lastMessageId };
}
