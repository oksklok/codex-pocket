# Codex Pocket

Codex Pocket v0.1 is a tiny browser view for loaded Codex app-server threads with normal message and follow-up sending.

```text
Codex app-server
        ↓
localhost Node gateway
        ↓ filtered SSE + paginated history
responsive browser UI
```

The browser never receives the raw app-server stream. The gateway keeps a small in-memory state, coalesces assistant text deltas, and forwards only compact thread, turn, message, plan, command/tool, request, and completion updates. Reasoning streams, raw response events, command output, diffs, and file contents stay local and are suppressed.

## Requirements

- Codex CLI with `app-server proxy` support
- Node.js 22.6 or newer
- a thread loaded in the managed app-server, normally by a TUI connected with `codex --remote unix://`

No npm packages are required.

## Run

Start or connect a normal Codex TUI to the managed shared runtime:

```sh
codex --remote unix://
```

In this repository, start the gateway:

```sh
npm start
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173).

The gateway binds to `127.0.0.1` by default and does not require a PIN there. To make it available to a phone or another device on a trusted local network, configure a four-digit PIN and opt into LAN mode:

```sh
npm start
CODEX_POCKET_PIN=1234 npm start -- --host 0.0.0.0
```

Then open `http://YOUR_MAC_LAN_IP:4173` on the other device and enter the same PIN. Successful login creates the existing random HttpOnly, SameSite session cookie; the PIN is not placed in URLs. Repeated incorrect PIN attempts are temporarily throttled in memory. You can also bind only to a specific local address with `--host 192.168.1.123`.

LAN mode uses plain HTTP and is intended only for a trusted home network. Remote or untrusted-network access should later go through an encrypted private network such as Tailscale rather than exposing this listener directly.

Other optional arguments:

```sh
npm start -- --thread THREAD_ID
npm start -- --port 4180
npm start -- --ws ws://127.0.0.1:4500
```

On macOS with only the Codex Desktop bundled Node runtime available:

```sh
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node \
  --experimental-strip-types gateway.ts
```

## Browser view

- connection, machine/platform, project, task, model, and reasoning effort when exposed;
- a compact selector for tasks currently loaded in the shared runtime;
- Working, Waiting for input, Waiting for permission, Done, and Failed states;
- elapsed current-turn time;
- live coalesced assistant messages and user messages when exposed;
- current plan and compact command/tool lifecycle summaries;
- recent conversation history with older pages loaded automatically when scrolling upward; and
- a compact composer that starts an idle turn or steers the active turn.

The low-bandwidth filtering remains internal. Optional byte counters are available from `/api/diagnostics`; they are not included in normal browser snapshots or SSE events.

## Read-only boundary

Codex Pocket v0.1 cannot approve requests, answer structured input requests, interrupt turns, create threads, browse files, show diffs, or open a terminal. It has no database, accounts, PWA layer, or deployment configuration. LAN listening is available only through the explicit `--host` option and requires `CODEX_POCKET_PIN`.

## Protocol probe

The disposable protocol probe remains available:

```sh
npm run probe -- --list-only
```

The completed macOS connectivity results are in [`SPIKE_REPORT.md`](./SPIKE_REPORT.md). The gateway reuses its supported WebSocket-over-`codex app-server proxy` transport and the paginated `thread/turns/list` API.
