// Bundled channel entry. Mirrors the shape used by openclaw's
// first-party `extensions/signal/index.ts`. The `defineBundledChannelEntry`
// helper from the openclaw plugin SDK wires our plugin module + runtime
// module into openclaw's channel registry at gateway startup.
//
// Once openclaw discovers this entry (via the `openclaw.extensions` field
// in package.json), it imports `channel-plugin-api.ts` for the inbound /
// outbound contract and `runtime-api.ts` for the gateway-side runtime hook.

import {
  defineBundledChannelEntry,
  type BundledChannelEntryContract,
} from "openclaw/plugin-sdk/channel-entry-contract";

const entry: BundledChannelEntryContract = defineBundledChannelEntry({
  id: "wechat-bridge",
  name: "WeChat (Bridge)",
  description: "WeChat channel via local wechat-bridge daemon (macOS, wechat-skill)",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "wechatBridgePlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setWechatBridgeRuntime",
  },
});

export default entry;
