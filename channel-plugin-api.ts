// Minimal-but-valid ChannelPlugin scaffolds. Without `id` + `meta` + a
// `chatTypes` capability the loader's
// `normalizeRegisteredChannelPlugin` (channel-validation.ts) rejects the
// registration outright. M2-M5 will fill in adapters, allowlists,
// runtime, and setup wizard.
//
// Typed loosely on purpose: the openclaw typings ride in via the host
// package (peerDependency), and we don't want this scaffold to fail
// `tsc` before the consumer has run `npm install openclaw`.

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
     * Materialize a ResolvedWechatAccount by merging top-level
     * `channels.wechat-bridge` settings with `accounts[accountId]`
     * overrides. Without this, openclaw's health monitor crashes on
     * startup with "Cannot read properties of undefined (reading
     * 'listAccountIds')".
     */
    resolveAccount: (params: {
      cfg: unknown;
      accountId?: string | null;
    }) => ResolvedWechatAccount;
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
  if (accounts && typeof accounts === "object") {
    const keys = Object.keys(accounts);
    if (keys.length > 0) return keys;
  }
  return [DEFAULT_ACCOUNT_ID];
};

const resolveAccount = (params: {
  cfg: unknown;
  accountId?: string | null;
}): ResolvedWechatAccount => {
  const section = readChannelSection(params.cfg) ?? {};
  const accountId = (params.accountId && params.accountId.trim()) || DEFAULT_ACCOUNT_ID;
  const accounts =
    section.accounts && typeof section.accounts === "object"
      ? (section.accounts as Record<string, Partial<ResolvedWechatAccount["config"]>>)
      : {};
  const accountOverrides = accounts[accountId] ?? {};

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
    accountId,
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

export const wechatBridgePlugin: ChannelPluginShape = {
  id: "wechat-bridge",
  meta: wechatBridgeMeta,
  capabilities: {
    chatTypes: ["dm", "group"],
    media: false,
    reply: false,
    reactions: false,
  },
  config: {
    listAccountIds,
    resolveAccount,
  },
};

// Setup plugin uses the same identity in M1; M5 will give it a real
// setup wizard that walks the user through bridge reachability + TCC.
export const wechatBridgeSetupPlugin: ChannelPluginShape = wechatBridgePlugin;
