# @leeguoo/openclaw-wechat-bridge

OpenClaw channel plugin that connects your agent to **macOS WeChat** through
[`wechat-bridge`](https://github.com/leeguooooo/wechat-skill) — the LLDB-based
local daemon from `wechat-skill`.

> **Status: v0.0.1 scaffold.** Plugin shell, manifest, and tsconfig are in
> place; inbound/outbound runtime lands in milestones 2-5.

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

- [x] **M1** Repo bootstrap (this commit) — package.json, manifest, tsconfig, plugin entry stubs
- [ ] **M2** Bridge HTTP/SSE client (daemon.ts, config-schema)
- [ ] **M3** Inbound — SSE → ChannelEvent, with `fromSelf` drop + `mentionedIds` group gate
- [ ] **M4** Outbound — `/send` with `{chatId, message, mentions?}` + chunking
- [ ] **M5** Lifecycle — connect/disconnect, single-consumer lock, health monitor
- [ ] **M6** Tests — port the 14 Python regression cases from `hermes-agent/tests/gateway/platforms/test_wechat.py`
- [ ] **M7** Catalog PR — add to `scripts/lib/official-external-channel-catalog.json` upstream

## License

MIT — see [LICENSE](./LICENSE)
