// Plugin runtime store. Top-level helper consumed by `index.ts` and
// `setup-entry.ts` so openclaw's gateway can hand a `PluginRuntime` to
// our channel adapter at registration time.
//
// Mirrors the signal pattern at openclaw/extensions/signal/src/runtime.ts:1-12
// — same shape, distinct pluginId so the global slot doesn't collide.

import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const {
  setRuntime: setWechatBridgeRuntime,
  clearRuntime: clearWechatBridgeRuntime,
  getRuntime: getWechatBridgeRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "wechat-bridge",
  errorMessage: "WeChat bridge runtime not initialized",
});

export { clearWechatBridgeRuntime, getWechatBridgeRuntime, setWechatBridgeRuntime };
