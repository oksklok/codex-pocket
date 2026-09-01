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

## Normal macOS use

Double-click `Codex Pocket.app` in this repository.

The launcher finds Node from `PATH` or the bundled ChatGPT/Codex runtime, starts the gateway in the background when needed, and opens Pocket in the default browser. Double-clicking it again opens the existing gateway instead of starting a duplicate. Keep the app bundle inside the project folder so it can locate `gateway.ts`. Closing the browser does not stop Pocket.

For normal phone setup:

1. Double-click `Codex Pocket.app`.
2. Open **Settings**.
3. Enable local-network access, choose the bind address and port, and enter a four-digit PIN.
4. Save and click **Restart Pocket**.
5. Open the phone URL shown in Settings and enter the PIN.

Settings are stored locally in `.codex-pocket.local.json`, which is ignored by Git and created only after the first save. The restart action performs a one-shot background handoff and moves the browser to the new port when necessary. A malformed or unsafe config is ignored with a warning and the gateway falls back to `127.0.0.1:4173`.

LAN mode uses plain HTTP and is intended only for a trusted home network. Remote or untrusted-network access should later go through an encrypted private network such as Tailscale rather than exposing this listener directly.

## Development and troubleshooting

Start or connect a normal Codex TUI to the managed shared runtime when needed:

```sh
codex --remote unix://
```

The existing development command still works:

```sh
npm start
```

For troubleshooting or one-off overrides, command-line host/port values and `CODEX_POCKET_PIN` take precedence over the saved file:

```sh
CODEX_POCKET_PIN=1234 npm start -- --host 0.0.0.0
npm start -- --host 192.168.1.123 --port 4180
```

Precedence is: safe defaults, then the saved local file, then explicit CLI `--host`/`--port` and the `CODEX_POCKET_PIN` environment variable. Successful LAN login creates a random HttpOnly, SameSite session cookie; the PIN is not placed in URLs. Repeated incorrect PIN attempts are temporarily throttled in memory.

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

- a fixed-height chat client whose transcript is the only normally scrolling area;
- a compact top bar for loaded task, state, model, reasoning effort, task info, and Settings;
- a collapsible desktop inspector (phone drawer) for machine/project/task details, plans, and command/tool activity;
- Working, Waiting for input, Waiting for permission, Done, and Failed states;
- elapsed current-turn time;
- live coalesced assistant messages and user messages when exposed;
- recent conversation history with older pages loaded automatically when scrolling upward; and
- a bottom composer that starts an idle turn, steers an active turn immediately, or holds one in-memory message for the next turn.

Model and effort options come from the connected app-server's `model/list` catalog. Pocket applies changes with `thread/settings/update`; while a turn is active, the controls are marked **Next turn**. The one-message queue exists only in gateway memory, can be replaced or cancelled, starts after the current turn completes, and is discarded when the selected task changes or Pocket restarts.

The low-bandwidth filtering remains internal. Optional byte counters are available from `/api/diagnostics`; they are not included in normal browser snapshots or SSE events.

## Read-only boundary

Codex Pocket v0.1 cannot approve requests, answer structured input requests, interrupt turns, create threads, browse files, show diffs, or open a terminal. Pending permission and structured-input requests disable the normal composer instead of guessing how to answer them. It has no database, accounts, PWA layer, or deployment configuration. LAN listening is opt-in through local Settings or an explicit `--host` override and always requires a valid four-digit PIN.

## Protocol probe

The disposable protocol probe remains available:

```sh
npm run probe -- --list-only
```

The completed macOS connectivity results are in [`SPIKE_REPORT.md`](./SPIKE_REPORT.md). The gateway reuses its supported WebSocket-over-`codex app-server proxy` transport and the paginated `thread/turns/list` API.
