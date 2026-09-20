# DeepSeek Harness backend

OpenAI continues to use the existing Codex app-server backend. DeepSeek uses **DeepSeek Harness (DSH) 0.1.6-alpha.2**, pinned with its dependency tree in `dsh/package-lock.json`. The full shipped `sdk` profile inherits `dsh-base`; Pocket adds DSH's existing Host session services, its native question tool, and a private JSON-RPC stdio carrier. It does not use `sdk-minimal`, DSH's web UI, a Codex subagent, or a fork of DSH.

Pocket remains the UI. Physical-machine grouping and the OpenAI/DeepSeek provider choice are unchanged. The adapter projects DSH's sessions, durable events, native tool activity, approvals and errors into Pocket's existing contract. DSH owns its agent loop, tools, workspace instructions, compaction, attachments and session persistence. Pocket's existing task orchestration, staged files, queues and submission receipts remain in use.

## Execution-machine setup

On each machine that will run DeepSeek tasks, install Node **22.19+** (or 24+) and this checkout, then install the separately locked runtime dependencies:

```sh
npm ci --prefix dsh
```

Do this on the execution machine, not a gateway that only uses SSH. The gateway's normal `npm ci` does not install DSH. A recent npm may ask you to approve DSH's native dependency installation scripts; follow that npm version's installation policy. The local macOS smoke test used Node 26.8.2 and the distributed native components.

Place a single DeepSeek API key in the execution user's file:

```text
~/.codex-pocket/secrets/deepseek-api-key
```

Use directory permissions `700` and file permissions `600` on POSIX. Symlinks, non-regular files, wrong ownership, oversized files and permissive POSIX file modes are rejected. On Windows, restrict the file with the user's ACL; POSIX mode bits do not establish Windows access control. A local launch may instead inherit `DEEPSEEK_API_KEY`; an explicitly invalid environment value fails rather than falling back to the file.

The execution-side launcher provisions DSH's private managed credential store under `~/.codex-pocket/dsh/.credentials.yaml`. It strips DeepSeek/OpenAI/Codex/ChatGPT credential environment variables before starting DSH. Tool processes do not inherit the key. Browser payloads, diagnostics and command arguments contain no key; outgoing protocol frames redact it. This is not a security boundary against deliberate credential-file reads by software running as the same OS user with sufficient filesystem access.

The runtime launches from the isolated home, not the gateway's project directory. It does not discover normal `~/.dsh` profiles or credentials. Pocket owns the generated credential and patch files in this home. Do not put unrelated DSH integrations in its profile. The shipped base tool composition remains enabled, including native search/fetch and subagents. No MCP/plugin-management UI or automatic integration discovery is added.

## Local and SSH selection

For a local non-headless Pocket host, a valid execution credential exposes the DeepSeek provider at launch. This no longer has a macOS-only gate. Runtime installation or launch failures appear through the existing connection/error surfaces.

For a Linux, Docker, NAS or other gateway using an execution machine over SSH, add `dshPath` to that machine's entry in the existing Pocket configuration:

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

The existing OpenAI runtime remains on that machine; DeepSeek shares its physical-machine group. The absolute path is on the **execution machine**. `node` must be available in that user's noninteractive SSH PATH. Verify `ssh execution-mac 'node --version'` and provision the key file there. The gateway needs SSH access and this setting, but no DeepSeek credential or DSH installation. Existing machine edits/reordering preserve the additional setting without introducing controls.

Pocket uses its existing SSH options (batch authentication, connection timeout and keepalives), with DSH JSON-RPC on stdin/stdout. No HTTP/WebSocket listener, exposed endpoint, web UI or port forwarding is added. Windows machines use an absolute drive-letter path such as `C:/Users/example/codex-pocket/dsh/launch.mjs`. Pocket launches it with encoded PowerShell through the existing SSH connection; `node.exe` must be in that SSH environment's PATH. Windows reports the platform family expected by Pocket's existing file and image handling.

Keep execution dependencies outside cloud-synced directories. On Macs with a synced Documents checkout, install the pinned runtime files (`dsh/`, `deepseek.ts`, and `package.json`) under `~/.local/share/codex-pocket-runtime`, run `npm ci --prefix dsh` there, and point `dshPath` at that copy. This changes only the installation path; the existing `~/.codex-pocket/dsh` home and credential remain in use.

## State and lifecycle

DSH uses `~/.codex-pocket/dsh`, runtime IDs `local:dsh` / `ssh:<alias>:dsh`, and new `dsh-<uuid>` task IDs. Task catalogs, browser drafts/choices, queues and in-memory receipt stores use these distinct runtime identities. Old IDs are rejected before DSH session activation.

**Legacy Codex-based DeepSeek sessions cannot resume in DSH.** Their `~/.codex-pocket/deepseek` state is left intact. Normal Codex state is also untouched. There is no conversation converter, migration, provider fallback or failover.

Each execution machine runs one **durable DSH runtime per DSH home**. `dsh/runtime.mjs` owns the home and the DSH agent child and exposes a private local endpoint — a Unix domain socket on POSIX (`<home>/pocket-runtime.sock`, mode 600) or a per-home named pipe on Windows. `dsh/launch.mjs` is a thin attach client; the gateway reaches the runtime over the existing SSH connection, and the endpoint is never exposed on the LAN. A `pocket-owner` lock with PID makes the first runtime the sole owner: a racing start exits without stealing the home, and a stale lock from a dead process is reclaimed. An unclean kill can leave a stale lock or socket; the runtime reclaims them on the next start.

A second private **control** endpoint (`<home>/pocket-control.sock`, or a per-home control pipe on Windows) serves deployment inspection and idle-only shutdown. Because it is separate from the attach endpoint, `runtime.mjs --status` and `--stop` never evict the attached gateway and never receive its pending requests. `--stop` is refused while any turn is active or starting — including a `turn/start` already forwarded to DSH whose gateway connection then dropped — so a busy runtime is never interrupted by a deployment, and `--probe` and `--verify` only load or hash files without starting a runtime. Accepting an idle-only shutdown immediately enters a draining state: competing attaches and any new client work are refused, DSH is asked to stop, and the runtime exits only after the child has actually terminated, so a caller that waits for the owner to disappear has proof of shutdown rather than an acknowledgment. A state is never inferred from a failed probe: only a valid correlated control reply proves idle or busy, and a refused endpoint, a timeout, a malformed answer or a connection that closes before replying is unknown. Absence is established separately by the `--owner` probe, which treats the `pocket-owner` PID as a hint, verifies the process command line against the expected launcher/runtime installation, and reports any DSH child still running. Absence requires all three facts — no live owner, successful child enumeration, and no matching live DSH child — so incomplete ownership evidence leaves the target pending.

The runtime is independent of the gateway connection. A gateway restart, browser disconnect or lost SSH transport only detaches Pocket: the same runtime and any turn DSH already accepted keep running. Reattaching re-reads durable history and the current turn and replays unanswered approval/question requests with their original identities. `dsh/router.mjs` correlates requests through a private child id space: every client request forwarded to DSH gets a fresh id, its reply is restored to the client's own id, and a reply or an answer reaches only the connection that owns it. A superseded connection is retired as a writer, so a late reply from it can never satisfy a newer connection that reused the same numeric id and it can no longer submit work; a request DSH resolves or cancels is retired and never replayed. Pending requests stay pending and are never auto-approved; explicit Stop still interrupts the intended turn; a possibly accepted message is never resent. Credentials stay on the execution machine. Pocket receipts remain process-local, so uncertain delivery stays uncertain instead of triggering an automatic retry. The optional `POCKET_DSH_HOME` environment variable is available for isolated smoke testing.

Optional telemetry, incremental session-log uploads and plugin-inventory request metadata are disabled in the Pocket profile. Required model and search requests still go to their services.

## Controls and limitations

The catalog comes from the pinned DSH adapter: the tested runtime exposed `deepseek-flash` and `deepseek-v4-pro`, with Off/Low/High/Max reasoning. Ask maps to DSH `workspace-write` plus `ask`; Full access maps explicitly to `danger-full-access` plus `never`. Conflicting or unsupported permission mappings fail closed. Automatic approval review is not configured. DSH's one-shot approvals use Pocket's existing approval surface; compatible single-selection/free-text questions use its existing input surface. Questions exceeding Pocket's existing limits (three single-selection questions, twenty options each) are rejected rather than truncated.

Create/resume/history, rename, archive/unarchive, task switching, messages/activity, Stop, queue/steer, image input and staged files use the adapter. DSH's native `web_search` appears as search activity; `web_fetch` and other native tools use existing tool activity/details. Compaction stays inside DSH and its lifecycle maps to existing compaction activity.

**Delete** removes the persisted DSH session and its workspace/archive bookkeeping instead of returning an error. Pocket disposes the live idle DSH Agent through the lifecycle handle DSH already returns, then removes the session-owned artifact directory taken from DSH's own persistence scan; a running task is refused before anything is touched. Content-addressed attachments live under the shared `DSH_HOME/attachments/v1` store and are deliberately left in place. A deleted task stays gone after a fresh DSH process.

**Changing an existing task's Project Folder** uses DSH's seed/replay creation primitive: Pocket creates a replacement session carrying the existing event log under the requested `cwd`, verifies it, removes the original, and only then switches the selected task to the replacement's internal id. The title, model/effort, permission state and conversation behave as before; the task does not appear as a manually created second task. Any failure rolls the replacement back so the original stays intact. DSH's immutable session header is never rewritten.

Message history is paginated: `thread/turns/list` and `thread/items/list` return bounded pages with opaque cursors instead of the whole session, and a summary turn page omits item bodies (Pocket hydrates items separately). DSH user images persist as session attachments; Pocket's existing `/api/message/image` path reads them back through DSH's session-scoped attachment API, which still enforces that the image is referenced by that session. Pocket's existing image size and type checks remain in force.

DSH goal status/objectives and pause/resume/clear map to the existing goal surface. DSH's round cap is not presented as a token budget. The Context chip uses a DSH-reported full-call token total only when the adapter also supplies that model's context-window capacity; missing metadata remains unknown.

## Search, fetch and balance

Native DSH search uses DeepSeek's Anthropic-compatible Messages API and the **same DeepSeek API key**. No additional search credential was needed in the live test. It requires service/network access to that search endpoint and incurs model-request usage. DSH's `web-fetch-http` provider fetches webpages directly and enforces its public-address checks; it needs no additional credential. DNS/proxy setups that resolve public domains to private or fake addresses can cause fetch rejection. Pocket does not disable that guard or substitute shell networking.

Balance is fetched and cached **on the execution machine** through the existing sanitized balance monitor. Only availability, currency/amount, timestamp and freshness metadata cross SSH to the gateway. The account-wide Balance continues to occupy the existing quota slot, including the native host's existing quota/balance presentation. A failed balance request never blocks a turn or becomes a zero balance.

## Validation (2026-09-20)

The headless NAS/Docker gateway was live-verified over SSH against five execution machines: two Macs, two Windows PCs, and one Linux machine. All ten provider runtimes (OpenAI/Codex and DeepSeek/DSH on each machine) passed task creation, a real model turn, resume, and a second real model turn. The NAS catalog and mobile browser UI showed the correct five physical-machine groups. DSH remained pinned at **0.1.6-alpha.2**, with state and DeepSeek credentials on the execution machines and none provisioned on the NAS. Both Windows DSH runtimes used the encoded PowerShell launcher.

All five DSH conversations also restored their persisted two-turn history after a NAS gateway restart. These checks exercised awake machines; wake-from-sleep and unattended availability after a machine reboot were not validated.

### Earlier local macOS validation (2026-09-19)

The isolated local macOS smoke used the same DSH **0.1.6-alpha.2**, corresponding to official source commit `ddefc45fbc7f8e46dd73185e68295696d1297887`:

- Created and executed `hello.py` with DSH's native write and bash tools.
- Exercised Pocket's `MachineRuntime` create, model/effort selection, Ask mode, streaming, tool activity and history.
- Image input correctly read `POCKET 42` and red/blue rectangles; DSH used its native image-reading tool.
- Native `web_search` returned real official Python documentation results. Native `web_fetch` ran against two public-domain URLs but failed because local DNS resolved them to non-public addresses. It subsequently retrieved `https://1.1.1.1/cdn-cgi/trace` successfully; domain-based fetch remains constrained by this local DNS setup.
- Resume after process shutdown read persisted history. Reattachment during a running shell command kept the same process/session/active turn, and Stop yielded `interrupted` / `stopped`.
- An actual sandbox-denied write produced an approval request, retained it through reattachment, and completed only after approval while remaining in Ask mode. The native question tool also completed a structured option selection through Pocket and cleared the pending request.
- Pocket queue delivery ran a separate follow-up turn successfully; rename and archive/unarchive were verified. A staged text-file attachment was read correctly, and a later resume restored title and context usage.
- A shell presence-only check confirmed DeepSeek/OpenAI keys were absent from tool environments. Balance returned sanitized metadata.

The delete/relocation/pagination/image/transport fixes were later validated against isolated DSH **0.1.6-alpha.2** processes with a local fake Messages endpoint and a fully separate DSH home: two turns were created, turn and item history paginated with cursors, a persisted user image was read back through `pocket/attachment`, the task was relocated to a new folder with its title, conversation, access and effort preserved (and the next model request confirmed the preserved effort), deleted for real, and the deletion stayed gone after a fresh DSH process. A forced relocation failure during settings application rolled the replacement back and left the original task usable, a synthetic SSH alias exposing OpenAI and DeepSeek kept both runtimes, and a broken DSH stdin pipe disconnected the adapter without terminating the process. These checks were run directly against the isolated DSH processes and require the separately locked runtime installed with `npm ci --prefix dsh`.

### Regression validation (2026-09-20)

The migration was validated by direct execution against the pinned runtime, covering critical permission mapping, legacy ID rejection, per-runtime receipt separation, late responses across reattachment, catalog grouping with two providers per SSH alias, image routing, relocation adoption, transport closure, cancellation/tool result projection, and POSIX/Windows launcher-path quoting.

### Durable-runtime validation (2026-09-20)

A real isolated DSH runtime was exercised directly: a running turn survived a killed gateway carrier process and reattached with no duplicate input, explicit Stop interrupted the intended turn, a racing runtime could not steal the home, an unanswered structured question stayed pending across the disconnect and replayed with its original request identity, and a status check and idle-only stop left the attached gateway and its pending question untouched. The generated POSIX staging, activation and rollback shell was exercised against disposable installations: a good update replaced the files and retained `.pocket-previous`, a post-activation failure restored them, a busy runtime refused without mutating anything, and a rollback did not delete the copy it restored from. The request correlation path was also exercised directly: a delayed reply to a superseded connection could not satisfy a new connection that reused the id, a superseded connection could not submit work, pending questions transferred with their identity, and a draining runtime rejected new work. Windows named-pipe attach, activation and rollback are implemented but were not exercised on an isolated Windows host.

Earlier syntax checks and the separately locked DSH installation dry run also passed. The earlier local read-only OpenAI probe initialized and listed tasks using app-server **0.154.0**. At that time, the local standalone CLI was **0.154.0** and the app-bundled CLI **0.155.0-alpha.2.6**; neither was changed by that validation.

### Deployment, cutover and rollback

The execution-side adapter and the gateway are deployed together with one command, `node scripts/deploy.mjs` (`npm run deploy` where npm is available), run from the repository checkout on the gateway host. It reuses the existing machine settings, SSH aliases and `dshPath` values.

The command is ordered so a partial rollout cannot create a mismatched pair:

1. Every machine is inspected read-only (reachability, installed manifest, live idle state through the control endpoint). Nothing is modified.
2. If any protocol change is involved, the run stops before building or activating unless `--allow-protocol-change` is given and every targeted machine can be updated.
3. The gateway image is built and the **built image** is checked for the adapter protocol, so a build from stale or edited sources cannot be activated.
4. Each changed machine is staged in `.pocket-staging-<bundle>` beside its install, extracted from an archive that travels on stdin, installed with `npm ci` only when `dsh/package-lock.json` changed, and otherwise given a temporary link to the live locked `node_modules` so the real dependency/import probe runs without mutating the running install. Every staged tree is verified by SHA-256 (`--verify`) and the load probe (`--probe`) before activation, and the link is removed afterwards.
5. Activation is idle-only and verified. It writes a `.pocket-deploying` maintenance marker (so an attach client refuses to launch from a half-swapped install), asks the durable runtime to stop through the control endpoint, snapshots the current files to `.pocket-previous`, replaces them, then verifies hashes and the load probe again. Any failure after mutation begins — a copy, permission, dependency move or verification failure — restores the previous file set and dependencies. A restore that cannot itself be verified rewrites the marker as a non-expiring `stuck` marker so an attach client will not launch a partial install, and the retained backup is never overwritten with an unloadable install. A backup that predates `.pocket-adapter.json`, `runtime.mjs` or `--probe` is restored as a legacy generation (new-generation files are removed rather than mixed in) and verified with checks it actually supports. Files are chmod-ed individually; no wildcard chmod and no failure-masking `|| true` remain. An idle state is never inferred: only an explicit idle answer, or complete ownership proof of no live owner and no DSH child, permits the swap; a timeout, a malformed answer, a busy runtime, incomplete child enumeration or an install with no control endpoint is treated as not-idle and left pending, and `--confirm-idle` never bypasses a modern runtime whose state cannot be verified. The safe state is established again immediately before replacement, under the marker: inspection is not carried through staging, so a runtime that starts while staging is either stopped through the verified idle-only path or the run defers. Rollback re-verifies the same way for the installed generation, and it preserves existing protection: a pre-existing held or stuck marker is never overwritten or removed by a refused rollback, a stuck marker is never downgraded to a temporary one, and a restoration that changes files without establishing a usable installation leaves the installation protected (marked `stuck`). The first cutover additionally verifies the legacy carrier's identity through the staged `--owner` probe, stops the launcher and every identified DSH child, confirms they exited, and claims the lock so the old gateway cannot relaunch it mid-cutover; an owner that cannot be verified or stopped leaves the installation unchanged.
6. All checks that could defer the run — the built image's protocol, the gateway's restart safety, and the whole-fleet protocol arrangement — happen before any live installation changes. The gateway is then activated and must actually become ready (the running container is the built image and `/healthz` plus `/api/state` answer); a final fleet-check failure, a start failure or a readiness failure restores the retained gateway image and any adapters already switched, and an unverifiable restore leaves the installations protected. A marker is classified held or stuck only after a successful existence check followed by a successful, shape-valid content read; a failed read, malformed JSON, null or an unexpected shape stays `unknown`, which prevents replacement, rollback and release for that installation and is reported as pending (the full command and `--confirm-idle` cannot bypass it). Marker release is verified explicitly: the check's exit status and response are validated, `exists`/`absent`/`could not determine` are distinguished, and only a successful explicit absence check completes the release — a failed check, permission error, connection failure, timeout, malformed response or unexpected output is reported as pending/unresolved, never as success. A wrapper pattern is held only for a coordinated cutover (a protocol transition or the legacy cutover), so finishing one needs the normal full command: the full rerun recognizes a held marker even when the adapter files already match, verifies the intended installation and compatible gateway readiness, then releases the appropriate markers. `--adapters-only` and `--gateway-only` stop before mutation when such an inherited marker is present and never release it themselves; stuck markers are never removed without a successful repair. Ordinary compatible adapter-only updates (no coordinated cutover pending) remain supported and clean up their own markers. `restoreGatewayImage` verifies the restored container is the retained immutable image and that Pocket's health/state endpoints answer before any recovery is called complete, and adapter protection markers are held until the combined gateway/adapter arrangement is verified. The gateway is restarted only after every machine it attaches to re-reads as the protocol the built image actually serves — a running runtime's control/handshake response when it answers, otherwise the installed manifest only after its bytes verify. `--machine` limits adapter work but never narrows this fleet check, a partial protocol upgrade is refused before mutation, and if a later protocol target fails or becomes busy, the machines already switched are rolled back instead of stranded. A compatible gateway/UI-only redeploy does not stop execution runtimes and does not wait for accepted durable DSH turns to finish, though it still waits for a non-durable local task. SSH Codex turns run in an independent managed app-server and also survive the gateway proxy restart. Offline machines remain pending without blocking the online cutover; an incompatible DSH adapter is rejected by the gateway handshake when it returns and needs the same deployment command rerun. The previous gateway image is retained by its immutable image id rather than a mutable tag, so a deferred or failed run followed by a retry keeps the last successfully deployed image.

Busy, offline or unverifiable machines are reported as pending, and rerunning the same command finishes them. A gateway/UI-only change leaves the machines untouched, but `--gateway-only` refuses unless every configured machine already declares the gateway's adapter protocol. **No native-app rebuild is needed.** Existing task data needs no migration.

Flags: `--dry-run`, `--gateway-only`, `--adapters-only`, `--machine <name-or-ssh>`, `--settings <path>`, `--confirm-idle`, `--allow-protocol-change`, `--rollback`. `--gateway-only` inspects adapter compatibility but never stages, stops, updates or rolls back an execution adapter, and `--dry-run` performs no mutation in any mode, including `--rollback`. The gateway restart decision uses the `/api/state` `machineId` contract and verified runtime lifecycle facts: a connected `deepseek` runtime (which passed the durable adapter handshake) may keep an accepted turn across a compatible restart, while a provider label alone is insufficient. Connected SSH Codex runtimes use an independent managed app-server and do not block a gateway proxy restart.

**First cutover.** The old lifecycle was a gateway-owned stdio child that died with the gateway, so its in-flight turn is still interrupted by a gateway restart, and its install reports no control endpoint. Because that idle state cannot be proven, the first adapter update requires `--confirm-idle`: stop every DSH turn (and gateway task), then run

```bash
node scripts/deploy.mjs --confirm-idle
```

The adapters are replaced and the gateway restarts once. Every runtime started afterwards is durable, and later gateway restarts no longer stop accepted DSH work.

**Protocol upgrade.** When `dsh/projection.mjs` bumps `DSH_ADAPTER_PROTOCOL`, pass `--allow-protocol-change` with a drained fleet. All targeted machines must update before the gateway moves; a machine that cannot be updated keeps the gateway on the old image. Gateway-only updates are refused while any machine's declared protocol differs.

**Rollback.** Each update retains the replaced adapter files (and, when dependencies changed, the previous `node_modules`) under `<bundleRoot>/.pocket-previous`. After draining the machine, run

```bash
node scripts/deploy.mjs --rollback            # add --confirm-idle for an install with no control endpoint
```

which restores the retained files in place and re-runs the load probe. The gateway keeps the previous image as `codex-pocket-gateway:previous`; retag it to the image the compose service uses and run `docker compose up -d --no-build pocket` to return to it. Rollback is only claimed when a previous install was actually retained; a rollback with no `.pocket-previous` changes nothing and reports `no-previous`.

Official interfaces inspected: [SDK protocol](https://github.com/deepseek-ai/deepseek-harness/tree/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/sdk/protocol), [Host session controller](https://github.com/deepseek-ai/deepseek-harness/tree/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/api/session-controller), [full SDK profile](https://github.com/deepseek-ai/deepseek-harness/tree/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/bundle/sdk-app), and [native search](https://github.com/deepseek-ai/deepseek-harness/tree/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/web/web-search-deepseek).
