# codex-pocket protocol spike

This repository currently contains only a disposable Node/TypeScript probe for the official Codex app-server protocol. It deliberately has no web UI, framework, database, authentication layer, or deployment code.

The probe:

- initializes the JSON-RPC protocol;
- lists stored and currently loaded threads;
- resumes a thread with `excludeTurns: true`;
- pages recent turns with summarized items;
- prints compact live lifecycle, message, command/tool, plan, approval/input, and completion events;
- receives and counts high-volume reasoning, command-output, raw-response, and diff notifications but suppresses their content in console output;
- counts all raw inbound app-server payload bytes before local filtering; and
- can optionally start, steer, or interrupt a turn for controlled testing.

It speaks the documented WebSocket transport through the supported `codex app-server proxy` command, which forwards bytes to the managed daemon's local Unix control socket. No Codex database, rollout/session file, terminal output, or screen content is read.

## Requirements

- Codex CLI with `app-server proxy` support
- Node.js 22.6 or newer (Node 24 was used for this spike)

No npm packages are required.

## Run

List threads without attaching:

```sh
npm run probe -- --list-only
```

Attach to the newest active/loaded thread, fetch one compact history page, and monitor for 30 seconds:

```sh
npm run probe -- --monitor-seconds 30
```

Select a thread explicitly:

```sh
npm run probe -- --thread THREAD_ID --history-pages 2 --history-limit 5
```

For a separately started loopback listener, bypass the managed-daemon proxy:

```sh
codex app-server --listen ws://127.0.0.1:4500
npm run probe -- --ws ws://127.0.0.1:4500
```

Safe control options are `--start-turn TEXT`, `--steer TEXT`, and `--interrupt`. The probe never answers or auto-approves permission requests.

On this machine, Node is bundled with the Codex Desktop app but is not on the shell `PATH`. The equivalent direct command used during the spike was:

```sh
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --experimental-strip-types probe.ts --list-only
```

Protocol reference: [Codex App Server](https://developers.openai.com/codex/app-server).

Verified local results are recorded in [`SPIKE_REPORT.md`](./SPIKE_REPORT.md).
