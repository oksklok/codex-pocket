# Codex app-server connectivity spike

Date: 2026-08-30

## Environment

- macOS 15.7.4, Apple Silicon
- Codex CLI: `0.149.1`
- managed app-server: running, `0.149.1`
- Codex Desktop: `26.825.41651`
- newer CLI reported by `codex doctor`: `0.151.0`
- Node.js: bundled `24.19.0`; `node` and `npm` were not on the normal shell `PATH`

The installed CLI exposes:

- `codex app-server --listen stdio://|unix://|unix://PATH|ws://IP:PORT|off`
- `codex app-server daemon ...`
- `codex app-server proxy`
- `codex --remote ws://...|wss://...|unix://|unix://PATH`
- exact stable/experimental TypeScript and JSON Schema generation

## Topology results

### Current Desktop session: not attachable

Desktop owns a separate `codex ... app-server` process over its parent-controlled stdio. It was not started with a Unix-socket or WebSocket listener, so there was no supported endpoint for a second client to open.

The managed daemon is a different app-server process. Through supported protocol calls, it listed the current Desktop thread in persisted storage with `status=notLoaded`, while `thread/loaded/list` returned no loaded threads. This proves the daemon did not own or expose the Desktop thread's live runtime. The spike deliberately did not try to turn that stored thread into a second live copy.

No Desktop IPC socket, database, rollout/session file, terminal scrape, or screen capture was used.

### Shared runtime: worked

This topology worked:

```text
managed Codex app-server 0.149.1
├── normal Codex TUI via `codex --remote unix://`
└── probe via WebSocket over `codex app-server proxy`
```

Both clients used thread `example-thread-id` (synthetic identifier). The TUI initiated a real turn while the probe was subscribed. The probe observed its full compact lifecycle without reading TUI output.

`codex app-server proxy` forwards raw bytes to the Unix control socket; it is not a JSONL adapter. The probe therefore performs the normal HTTP WebSocket upgrade and WebSocket framing through the proxy.

## Verified protocol primitives

| Primitive | Result |
| --- | --- |
| `initialize` then `initialized` | Passed |
| `thread/list` | Passed |
| `thread/loaded/list` | Passed |
| identify active/idle runtime status | Passed |
| `thread/resume` with `excludeTurns: true` | Passed; returned zero turns and `canAcceptDirectInput=true` |
| `thread/turns/list` with cursor, `itemsView: summary` | Passed |
| thread/turn state notifications | Observed |
| assistant message deltas | Observed |
| command start/completion | Observed; output content suppressed, byte length summarized |
| plan updates | Observed |
| turn completion | Observed with `status=completed` |
| `turn/steer` | Passed on the TUI-owned active turn |
| `turn/interrupt` | Passed; observed `turn/completed` with `status=interrupted` |
| MCP/dynamic tool lifecycle | Implemented, not exercised |
| permission and input requests plus `serverRequest/resolved` | Implemented from generated schema, not observed |
| failed turn/error event | Implemented, not deliberately induced |

The permission-routing attempt used an empty marker under `/tmp`, but this daemon's effective profile allowed it, so no request was emitted. The marker was removed and its absence verified. The probe never auto-approves or answers server requests.

## Raw inbound bandwidth

Final unfiltered baseline:

- `24.8 KiB`
- `59` inbound app-server JSON messages
- `23.5 seconds`
- approximately `1.1 KiB/s`

This includes initialization, thread discovery, resume without turns, one summarized history page, and a real turn containing plan updates, a tiny command, and assistant text. The count is JSON payload bytes received from app-server, before local filtering; it excludes WebSocket framing, HTTP upgrade bytes, TCP, and TLS overhead.

The probe receives and counts reasoning, raw-response, command-output, and diff events but suppresses their contents in console output.

## Windows and transport limitations

This experiment ran only on macOS. A managed Windows daemon/socket topology was not verified.

The official protocol documents loopback WebSocket as the smallest cross-platform alternative:

```sh
codex app-server --listen ws://127.0.0.1:4500
codex --remote ws://127.0.0.1:4500
```

That transport is currently described as experimental and unsupported for production. It is suitable for a local spike or an SSH-forwarded loopback connection, not for direct exposure. Non-local use needs the documented WebSocket authentication and TLS protections.

## Smallest next step

Build a read-only loopback gateway around this probe's event reducer:

1. keep one authenticated local app-server connection;
2. expose only a tiny filtered event stream to the browser;
3. serve thread summaries and paginated recent turns; and
4. omit all control and permission responses initially.

No React or PWA framework is needed for that next step. A single Node process plus a static HTML page is enough to measure the app-server-to-browser filtering ratio before choosing any product architecture.
