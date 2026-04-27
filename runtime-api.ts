// Public runtime entry. openclaw's bundled-channel-entry contract
// expects an exported `setWechatBridgeRuntime` function so the gateway
// can hand the channel adapter a `PluginRuntime` at registration time.
//
// Re-exports the store helpers from `./runtime` (the 12-line store
// scaffold) so consumers can import the function directly. Mirrors
// signal's public runtime-api.ts at extensions/signal/runtime-api.ts.

export {
  clearWechatBridgeRuntime,
  getWechatBridgeRuntime,
  setWechatBridgeRuntime,
} from "./runtime.js";
