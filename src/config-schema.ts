// Runtime config for the WeChat bridge plugin. Mirrors the Python
// adapter's environment surface so both implementations can be deployed
// with the same `WECHAT_BRIDGE_*` env vars without extra translation.

import { z } from "zod";

export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 18400;
export const MAX_MESSAGE_LENGTH = 4096;

// Bridge HTTP/SSE timing constants. Match the Python adapter
// (gateway/platforms/wechat.py:24-30) so behavior is the same in
// production whether the operator runs hermes-agent or openclaw.
export const SSE_RETRY_DELAY_INITIAL_MS = 2_000;
export const SSE_RETRY_DELAY_MAX_MS = 30_000;
export const HEALTH_CHECK_INTERVAL_MS = 20_000;
export const HTTP_CONNECT_TIMEOUT_MS = 10_000;
export const HTTP_READ_TIMEOUT_MS = 30_000;
// SSE has its own timeout: the bridge sends a `:` heartbeat comment on
// idle, so we can wait longer than a unary request.
export const SSE_READ_TIMEOUT_MS = 75_000;
export const SEND_RETRYABLE_STATUSES = new Set<number>([503]);

const envFlag = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "no") return false;
  if (v === "1" || v === "true" || v === "yes") return true;
  return undefined;
};

/**
 * Resolved configuration for a single WeChat bridge connection. Built by
 * `loadConfig({extra, env})` so plugin-level extras (per-account YAML)
 * win over global env vars; both fall back to documented defaults.
 */
export type WeChatBridgeConfig = {
  bridgeHost: string;
  bridgePort: number;
  bridgeBearer: string | null;
  selfWxid: string | null;
  requireMentionInGroups: boolean;
  baseUrl: string;
};

const ConfigSchema = z
  .object({
    bridge_host: z.string().trim().min(1).optional(),
    bridge_port: z.coerce.number().int().min(1).max(65_535).optional(),
    bridge_bearer: z.string().trim().min(1).optional(),
    self_wxid: z.string().trim().min(1).optional(),
    require_mention_in_groups: z.boolean().optional(),
  })
  .partial();

export type WeChatBridgeRawConfig = z.infer<typeof ConfigSchema>;

export type LoadConfigInput = {
  extra?: Record<string, unknown>;
  env?: Partial<NodeJS.ProcessEnv>;
};

export function loadConfig({ extra = {}, env = process.env }: LoadConfigInput = {}): WeChatBridgeConfig {
  // Plugin extras (e.g. account YAML config) override env. Without this
  // ordering an operator who sets WECHAT_BRIDGE_PORT globally couldn't
  // override it for a single account, which Hermes-side users depend on.
  const parsed = ConfigSchema.parse(extra);

  const host =
    parsed.bridge_host ??
    env.WECHAT_BRIDGE_HOST?.trim() ??
    DEFAULT_BRIDGE_HOST;

  const portFromEnv = env.WECHAT_BRIDGE_PORT
    ? Number.parseInt(env.WECHAT_BRIDGE_PORT, 10)
    : undefined;
  const port =
    parsed.bridge_port ??
    (Number.isFinite(portFromEnv) ? (portFromEnv as number) : DEFAULT_BRIDGE_PORT);

  const bearer = parsed.bridge_bearer ?? env.WECHAT_BRIDGE_BEARER?.trim() ?? "";

  const selfWxid = parsed.self_wxid ?? env.WECHAT_SELF_WXID?.trim() ?? "";

  // Group gating defaults to ON. Operators with selfWxid unset would
  // otherwise pass every group message into the agent loop on every
  // line — see hermes-agent commit 878dc9ae for the customer report.
  const requireMention =
    parsed.require_mention_in_groups ??
    envFlag(env.WECHAT_REQUIRE_GROUP_MENTION) ??
    true;

  return {
    bridgeHost: host || DEFAULT_BRIDGE_HOST,
    bridgePort: port,
    bridgeBearer: bearer || null,
    selfWxid: selfWxid || null,
    requireMentionInGroups: requireMention,
    baseUrl: `http://${host || DEFAULT_BRIDGE_HOST}:${port}`,
  };
}
