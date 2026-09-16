# Optional local DeepSeek runtime

DeepSeek runs **through Codex app-server**, alongside the existing OpenAI runtimes. It is disabled by default, macOS-only, and appears as a separate `<local machine name> [DeepSeek] [Host]` entry next to the OpenAI `<local machine name> [OpenAI] [Host]` one. The machine name is never rewritten; the provider is separate metadata shown as a badge. There is no browser-to-DeepSeek connection, automatic failover, or conversation migration.

## Enable from Settings

Normal menu-bar Pocket can run the fallback. Open **Settings → Runtimes**, tick **Enable DeepSeek**, and save. The change applies on the **next manual restart**: restart Pocket yourself (the menu-bar Restart, or Quit and launch again). Pocket never restarts itself, and a running instance keeps its current runtimes until then. Disabling removes the entry on the next launch while keeping its sessions, isolation home, and receipts.

The checkbox is hidden on Linux and in Docker/headless hosts, and those hosts never create the runtime. It only records a boolean in Pocket's existing private settings file; older settings files without the flag keep working with DeepSeek off.

The runtime needs the host key file below. Without it, the DeepSeek entry still exists and reports the setup error; the other runtimes are unaffected.

## Host key file

When `DEEPSEEK_API_KEY` is not explicitly set, Pocket reads the key from:

```
~/.codex-pocket/secrets/deepseek-api-key
```

Create the directory with permissions `700` and the file with `600`, and put one key in it, optionally with a single trailing newline (`chmod 700 ~/.codex-pocket/secrets; chmod 600 ~/.codex-pocket/secrets/deepseek-api-key`).

The value is passed directly to the DeepSeek supervisor/server/proxy. It is never written to saved settings, browser responses or storage, logs, diagnostics, command arguments, or the environment of ordinary OpenAI/SSH children. A missing, unreadable, oversized, symlinked, non-regular, or too-permissive file is reported clearly instead of being used. If `DEEPSEEK_API_KEY` **is** set, it wins; an explicitly supplied but invalid value (for example an empty string or one with embedded newlines) fails clearly rather than falling back to the file. There is no key-entry UI, Keychain integration, configurable secret path, or automatic migration.

## Foreground launch override

The environment flag remains a documented override for a foreground instance; normal menu-bar use does not need it.

Quit the **Pocket menu-bar host** before launching this foreground instance. Leave ChatGPT/Codex and its daemon running. A menu-bar app does not generally inherit a terminal's environment.

From this checkout, with Node 22.6+ available:

```sh
(
  set +x
  export POCKET_DEEPSEEK=1
  export DEEPSEEK_API_KEY
  IFS= read -r DEEPSEEK_API_KEY < "$HOME/Documents/deepseek-api-key.txt"
  export CODEX_BIN="$HOME/.local/bin/codex"
  exec node --experimental-strip-types gateway.ts --host 127.0.0.1 --port 8787
)
```

The file must contain only the API key. `POCKET_DEEPSEEK=1` forces the runtime on for that launch even when the saved setting is off. Pocket does not persist the key or expose it through settings. The subshell confines these environment changes to this launch. Do not enable shell tracing. If `node` is not on PATH on this Mac, replace `node` above with:

```sh
"$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
```

Open the printed local URL and choose the separate DeepSeek entry when creating a task. Existing local and SSH entries remain available. Missing credentials leave DeepSeek unavailable with setup instructions; they do not prevent the other runtimes from connecting. LAN access still uses Pocket's existing host/PIN settings.

## Isolation and lifecycle

- The fixed absolute home is `~/.codex-pocket/deepseek`. Pocket generates `config.toml` and `models.json` there; sessions, SQLite state, and logs also stay there. Treat those two generated files as Pocket-owned. They contain no API key.
- Pocket starts one foreground Codex server on `~/.codex-pocket/deepseek/pocket.sock`, then uses its existing HTTP-upgrade/WebSocket framing through `codex app-server proxy --sock …`. Bare app-server stdio is not used. No daemon bootstrap, default daemon restart, or daemon replacement occurs.
- An exclusive `pocket-owner` lock prevents duplicate hosts. A small supervisor stops its specific child when Pocket exits or loses IPC. A dropped proxy reconnects to the same owned server; a dead server is restarted by the existing runtime backoff. Normal exit removes the owned endpoint and lock, while keeping sessions. An unowned endpoint or stale ownership lock fails clearly rather than attaching to or killing another process. If the supervisor itself is forcibly killed, inspect the lock's PID and endpoint before removing stale files; never use broad process-killing commands.
- Both server and proxy receive the separate home and pinned provider configuration. Effective configuration is checked on connection and before task start/resume, settings changes, and new turns. Trusted project model settings cannot redirect this runtime to OpenAI. Incompatible provider/auth/storage settings fail closed. Symlinked homes/configuration are rejected.
- The API key comes from `DEEPSEEK_API_KEY` or the host key file and is passed only to the DeepSeek supervisor/server/proxy; it is never added to `process.env`. Ordinary local/SSH children have it removed. Agent shells exclude it and OpenAI credentials, and configuration that would reintroduce those names through `shell_environment_policy.set` is rejected; login shells are disabled for this runtime. Standalone `command/exec` calls explicitly unset it as well. Project MCP servers, notification commands, and hooks are rejected because this version does not provision credential isolation for those extra processes. The key is still a host secret, not a security boundary against software running as the same OS user or deliberate file access with Full access.
- Runtime identity separates task catalogs, drafts, choices, queues, and receipts. DeepSeek has a separate receipt store and epoch. No existing conversation is copied.
- To disable: clear **Enable DeepSeek** in Settings and restart Pocket, or Ctrl-C a foreground instance that was started with the environment override. Keep `~/.codex-pocket/deepseek` to resume its sessions on a later launch. This does not alter `~/.codex`, shell profiles, launchctl, the official app, or the Codex installation.

## Supported controls

The initial model is `deepseek-flash`, using `https://api.deepseek.com/responses` via Codex's Responses provider. The catalog exposes `low`, `high`, and `max` effort, with `high` initially selected; the chosen task effort is preserved on resume. Text, native image input, shell commands, freeform `apply_patch`, Pocket's staged file attachments, history, Stop, queue, and reconnect use the existing runtime code.

Ask and Full access use the existing Codex permission profiles. Automatic approval review is unavailable. Web search and multi-agent delegation are disabled. OpenAI subscription quota is never shown as a DeepSeek allowance; Pocket does not fetch DeepSeek billing information. Provider-side file uploads, built-in search, and OpenAI apps are not added by this integration. Pocket attachments remain files staged on the host for the agent to read.

The model metadata was checked against DeepSeek's [official Codex integration](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) and its [published setup script](https://cdn.deepseek.com/api-docs/codex-deepseek-setup-en.sh), inspected without executing it. `deepseek-models.json` retains the documented model/tool/effort metadata, disables search, and supplies a short Pocket coding-agent instruction instead of copying the setup script's long prompt. The [Responses compatibility table](https://api-docs.deepseek.com/guides/responses_api/) documents image input, function tools and the `apply_patch` custom tool; built-in search is ignored. Codex's [configuration reference](https://developers.openai.com/codex/config-reference/) documents provider and environment configuration.

## Validation

```sh
npm test
npm run test:browser
# With DEEPSEEK_API_KEY supplied in this process's environment:
npm run test:deepseek:live
```

The live script must run while another DeepSeek Pocket host is not using its endpoint. It creates a disposable Git repo in the system temp directory, trusts only that repo in the isolated home, and tests a conflicting project model setting. It leaves the disposable workspace and DeepSeek session available for inspection. It never uses this checkout as the agent's working directory. The key can be supplied with the same subshell above, replacing the final command with `node --experimental-strip-types scripts/deepseek-smoke.mjs`.

Logic tests simulate saved enablement and restart-required handling, host key file resolution, missing credentials, child environment boundaries, provider/config rejection, separate state/receipts/quota, startup failure and recovery, duplicate ownership, parent death, symlink rejection, and error redaction. They use temporary settings, homes, and synthetic key files; they never read the real key. The browser suite uses synthetic RPC fixtures and checks the provider badges, unchanged `local`/`local:deepseek` identities, and narrow-screen layout; those tests alone do not establish provider compatibility.

Live validation on 2026-09-16 used the installed standalone **Codex 0.154.0**, with the app-server initialization independently reporting **0.154.0**. The installed ChatGPT-bundled CLI was **0.154.0-alpha.6.2**; neither binary was changed. The local key was supplied from the host file without printing or persisting it. The live smoke covers model discovery, task creation, file read, patch, shell/test execution, shell credential exclusion, image recognition, Stop, proxy reconnect, and persisted resume after an owned-server restart. The normal OpenAI home is separately checked for unchanged config/auth/model catalog hashes.

The final boundary check kept the official server connected at `~/.codex` while starting and stopping the isolated server. All four normal `config.toml`, `auth.json`, `models.json`, and `models_cache.json` hashes stayed unchanged during that cycle. Config/auth/catalog also stayed unchanged across the whole implementation session. The normal cache's `fetched_at` advanced during the longer session with the official runtime active; its whole-session hash therefore differed. A small, plain-color image produced inconsistent descriptions in exploratory checks; the final larger fixture passed exact text (`POCKET 42`) and color recognition. Image input is supported, but a successful request does not guarantee accurate visual interpretation.
