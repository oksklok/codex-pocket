# Optional local DeepSeek runtime

DeepSeek runs **through Codex app-server**, alongside the existing OpenAI runtimes. It is macOS-only and appears only when a valid credential exists. The task list shows one `<local machine name> [Host]` group for the Mac; when it has more than one runtime, each task row carries a small `[OpenAI]` or `[DeepSeek]` badge, and **New Task** offers a Provider choice. The machine name is never rewritten; the provider is separate metadata, and the runtimes keep their own ids, tasks, drafts, queues, receipts and sessions. There is no browser-to-DeepSeek connection, automatic failover, or conversation migration.

## When DeepSeek appears

There is no provider toggle. On macOS, Pocket exposes DeepSeek at launch whenever a credential resolves: `DEEPSEEK_API_KEY` is set and valid, or the host key file below exists and is valid.

With no credential at all, DeepSeek is simply absent from the available providers and the OpenAI runtimes are unchanged. If a credential exists but is unsafe, unreadable, or invalid, DeepSeek is still left out and **Settings → Runtimes** shows that configuration error instead of accepting it silently. Linux, Windows, and Docker/headless hosts never create the runtime. Removing the credential removes the provider on the next launch; its sessions and other state stay on disk in the isolation home, but message submission receipts live only in the host process memory, so a removed or restarted provider cannot recover a pending submission from them.

## Host key file

When `DEEPSEEK_API_KEY` is not explicitly set, Pocket reads the key from:

```
~/.codex-pocket/secrets/deepseek-api-key
```

Create the directory with permissions `700` and the file with `600`, and put one key in it, optionally with a single trailing newline (`chmod 700 ~/.codex-pocket/secrets; chmod 600 ~/.codex-pocket/secrets/deepseek-api-key`).

The value is passed directly to the DeepSeek supervisor/server/proxy. It is never written to saved settings, browser responses or storage, logs, diagnostics, command arguments, or the environment of ordinary OpenAI/SSH children. An unreadable, oversized, symlinked, non-regular, or too-permissive file is reported in Settings instead of being used. If `DEEPSEEK_API_KEY` **is** set, it wins; an explicitly supplied but invalid value (for example an empty string or one with embedded newlines) is reported rather than falling back to the file. There is no key-entry UI, Keychain integration, configurable secret path, or automatic migration.

## Foreground launch

Quit the **Pocket menu-bar host** before launching this foreground instance. Leave ChatGPT/Codex and its daemon running. A menu-bar app does not generally inherit a terminal's environment.

From this checkout, with Node 22.6+ available:

```sh
(
  set +x
  export DEEPSEEK_API_KEY
  IFS= read -r DEEPSEEK_API_KEY < "$HOME/Documents/deepseek-api-key.txt"
  export CODEX_BIN="$HOME/.local/bin/codex"
  exec node --experimental-strip-types gateway.ts --host 127.0.0.1 --port 8787
)
```

The file must contain only the API key; supplying it in the environment is enough to expose DeepSeek for that launch. Pocket does not persist the key or expose it through settings. The subshell confines these environment changes to this launch. Do not enable shell tracing. If `node` is not on PATH on this Mac, replace `node` above with:

```sh
"$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
```

Open the printed local URL and choose the separate DeepSeek entry when creating a task. Existing local and SSH entries remain available. A missing credential simply leaves DeepSeek out of the available providers, and a credential that exists but is unsafe or invalid is reported in **Settings → Runtimes**; neither affects the other runtimes. LAN access still uses Pocket's existing host/PIN settings.

## Isolation and lifecycle

- The fixed absolute home is `~/.codex-pocket/deepseek`. Pocket generates `config.toml` and `models.json` there; sessions, SQLite state, and logs also stay there. Treat those two generated files as Pocket-owned. They contain no API key.
- Pocket starts one foreground Codex server on `~/.codex-pocket/deepseek/pocket.sock`, then uses its existing HTTP-upgrade/WebSocket framing through `codex app-server proxy --sock …`. Bare app-server stdio is not used. No daemon bootstrap, default daemon restart, or daemon replacement occurs.
- An exclusive `pocket-owner` lock prevents duplicate hosts. A small supervisor stops its specific child when Pocket exits or loses IPC. A dropped proxy reconnects to the same owned server; a dead server is restarted by the existing runtime backoff. Normal exit removes the owned endpoint and lock, while keeping sessions. An unowned endpoint or stale ownership lock fails clearly rather than attaching to or killing another process. If the supervisor itself is forcibly killed, inspect the lock's PID and endpoint before removing stale files; never use broad process-killing commands.
- Both server and proxy receive the separate home and pinned provider configuration. Effective configuration is checked on connection and before task start/resume, settings changes, and new turns. Trusted project model settings cannot redirect this runtime to OpenAI. Incompatible provider/auth/storage settings fail closed. Symlinked homes/configuration are rejected.
- The API key comes from `DEEPSEEK_API_KEY` or the host key file and is passed only to the DeepSeek supervisor/server/proxy; it is never added to `process.env`. Ordinary local/SSH children have it removed. Agent shells exclude it and OpenAI credentials, and configuration that would reintroduce those names through `shell_environment_policy.set` is rejected; login shells are disabled for this runtime. Standalone `command/exec` calls explicitly unset it as well. Project MCP servers, notification commands, and hooks are rejected because this version does not provision credential isolation for those extra processes. The key is still a host secret, not a security boundary against software running as the same OS user or deliberate file access with Full access.
- Runtime identity separates task catalogs, drafts, choices, queues, and receipts. DeepSeek has a separate receipt store and epoch, and those receipts are in-memory like the OpenAI ones. No existing conversation is copied.
- To remove the provider: delete `~/.codex-pocket/secrets/deepseek-api-key` and unset `DEEPSEEK_API_KEY`, then restart Pocket. Keep `~/.codex-pocket/deepseek` to resume its sessions on a later launch. This does not alter `~/.codex`, shell profiles, launchctl, the official app, or the Codex installation.

## Supported controls

The initial model is `deepseek-flash`, using `https://api.deepseek.com/responses` via Codex's Responses provider. The catalog exposes `low`, `high`, and `max` effort, with `high` initially selected; the chosen task effort is preserved on resume. Text, native image input, shell commands, freeform `apply_patch`, Pocket's staged file attachments, history, Stop, queue, and reconnect use the existing runtime code.

Ask and Full access use the existing Codex permission profiles. Automatic approval review is unavailable. Web search and multi-agent delegation are disabled. OpenAI subscription quota is never shown as a DeepSeek allowance. Provider-side file uploads, built-in search, and OpenAI apps are not added by this integration. Pocket attachments remain files staged on the host for the agent to read.

While the DeepSeek runtime is selected, the top-bar quota slot shows the account-wide balance instead of subscription windows (for example `Balance ¥83.42` or `Balance $12.34`). Pocket reads it from the official `GET https://api.deepseek.com/user/balance` endpoint using the same resolved host credential; the currency and `total_balance` come from `balance_infos`, and `is_available` marks insufficient funds. The figure is the whole account's monetary balance, not a per-task or per-token cost, and separate currencies are never added together. One host-side cache and one in-flight request are shared by every client; Pocket refreshes on selection and about once a minute while the runtime stays selected, with a short timeout; failed attempts cool down like successful ones instead of retrying in a loop. A failed, timed-out or malformed response shows `Balance —`, or keeps a last-known value clearly marked as such, and never becomes zero or blocks sending, task creation, connection or reconnect. Only the currency, amount, availability and freshness reach the browser — never the key, authorization headers or raw upstream errors, and there is still no browser-to-DeepSeek request, key-entry UI, billing dashboard or cost estimate. Switching back to an OpenAI runtime restores its subscription windows; a late DeepSeek response cannot replace them. A balance-fetch failure never affects message delivery. The existing **Show Quota or Balance** preference controls this slot; there is no separate toggle.

The model metadata was checked against DeepSeek's [official Codex integration](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) and its [published setup script](https://cdn.deepseek.com/api-docs/codex-deepseek-setup-en.sh), inspected without executing it. `deepseek-models.json` retains the documented model/tool/effort metadata, disables search, and supplies a short Pocket coding-agent instruction instead of copying the setup script's long prompt. The [Responses compatibility table](https://api-docs.deepseek.com/guides/responses_api/) documents image input, function tools and the `apply_patch` custom tool; built-in search is ignored. Codex's [configuration reference](https://developers.openai.com/codex/config-reference/) documents provider and environment configuration.

## Validation

Live validation on 2026-09-16 used the installed standalone **Codex 0.154.0**, with the app-server initialization independently reporting **0.154.0**. The installed ChatGPT-bundled CLI was **0.154.0-alpha.6.2**; neither binary was changed. The local key was supplied from the host file without printing or persisting it. Validation covered model discovery, task creation, file read, patch, shell command execution, shell credential exclusion, image recognition, Stop, proxy reconnect, and persisted resume after an owned-server restart. The normal OpenAI home was separately checked for unchanged config/auth/model catalog hashes.

The final boundary check kept the official server connected at `~/.codex` while starting and stopping the isolated server. All four normal `config.toml`, `auth.json`, `models.json`, and `models_cache.json` hashes stayed unchanged during that cycle. Config/auth/catalog also stayed unchanged across the whole implementation session. The normal cache's `fetched_at` advanced during the longer session with the official runtime active; its whole-session hash therefore differed. A small, plain-color image produced inconsistent descriptions in exploratory checks; the final larger fixture passed exact text (`POCKET 42`) and color recognition. Image input is supported, but a successful request does not guarantee accurate visual interpretation.
