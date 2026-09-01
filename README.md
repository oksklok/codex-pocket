# Codex Pocket

Codex Pocket v0.1 is a tiny browser client for loaded Codex app-server threads with normal message sending, task access controls, approval handling, and structured input answers.

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

To add a development machine that already works through SSH:

```text
Settings → Machines → Add
Name: G14
SSH alias: g14
Save → Restart Pocket
```

`This Mac` is always available. The top bar's **Machine** selector chooses a local or configured SSH runtime, and **Task** then shows only that machine's loaded Codex tasks.

Settings are stored locally in `.codex-pocket.local.json`, which is ignored by Git and created only after the first save. The restart action performs a one-shot background handoff and moves the browser to the new port when necessary. A malformed or unsafe config is ignored with a warning and the gateway falls back to `127.0.0.1:4173`.

LAN mode uses plain HTTP and is intended only for a trusted home network. Remote or untrusted-network access should later go through an encrypted private network such as Tailscale rather than exposing this listener directly.

## SSH machines

Remote machines are optional entries in `.codex-pocket.local.json`:

```json
{
  "machines": [
    { "name": "G14", "ssh": "g14" },
    { "name": "PC1", "ssh": "pc1" }
  ]
}
```

Pocket uses the existing SSH configuration, keys, and agent from this Mac. It does not store SSH credentials. Each alias must already work non-interactively; test it normally with `ssh g14` before adding it. Pocket connects with SSH batch mode to the remote `codex app-server proxy`, keeps each machine's runtime and task state isolated, and retries a dropped connection after five seconds without interrupting other machines.

Only tasks loaded in a supported shared/managed app-server runtime are available. Private Desktop stdio tasks are intentionally not discovered or attached.

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
- compact Machine → Task selectors plus state, model, reasoning effort, task info, and Settings;
- an Access selector for Ask for approval, Approve for me, and Full access using each task's app-server permission profile;
- a collapsible desktop inspector (phone drawer) for machine/project/task details, plans, and command/tool activity;
- Working, Waiting for input, Waiting for permission, Done, and Failed states;
- elapsed current-turn time;
- live coalesced assistant messages and user messages when exposed;
- recent conversation history with older pages loaded automatically when scrolling upward;
- a compact Stop control for the selected task's active turn;
- a bottom composer that starts an idle turn, steers an active turn immediately, or holds one in-memory message for the next turn;
- compact Approve/Deny cards for command, file-change, and additional-permission requests; and
- compact answer cards for supported Codex multiple-choice, Other, and free-text questions.

Model and effort options come from the connected app-server's `model/list` catalog. Pocket applies changes with `thread/settings/update`; while a turn is active, the controls are marked **Next turn**. The one-message queue exists only in gateway memory, can be replaced or cancelled, starts after the current turn completes, and is discarded when the selected task changes or Pocket restarts.

If Stop interrupts a turn while a next message is queued, Pocket leaves that message parked instead of automatically starting another turn. The queue banner then offers explicit Send and Cancel actions. The low-bandwidth filtering remains internal. Optional byte counters are available from `/api/diagnostics`; they are not included in normal browser snapshots or SSE events.

## Control boundary

Access choices, approval decisions, and structured input answers use the selected machine's supported app-server protocol; Pocket does not edit `config.toml`. Approve is one request/one turn only, and additional-permission approval grants only the requested subset. Pocket validates every structured answer against the pending request and sends the app-server's exact response shape; unsupported or stale request variants remain local-only.

Codex Pocket v0.1 still cannot retry turns, create threads, browse files, show diffs, or open a terminal. It has no database, accounts, PWA layer, or deployment configuration. LAN listening is opt-in through local Settings or an explicit `--host` override and always requires a valid four-digit PIN.

## Protocol probe

The disposable protocol probe remains available:

```sh
npm run probe -- --list-only
```

For a one-off SSH transport check against another machine, use an existing SSH host or alias:

```sh
npm run probe-remote -- g14 --list-only
npm run probe-remote -- g14 --monitor-seconds 30
```

This launches `codex app-server proxy` on the remote host through normal SSH stdio, then speaks the same app-server protocol as the local probe. It uses the user's existing SSH configuration and credentials; Pocket stores none. The probe is intentionally disposable and does not reconnect automatically—run it again after an SSH disconnect.

The completed macOS connectivity results are in [`SPIKE_REPORT.md`](./SPIKE_REPORT.md). The gateway reuses its supported WebSocket-over-`codex app-server proxy` transport and the paginated `thread/turns/list` API.
