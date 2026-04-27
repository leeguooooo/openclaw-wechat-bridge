// Minimal-but-valid ChannelPlugin scaffolds. Without `id` + `meta` + a
// `chatTypes` capability the loader's
// `normalizeRegisteredChannelPlugin` (channel-validation.ts) rejects the
// registration outright. M2-M5 will fill in adapters, allowlists,
// runtime, and setup wizard.
//
// Typed loosely on purpose: the openclaw typings ride in via the host
// package (peerDependency), and we don't want this scaffold to fail
// `tsc` before the consumer has run `npm install openclaw`.

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
};

// Setup plugin uses the same identity in M1; M5 will give it a real
// setup wizard that walks the user through bridge reachability + TCC.
export const wechatBridgeSetupPlugin: ChannelPluginShape = wechatBridgePlugin;
