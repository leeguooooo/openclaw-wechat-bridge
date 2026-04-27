// CLI setup entry — invoked when the user runs `openclaw channels add wechat-bridge`.
// The setup plugin will (in milestone 5) walk the user through verifying that
// wechat-bridge is reachable on the configured host:port and that
// AXIsProcessTrusted has been granted. For now the entry exists so openclaw's
// plugin loader can register the setup hook.

import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "wechatBridgeSetupPlugin",
  },
});
