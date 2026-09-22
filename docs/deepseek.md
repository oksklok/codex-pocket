# DeepSeek Harness backend

Pocket can expose DeepSeek alongside the normal OpenAI/Codex runtime by using **DeepSeek Harness (DSH)**. The shipped DSH dependency is pinned in `dsh/package-lock.json` (currently `0.1.7-alpha.2`).

Pocket remains the UI and orchestration layer. DSH owns its agent loop, tools, sessions, compaction, attachments, and persistence; the Pocket adapter projects those facts into the same task/message/activity contract used by the browser.

## Execution-machine setup

On every machine that will run DeepSeek tasks, install Node **22.19+** (or 24+) and the separately locked DSH dependencies:

```sh
npm ci --prefix dsh
```

Place the DeepSeek API key at:

```text
~/.codex-pocket/secrets/deepseek-api-key
```

On POSIX, use directory mode `700` and file mode `600`. The runtime rejects symlinks, non-regular files, wrong ownership, oversized files, and permissive POSIX modes. Windows should restrict the file with the user's ACL.

A local non-headless Pocket host may alternatively inherit `DEEPSEEK_API_KEY`. An explicitly invalid environment value fails instead of silently falling back to the file.

The execution runtime creates its private DSH credential/patch files under `~/.codex-pocket/dsh` and strips DeepSeek/OpenAI/Codex/ChatGPT credential variables before launching DSH. The key stays on the execution machine; it is not sent to the browser or an SSH-only gateway.

Keep DSH runtime files outside cloud-synced folders. A stable location such as `~/.local/share/codex-pocket-runtime` is appropriate for an execution-side copy.

## Local and SSH configuration

A valid local credential exposes a local DeepSeek provider automatically.

For an SSH execution machine, add `dshPath` to that machine's normal Pocket configuration:

```json
{
  "machines": [
    {
      "name": "Execution Mac",
      "ssh": "execution-mac",
      "dshPath": "/Users/example/codex-pocket/dsh/launch.mjs"
    }
  ]
}
```

`dshPath` is the absolute launcher path **on the execution machine**. The existing OpenAI runtime can remain on the same machine; Pocket groups both providers under that physical machine.

The gateway needs SSH access and the `dshPath`, but no DeepSeek key. `node` must be available in the execution user's noninteractive SSH PATH. Windows paths may use a drive-letter form such as `C:/Users/example/codex-pocket/dsh/launch.mjs`.

DSH uses the existing SSH transport. It does not expose a DSH HTTP/WebSocket listener or require port forwarding.

## State and lifecycle

DSH uses:

- home: `~/.codex-pocket/dsh`
- runtime IDs: `local:dsh` and `ssh:<alias>:dsh`
- task IDs: `dsh-<uuid>`

Legacy Codex-based DeepSeek sessions cannot resume in DSH. Their old state is left untouched; there is no migration or provider fallback.

Each DSH home has one durable runtime. `dsh/runtime.mjs` owns the DSH process and private local attach/control endpoints. Losing the browser, gateway, or SSH carrier detaches Pocket but does not intentionally stop a turn DSH already accepted. Reattachment reloads durable history and pending human requests.

### Ownership

The sole ownership authority is:

```text
~/.codex-pocket/dsh/pocket-owner.lock
```

It is a directory acquired with an atomic `mkdir`. A live owner is never stolen. A missing/dead/invalid owner inside an existing lock is treated as stale and **is not reclaimed automatically**.

After an ungraceful runtime death, manual removal of `pocket-owner.lock` may therefore be required. This is an intentional simplicity tradeoff.

The separate `pocket-owner` bare-PID file exists only for inspection/deployment tooling; it is not the ownership authority.

### Control and shutdown

A separate private control endpoint handles status and idle-only shutdown. `runtime.mjs --stop` refuses while a turn is active or starting. Once shutdown is accepted, the runtime drains new work and does not report completion until its DSH child has actually exited.

Deployment tooling treats timeouts, malformed replies, failed ownership probes, and incomplete child enumeration as **unknown**, never as proof of idleness.

### Request safety

`dsh/router.mjs` gives forwarded client requests private child IDs and restores each reply only to the connection that owns it. A superseded connection can no longer submit work, and late replies cannot satisfy a newer connection that reused an ID.

Pending approval/question requests survive reattachment. Pocket never auto-approves them and never automatically resends a possibly accepted prompt.

## Supported behavior and limits

The adapter supports the normal Pocket task flow: create/resume/history, rename, archive/unarchive/delete, task switching, model/effort/access settings, messages, Stop, queue/steer, images, staged files, goals, approvals, structured questions, and activity projection.

Ask maps to DSH workspace-write with user approval. Full Access maps to danger-full-access with approvals disabled. Conflicting or unsupported mappings fail closed; automatic approval review is not configured.

Structured questions use Pocket's existing question UI. Pocket accepts at most three DSH questions with at most twenty options each.

Delete removes the persisted DSH session plus its workspace/archive bookkeeping after the idle live Agent is disposed. Shared content-addressed attachments are not garbage-collected by Pocket.

Changing an existing task's Project Folder creates and verifies a seeded replacement session under the new `cwd`, applies preserved settings, then removes the original. A failure discards the replacement and keeps the original task intact.

History is paginated. DSH user images remain session-scoped attachments and are read back through the adapter, subject to Pocket's existing type/size checks.

Native `web_search` and other DSH tools appear through Pocket's existing activity surfaces. DSH's direct web-fetch guard is left intact; Pocket does not bypass its public-address checks.

Account Balance is fetched and sanitized on the execution machine. Balance failures do not block turns and do not become a synthetic zero balance.

## Deployment

Run the coordinated deployment command from the gateway-host checkout:

```sh
node scripts/deploy.mjs
```

`npm run deploy` is equivalent.

The deploy command:

1. inspects configured execution machines without mutating them;
2. verifies the installed adapter bytes rather than trusting only its manifest;
3. stages and load-probes changed adapter files before activation;
4. activates only when the runtime is verified idle/absent behind a maintenance marker;
5. verifies the activated adapter;
6. starts/verifies the gateway only when the fleet remains protocol-compatible; and
7. retains the previous adapter/gateway generation for rollback.

Busy, offline, or unverifiable targets remain pending. Re-run the same command after the reported condition is resolved.

Useful flags:

```text
--dry-run
--gateway-only
--adapters-only
--machine <name-or-ssh>
--settings <path>
--confirm-idle
--allow-protocol-change
--rollback
```

`--gateway-only` never stages/stops/updates adapters. `--adapters-only` cannot complete a coordinated protocol transition. `--dry-run` performs no mutation.

### Legacy cutover

An older adapter without the current control/ownership protocol cannot prove its runtime idle. Drain its work and use:

```sh
node scripts/deploy.mjs --confirm-idle
```

This exception is for the deliberate legacy cutover; `--confirm-idle` does not override an unverifiable modern runtime.

### Protocol changes

When `DSH_ADAPTER_PROTOCOL` changes, drain the affected fleet and run the full deployment with:

```sh
node scripts/deploy.mjs --allow-protocol-change
```

Pocket refuses a partial protocol arrangement.

### Rollback

After draining the target machine:

```sh
node scripts/deploy.mjs --rollback
```

The command restores the retained execution-side generation and verifies it. Add `--confirm-idle` only for a legacy install that has no control endpoint.

A `.pocket-deploying` marker protects an installation during replacement/recovery. A `stuck` or unreadable marker is not silently cleared; resolve the reported machine state before retrying.
