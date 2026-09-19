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

A private exclusive `pocket-owner` file prevents a second launcher from sharing the DSH home. Normal EOF or shutdown disposes DSH and removes ownership. An unclean kill can leave a stale lock: inspect its PID and the owned process before removing it; never kill unrelated runtimes or delete session files as recovery.

One normal DSH process serves each configured DeepSeek runtime. Browser reconnect and in-process adapter reattachment reuse it, read durable history and restore pending approval requests. Reattachment never resends a prompt. A lost SSH transport can end the execution-side process and interrupt a turn; reconnect can resume its persisted session after cleanup. It does not promise uninterrupted execution across SSH loss or gateway restart. Pocket receipts remain process-local; uncertain delivery stays uncertain instead of triggering an automatic retry. The optional `POCKET_DSH_HOME` execution environment variable is available for isolated smoke testing.

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

The delete/relocation/pagination/image/transport fixes were later validated against isolated DSH **0.1.6-alpha.2** processes with a local fake Messages endpoint and a fully separate DSH home: two turns were created, turn and item history paginated with cursors, a persisted user image was read back through `pocket/attachment`, the task was relocated to a new folder with its title, conversation, access and effort preserved (and the next model request confirmed the preserved effort), deleted for real, and the deletion stayed gone after a fresh DSH process. A forced relocation failure during settings application rolled the replacement back and left the original task usable, a synthetic SSH alias exposing OpenAI and DeepSeek kept both runtimes, and a broken DSH stdin pipe disconnected the adapter without terminating the process. These checks are `tests/dsh-integration.test.mjs`; they skip when `npm ci --prefix dsh` has not installed the separately locked runtime.

### Automated regression checks (2026-09-20)

The migration's `npm test` run passed **28** fast checks plus the **2** isolated DSH bridge checks (**30** total, none skipped). The fast suite covers critical permission mapping, legacy ID rejection, per-runtime receipt separation, late responses across reattachment, catalog grouping with two providers per SSH alias, image routing, relocation adoption, transport closure, cancellation/tool result projection, and POSIX/Windows launcher-path quoting and validation alongside the existing checks.

Earlier syntax checks and the separately locked DSH installation dry run also passed. The earlier local read-only OpenAI probe initialized and listed tasks using app-server **0.154.0**. At that time, the local standalone CLI was **0.154.0** and the app-bundled CLI **0.155.0-alpha.2.6**; neither was changed by that validation.

After installing DSH on the execution machine and applying configuration, restart Pocket to load the backend change. **No native-app rebuild is needed.** The delete, relocation, pagination and image-routing changes live in `dsh/bridge.mjs`, which DSH loads when it launches: an already-running gateway with a live DSH child keeps the previous adapter until that runtime is relaunched. Existing task data needs no migration.

Official interfaces inspected: [SDK protocol](https://github.com/deepseek-ai/deepseek-harness/tree/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/sdk/protocol), [Host session controller](https://github.com/deepseek-ai/deepseek-harness/tree/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/api/session-controller), [full SDK profile](https://github.com/deepseek-ai/deepseek-harness/tree/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/bundle/sdk-app), and [native search](https://github.com/deepseek-ai/deepseek-harness/tree/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/web/web-search-deepseek).
