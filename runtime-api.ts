// Gateway-side runtime hook. The actual runtime (SSE consume loop, send
// outbound, lifecycle) is wired in milestones 3-5 via
// `setWechatBridgeRuntime`.

export function setWechatBridgeRuntime(): void {
  // milestone 5: register the channel runtime against openclaw's
  // gateway. For now, no-op so loader can resolve the export.
}
