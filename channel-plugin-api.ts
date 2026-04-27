// Public plugin API surface. Real implementation lands in milestones 2-5.
// For now exports stub objects so openclaw's loader can resolve the
// specifiers from index.ts / setup-entry.ts without crashing.

export const wechatBridgePlugin = {
  // milestone 2 (daemon HTTP/SSE client) and milestone 3 (inbound) will
  // populate this with the channel runtime contract from
  // `openclaw/plugin-sdk/channel-plugin-contract`.
  __status: "scaffold",
};

export const wechatBridgeSetupPlugin = {
  // milestone 5: walk user through bridge reachability + TCC verification.
  __status: "scaffold",
};
