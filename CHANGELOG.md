# Changelog

All notable changes to this project. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning
follows [Semver](https://semver.org/).

## [0.0.1] — 2026-04-28

First public release. Outbound is feature-complete and end-to-end
verified against `openclaw-cli 2026.4.24`. Inbound dispatch into
openclaw's reply engine is the only piece still stubbed; it lands in
v0.1.

### What works today

- **Plugin discovery + registration** — installs via
  `openclaw plugins install @leeguoo/openclaw-wechat-bridge`, channel
  id `wechat-bridge`, complementary to Tencent's `openclaw-weixin`.
- **Lifecycle (`gateway.startAccount`)** — instantiates a
  `BridgeRuntime` per resolved account at gateway boot, honors
  `ctx.abortSignal` for shutdown, emits `ChannelAccountSnapshot`-shaped
  status updates so openclaw's health monitor can drive auto-restart.
- **Single-consumer bridge lock** — per-process Map keyed on
  `wechat-bridge:${baseUrl}`, compare-and-delete release.
- **Outbound `outbound.sendText`** — adapts our M4 send pipeline into
  openclaw's flat `ChannelOutboundAdapter` contract:
    - `{chatId, message, mentions?}` POST shape (matches
      `hermes-agent`'s adapter wire-for-wire).
    - Auto-retry on 503 (3 attempts with linear backoff).
    - Auth-fatal (401/402) maps to a permanent-error phrase so
      openclaw's queue recovery skips retry instead of looping for
      ~12 minutes.
    - Outer chunker hard-cuts at 4096 chars so each openclaw send call
      = one bridge POST = one retry unit (avoids duplicate delivery
      on retry).
- **Messaging target parser** — accepts `wxid_*`, `gh_*`, `wm_*`,
  `wb_*`, `v\d+_*`, `*@chatroom`, and `filehelper`. Same regex as
  `hermes-agent/tools/send_message_tool.py`.
- **SSE consume + gating** — bridge `/messages/stream` events flow
  through `RecentMessageIds` dedupe, `fromSelf` drop, and `mentionedIds`
  group-mention gating before reaching the dispatch callback. The
  callback is currently a debug log; v0.1 will wire it to openclaw's
  reply engine.
- **Health monitor** — periodic `/health` poll with state-transition
  on degraded/auth-fatal/healthy outcomes. Force-reconnect on
  degraded so a stale SSE doesn't outlive a bridge restart.
- **Abort-aware sleep** — `runtime.stop()` is sub-second instead of
  blocking until the next health interval.

### What's intentionally NOT in this release

- **Inbound dispatch** to openclaw's reply pipeline. Track v0.1.
- **Media outbound** (image / video / voice / document). Track v0.1.
- **Setup wizard** for first-run TCC + bridge-reachability walkthrough.

### Known limitations

- macOS only (Apple Silicon), WeChat 4.1.8 — same as upstream
  [`wechat-skill`](https://github.com/leeguooooo/wechat-skill).
- Outbound calls are not user-cancellable — openclaw's
  `ChannelOutboundContext` doesn't carry an `AbortSignal`. Stuck POSTs
  are bounded by undici's bodyTimeout (30s).
- Single bridge per host — multi-bridge deployments need separate
  account entries under `channels.wechat-bridge.accounts.*`, not yet
  battle-tested.

### Verification

- 53 vitest unit tests pass (M2 daemon, M3 inbound gating, M4
  outbound, M5a runtime lifecycle, bridge lock).
- Live integration verified against `openclaw-cli 2026.4.24`:
    - `openclaw gateway` starts cleanly with our plugin in the
      registered plugin list.
    - `openclaw message send --channel wechat-bridge --target
      filehelper --message "..."` exercises the full path through to
      the bridge `POST /send`.
    - Bridge unreachable → graceful degrade + openclaw-driven
      auto-restart.
    - Auth-fatal (HTTP 401) → permanent error, no retry storm.
    - Chunking (5000-char input) → 2 POSTs at 4096+904 bytes,
      separate retry units.
