# @leeguoo/openclaw-wechat-bridge

OpenClaw channel plugin that connects your agent to **macOS WeChat** through
[`wechat-bridge`](https://github.com/leeguooooo/wechat-skill) — the LLDB-based
local daemon from `wechat-skill`.

> **Status: v0.0.1 — outbound-only.** Lifecycle, target parsing, and
> outbound `/send` are end-to-end verified against `openclaw-cli`.
> **Inbound dispatch (agent reply on incoming WeChat messages) is
> coming in v0.1** — the SSE pipeline + gating already runs, but the
> wire-up to openclaw's reply engine is pending. Use this build today
> if you want openclaw to *send* WeChat messages on your behalf; wait
> for v0.1 if you need the agent to *answer* incoming messages.

## How this differs from `@tencent-weixin/openclaw-weixin`

| | `@tencent-weixin/openclaw-weixin` | `@leeguoo/openclaw-wechat-bridge` |
|---|---|---|
| Login | Tencent QR (separate session) | Reuse already-logged-in macOS WeChat client |
| Platform | Cross-platform (Tencent's runtime) | macOS only (Apple Silicon, WeChat 4.1.8) |
| Backend | Tencent's official Weixin SDK | Local LLDB hijack into WeChat.app |
| Maintainer | Tencent | Community (this repo) |
| Group support | Not advertised in plugin metadata | DM + group, gated on `mentionedIds` |

The two plugins **complement** each other; install whichever fits your
deployment. Channel ids are distinct (`openclaw-weixin` vs `wechat-bridge`)
so they can coexist.

## Prerequisites

1. **macOS WeChat 4.1.8** running on Apple Silicon, with logged-in account
2. **`wechat-skill`** installed and `wechat-bridge` reachable on
   `127.0.0.1:18400` — see
   <https://github.com/leeguooooo/wechat-skill> for setup
3. Accessibility (TCC) granted to `wechat-bridge` —
   the wechat-skill installer's modal dialog drives this in 30s

## Channel id

`wechat-bridge`

## Config schema

| key | env | default | notes |
|---|---|---|---|
| `bridge_host` | `WECHAT_BRIDGE_HOST` | `127.0.0.1` | |
| `bridge_port` | `WECHAT_BRIDGE_PORT` | `18400` | |
| `bridge_bearer` | `WECHAT_BRIDGE_BEARER` | _(unset)_ | required iff bridge was started with bearer enabled |
| `self_wxid` | `WECHAT_SELF_WXID` | _(unset)_ | operator's wxid; required for group `@`-mention gating |
| `require_mention_in_groups` | `WECHAT_REQUIRE_GROUP_MENTION` | `true` | drop group inbound when `self_wxid` is not in `mentionedIds` |

## Roadmap

Shipped in v0.0.1:

- [x] **M1** Repo bootstrap — package.json, manifest, tsconfig
- [x] **M2** Bridge HTTP/SSE client (daemon.ts, config-schema)
- [x] **M3** Inbound — SSE → normalized event with `fromSelf` drop +
      `mentionedIds` group gate (event flow into openclaw is
      stubbed pending M5b dispatch glue)
- [x] **M4** Outbound — `/send` with `{chatId, message, mentions?}` + chunking
- [x] **M5a** Lifecycle — connect/disconnect, single-consumer lock,
      health monitor, status state machine
- [x] **M5b/partial** — config adapter, `gateway.startAccount`,
      `messaging` target parser, `outbound.sendText` end-to-end
      verified against openclaw-cli 2026.4.24

Pending v0.1:

- [ ] **M5b inbound dispatch** — hook our SSE → openclaw reply pipeline
      via `dispatchInboundMessageWithDispatcher`. Today, inbound events
      flow into a no-op debug log; agents won't answer incoming WeChat
      messages until this lands.
- [ ] **M5b sendMedia** — image/video/voice/document outbound
- [ ] **M5b setupWizard** — first-run TCC + bridge-reachability walkthrough
- [ ] **M6 lifecycle integration tests** — additional vitest cases for
      gateway.startAccount + outbound.sendText error paths
- [ ] **M7 catalog PR** — add to openclaw's
      `scripts/lib/official-external-channel-catalog.json` upstream

## License

MIT — see [LICENSE](./LICENSE)
