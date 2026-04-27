// Channel plugin contract surface. Typed loosely so this module
// compiles without dragging in openclaw's full type graph at install
// time — openclaw's loader only checks the runtime shape via
// `normalizeRegisteredChannelPlugin`, not the static types.
//
// M5b in progress: `gateway.startAccount` instantiates a BridgeRuntime
// per account so openclaw can spin our runtime up at gateway startup.
// Outbound (`outbound`) and inbound dispatch glue still pending.

type ResolvedWechatAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name: string | undefined;
  baseUrl: string;
  config: {
    bridge_host?: string;
    bridge_port?: number;
    bridge_bearer?: string;
    self_wxid?: string;
    require_mention_in_groups?: boolean;
    enabled?: boolean;
    name?: string;
  };
};

type GatewayAccountContext = {
  account: ResolvedWechatAccount;
  cfg?: unknown;
  runtime?: unknown;
  abortSignal?: AbortSignal;
  setStatus?: (status: Record<string, unknown>) => void;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
    error?: (message: string) => void;
    debug?: (message: string) => void;
  };
};

type ChannelPluginShape = {
  id: string;
  meta: {
    id: string;
    label: string;
    selectionLabel: string;
    docsPath: string;
    blurb: string;
    detailLabel?: string;
    systemImage?: string;
    markdownCapable?: boolean;
  };
  capabilities: {
    chatTypes: Array<"dm" | "group" | "thread">;
    media?: boolean;
    reply?: boolean;
    reactions?: boolean;
  };
  gateway?: {
    /** Spawn a BridgeRuntime for the resolved account. openclaw calls
     *  this once per enabled account at gateway startup; teardown is
     *  signalled via ctx.abortSignal (openclaw drops the return
     *  value), so the function returns void. */
    startAccount: (ctx: GatewayAccountContext) => Promise<void>;
  };
  messaging?: {
    normalizeTarget: (raw: string) => string | null;
    parseExplicitTarget: (params: {
      raw: string;
    }) => { to: string; chatType: "dm" | "group" } | null;
    inferTargetChatType: (params: { to: string }) => "dm" | "group";
    targetResolver: {
      looksLikeId: (raw: string) => boolean;
      hint: string;
    };
  };
  outbound?: {
    deliveryMode: "direct" | "gateway" | "hybrid";
    chunker?: (text: string, limit: number) => string[];
    chunkerMode?: "text" | "markdown";
    textChunkLimit?: number;
    /**
     * REQUIRED — openclaw's deliver.ts:172 gates handler creation on
     * this field; absent or undefined and the gateway throws "Outbound
     * not configured for channel: wechat-bridge". Returns a single
     * OutboundDeliveryResult per call.
     *
     * Note: this is the FLAT ChannelOutboundAdapter shape from
     * src/channels/plugins/outbound.types.ts:75-160 — NOT the
     * `base:` wrapper that createChatChannelPlugin uses internally
     * before normalizing. Plugins that don't go through the chat
     * helper (us) must supply the flat adapter directly.
     */
    sendText: (ctx: {
      cfg: unknown;
      to: string;
      text: string;
      accountId?: string | null;
      deps?: { [channelId: string]: unknown };
      abortSignal?: AbortSignal;
    }) => Promise<{
      channel: string;
      messageId: string;
      chatId?: string;
      meta?: Record<string, unknown>;
    }>;
  };
  config: {
    /**
     * Enumerate account ids for this channel. We model the bridge as
     * a SINGLE account ("default") because there's exactly one
     * wechat-bridge daemon per host and one logged-in WeChat client
     * behind it. If an operator extends `channels.wechat-bridge.accounts`
     * in their config, expose those keys too.
     */
    listAccountIds: (cfg: unknown) => string[];
    /**
     * Materialize a ResolvedWechatAccount. openclaw's caller passes
     * `(cfg, accountId)` POSITIONAL — see openclaw/src/server-channels.ts
     * around the resolveAccount invocation. The function MUST accept
     * positional args, not a params object; otherwise multi-account
     * configs silently always resolve as "default" because the second
     * positional arg is dropped on the floor.
     */
    resolveAccount: (
      cfg: unknown,
      accountId?: string | null,
    ) => ResolvedWechatAccount;
  };
};

const DEFAULT_ACCOUNT_ID = "default";

const readChannelSection = (cfg: unknown): Record<string, unknown> | null => {
  if (!cfg || typeof cfg !== "object") return null;
  const channels = (cfg as { channels?: unknown }).channels;
  if (!channels || typeof channels !== "object") return null;
  const section = (channels as Record<string, unknown>)["wechat-bridge"];
  if (!section || typeof section !== "object") return null;
  return section as Record<string, unknown>;
};

const listAccountIds = (cfg: unknown): string[] => {
  const section = readChannelSection(cfg);
  const accounts = section?.accounts;
  // Reject array-shaped values: typeof [] === "object" passes the
  // narrowing but Object.keys yields stringified numeric indices,
  // which then silently fail to resolve real configs downstream.
  if (
    accounts &&
    typeof accounts === "object" &&
    !Array.isArray(accounts)
  ) {
    const keys = Object.keys(accounts);
    if (keys.length > 0) return keys;
  }
  return [DEFAULT_ACCOUNT_ID];
};

const resolveAccount = (
  cfg: unknown,
  accountId?: string | null,
): ResolvedWechatAccount => {
  const section = readChannelSection(cfg) ?? {};
  const resolvedId = (accountId && accountId.trim()) || DEFAULT_ACCOUNT_ID;
  const accounts =
    section.accounts &&
    typeof section.accounts === "object" &&
    !Array.isArray(section.accounts)
      ? (section.accounts as Record<string, Partial<ResolvedWechatAccount["config"]>>)
      : {};
  const accountOverrides = accounts[resolvedId] ?? {};

  const merged: ResolvedWechatAccount["config"] = {
    ...(section as ResolvedWechatAccount["config"]),
    ...accountOverrides,
  };

  const baseEnabled = (section.enabled as boolean | undefined) !== false;
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const host = typeof merged.bridge_host === "string" && merged.bridge_host.trim()
    ? merged.bridge_host.trim()
    : "127.0.0.1";
  const port =
    typeof merged.bridge_port === "number" && Number.isFinite(merged.bridge_port)
      ? merged.bridge_port
      : 18400;

  const configured = Boolean(
    typeof merged.bridge_host === "string"
      || typeof merged.bridge_port === "number"
      || typeof merged.bridge_bearer === "string"
      || typeof merged.self_wxid === "string",
  );

  return {
    accountId: resolvedId,
    enabled,
    configured,
    name: typeof merged.name === "string" ? merged.name : undefined,
    baseUrl: `http://${host}:${port}`,
    config: merged,
  };
};

const wechatBridgeMeta: ChannelPluginShape["meta"] = {
  id: "wechat-bridge",
  label: "WeChat (Bridge)",
  selectionLabel: "WeChat — local bridge (wechat-skill)",
  detailLabel: "WeChat Bridge",
  docsPath: "/channels/wechat-bridge",
  blurb:
    "Connects to a local wechat-bridge daemon (macOS, requires wechat-skill). Complements Tencent's @tencent-weixin/openclaw-weixin; this one runs against an already-logged-in macOS WeChat client.",
  systemImage: "bubble.left.and.bubble.right",
  markdownCapable: false,
};

// WeChat target shapes:
//   wxid_*    — DM (regular user account)
//   gh_*      — DM (official account / mp / 公众号)
//   wm_*      — DM (work account / 企业微信 stub)
//   wb_*      — DM (other internal types we've seen)
//   v1_*      — DM (synthetic / generated wxid)
//   *@chatroom — group
//   filehelper — DM (the system "文件传输助手" special chat)
//
// Same regex hermes-agent uses (tools/send_message_tool.py:23) so a
// target string that resolves on hermes also resolves here.
const WECHAT_TARGET_RE =
  /^\s*((?:wxid|gh|v\d+|wm|wb)_[A-Za-z0-9_-]+|[A-Za-z0-9._-]+@chatroom|filehelper)\s*$/;

const normalizeWechatTarget = (raw: string): string | null => {
  if (typeof raw !== "string") return null;
  const match = WECHAT_TARGET_RE.exec(raw);
  return match ? match[1]! : null;
};

const inferWechatChatType = ({ to }: { to: string }): "dm" | "group" =>
  to.endsWith("@chatroom") ? "group" : "dm";

const looksLikeWechatId = (raw: string): boolean =>
  WECHAT_TARGET_RE.test(raw);

/**
 * Map our internal RuntimeStatus tagged-union onto openclaw's
 * ChannelAccountSnapshot shape (src/channels/plugins/types.core.ts:188-253).
 * `kind` and our other field names are NOT recognized fields on
 * ChannelAccountSnapshot — openclaw spreads the patch via shallow merge
 * and silently drops unknowns, so previously our status updates flowed
 * to setStatus but never lit up the health UI.
 */
function snapshotPatchFromRuntimeStatus(
  status: { kind: string; reason?: string },
  baseUrl: string,
): Record<string, unknown> {
  const now = Date.now();
  switch (status.kind) {
    case "starting":
      return {
        baseUrl,
        statusState: "starting",
        running: true,
        connected: false,
        lastStartAt: now,
      };
    case "connected":
      return {
        baseUrl,
        statusState: "connected",
        healthState: "healthy",
        running: true,
        connected: true,
        lastError: null,
        lastConnectedAt: now,
      };
    case "degraded":
      return {
        baseUrl,
        statusState: "degraded",
        healthState: "degraded",
        running: true,
        connected: false,
        lastError: status.reason ?? "degraded",
      };
    case "auth-fatal":
      return {
        baseUrl,
        statusState: "auth-fatal",
        healthState: "auth-fatal",
        running: false,
        connected: false,
        lastError: status.reason ?? "auth/subscription expired",
      };
    case "stopped":
      return {
        baseUrl,
        statusState: "stopped",
        running: false,
        connected: false,
        lastStopAt: now,
      };
    default:
      return { baseUrl, statusState: status.kind };
  }
}

/**
 * Spawn a BridgeRuntime for the resolved account.
 *
 * openclaw's gateway invokes startAccount once per enabled account at
 * boot and tracks the returned promise's settle for surface-level
 * health. Shutdown is signalled via ctx.abortSignal — openclaw never
 * calls a returned `.dispose` (the return value is typed `unknown` and
 * discarded), so we mirror the abort into runtime.stop() and return
 * void.
 */
/**
 * Outbound text send — adapts our M4 sendMessage into openclaw's
 * `outbound.sendText` contract so a CLI / agent / tool-call
 * invocation flows through to wechat-bridge.
 *
 * The bridge's messageId is forwarded so openclaw can de-dupe / link
 * agent acknowledgments. M4's chunking already runs inside
 * sendMessage, so we feed `text` whole. openclaw's outer chunker
 * (`outbound.chunker`) is set to a no-op pass-through within the
 * 4096-char limit so its splitter doesn't redundantly fragment our
 * chunks before they reach our path.
 */
async function sendTextOutbound(params: {
  cfg: unknown;
  to: string;
  text: string;
  accountId?: string | null;
  abortSignal?: AbortSignal;
}): Promise<{
  channel: string;
  messageId: string;
  meta?: Record<string, unknown>;
}> {
  const [{ BridgeClient }, { loadConfig }, { sendMessage }] = await Promise.all([
    import("./src/daemon.js"),
    import("./src/config-schema.js"),
    import("./src/outbound.js"),
  ]);

  const account = resolveAccount(params.cfg, params.accountId ?? null);
  const runtimeConfig = loadConfig({
    extra: {
      bridge_host: account.config.bridge_host,
      bridge_port: account.config.bridge_port,
      bridge_bearer: account.config.bridge_bearer,
    },
  });
  const client = new BridgeClient(runtimeConfig);

  params.abortSignal?.throwIfAborted();
  const outcome = await sendMessage(client, {
    chatId: params.to,
    content: params.text,
  });

  if (outcome.kind === "ok") {
    return { channel: "wechat-bridge", messageId: outcome.messageId ?? "" };
  }
  if (outcome.kind === "auth-fatal") {
    throw new Error(`wechat-bridge auth-fatal (HTTP ${outcome.status}): ${outcome.reason}`);
  }
  if (outcome.kind === "unsupported") {
    throw new Error(outcome.reason);
  }
  if (outcome.kind === "reply-degraded") {
    return {
      channel: "wechat-bridge",
      messageId: outcome.messageId ?? "",
      meta: { degraded: "reply-not-supported" },
    };
  }
  throw new Error(`wechat-bridge send failed (HTTP ${outcome.status}): ${outcome.reason}`);
}

async function startAccount(ctx: GatewayAccountContext): Promise<void> {
  // Lazy-import the runtime so the channel-plugin-api module stays
  // dependency-free for openclaw's static manifest scan. The first
  // gateway.startAccount call is also the first time we need
  // undici/zod etc., so loading them here keeps cold-start cheap
  // for plugins that are installed but never started.
  const [{ BridgeRuntime }, { loadConfig }] = await Promise.all([
    import("./src/runtime.js"),
    import("./src/config-schema.js"),
  ]);

  const account = ctx.account;
  ctx.log?.info?.(
    `[wechat-bridge:${account.accountId}] starting BridgeRuntime against ${account.baseUrl}`,
  );

  // Eager status row so the health dashboard sees the account as
  // "starting" before runtime.start() resolves. Without this, the
  // account briefly shows in an unknown state until the first status
  // event fires from runtime.onStatusChange.
  ctx.setStatus?.({
    accountId: account.accountId,
    baseUrl: account.baseUrl,
    statusState: "starting",
    running: true,
    connected: false,
    lastStartAt: Date.now(),
  });

  const config = loadConfig({
    extra: {
      bridge_host: account.config.bridge_host,
      bridge_port: account.config.bridge_port,
      bridge_bearer: account.config.bridge_bearer,
      self_wxid: account.config.self_wxid,
      require_mention_in_groups: account.config.require_mention_in_groups,
    },
  });

  const runtime = new BridgeRuntime({
    config,
    // M5b TODO: wire dispatch into openclaw/plugin-sdk/reply-runtime
    // dispatchInboundMessage. For now the inbound events flow into
    // a no-op so we can prove the lifecycle / lock / health pipeline
    // works without dragging in the reply engine.
    dispatch: (event) => {
      ctx.log?.debug?.(
        `[wechat-bridge:${account.accountId}] inbound (M5b dispatch TODO) ` +
          `${event.chatType} chat=${event.chatId} body=${JSON.stringify(event.body).slice(0, 80)}`,
      );
    },
  });

  runtime.onStatusChange((status) => {
    const patch = snapshotPatchFromRuntimeStatus(status, account.baseUrl);
    ctx.setStatus?.({
      accountId: account.accountId,
      ...patch,
    });
  });

  // Honor the gateway's abort signal: when the gateway shuts down it
  // signals us, and we mirror that into runtime.stop() so the bridge
  // lock gets released promptly. openclaw creates a fresh
  // AbortController per startAccount call (server-channels.ts), so the
  // listener we register here can't leak across restarts.
  if (ctx.abortSignal?.aborted) {
    void runtime.stop();
  } else {
    ctx.abortSignal?.addEventListener(
      "abort",
      () => {
        void runtime.stop();
      },
      { once: true },
    );
  }

  await runtime.start();
}

export const wechatBridgePlugin: ChannelPluginShape = {
  id: "wechat-bridge",
  meta: wechatBridgeMeta,
  capabilities: {
    chatTypes: ["dm", "group"],
    media: false,
    reply: false,
    reactions: false,
  },
  gateway: {
    startAccount,
  },
  messaging: {
    normalizeTarget: normalizeWechatTarget,
    parseExplicitTarget: ({ raw }) => {
      const normalized = normalizeWechatTarget(raw);
      if (!normalized) return null;
      return { to: normalized, chatType: inferWechatChatType({ to: normalized }) };
    },
    inferTargetChatType: inferWechatChatType,
    targetResolver: {
      looksLikeId: looksLikeWechatId,
      hint: "<wxid_…|gh_…|name@chatroom|filehelper>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    // M4 sendMessage handles chunking internally; openclaw's outer
    // chunker just needs to be a no-op pass-through within our limit.
    chunker: (text: string, _limit: number) => (text ? [text] : []),
    chunkerMode: "text",
    textChunkLimit: 4096,
    sendText: sendTextOutbound,
  },
  config: {
    listAccountIds,
    resolveAccount,
  },
};

// Setup plugin uses the same identity in M1; M5 will give it a real
// setup wizard that walks the user through bridge reachability + TCC.
export const wechatBridgeSetupPlugin: ChannelPluginShape = wechatBridgePlugin;
