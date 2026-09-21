# Codex Pocket

Codex Pocket is a lightweight, self-hosted browser/PWA client for controlling official Codex app-server runtimes locally and over SSH. Run its Node.js gateway from the macOS menu bar or headlessly, then manage tasks from a desktop or phone.

Codex Pocket is an unofficial community project and is not affiliated with or endorsed by OpenAI.

## Screenshots

Real Pocket UI with synthetic demo data only.

| Monitor and control from your phone | Switch tasks across machines |
| --- | --- |
| <img src="docs/screenshots/mobile-working.png" alt="Pocket on mobile showing an active task, activity progress, and Stop and Steer Now controls" width="220"> | <img src="docs/screenshots/desktop-tasks.png" alt="Pocket on desktop with three demo machines in the Tasks sidebar and a coding conversation" width="620"> |

<details>
<summary>macOS menu-bar host</summary>

<img src="docs/screenshots/macos-menu.png" alt="Native Pocket menu with synthetic quota values and Keep Mac Awake enabled" width="260">

</details>

## What it does

- Browse, create, rename, archive, delete, and resume tasks across local and SSH runtimes.
- Follow live messages, reasoning summaries, plans, command/tool activity, file changes, images, and turn status.
- Respond to supported approvals and structured questions.
- Choose the model, reasoning effort, and access mode exposed by the selected runtime.
- Send, stop, steer, or queue one follow-up message. Ambiguous delivery is never retried automatically.
- Attach images and files. Files are staged in the selected machine's OS temp directory and remain there until OS cleanup or manual removal.
- Show account quota, or DeepSeek account Balance, plus authoritative context-window usage when the runtime supplies it.
- Run as a responsive browser UI or installable PWA.

Image input supports PNG, JPEG, GIF, and WebP, up to four images (4 MB each, 8 MB total). Other files are limited to four files (10 MB each, 20 MB total). Browser drafts are task-scoped, kept in memory, and do not survive a reload.

## Requirements

- Node.js **22.6 or newer**, with npm.
- An authenticated Codex CLI on each OpenAI runtime machine, with `codex app-server proxy` and the shared/managed app-server available.
- macOS for the optional menu-bar host. The checked-in app executable is Apple Silicon; rebuilding requires Apple's command-line developer tools.
- Working non-interactive SSH for remote machines.

Codex Desktop itself is not required. A Desktop-owned stdio session is not automatically attachable through the shared app-server.

## Security boundary

Pocket can control powerful runtime actions. Its four-digit PIN is a convenience gate for trusted LAN/private-network use, **not internet-grade authentication**.

**Do not port-forward Pocket directly to the public internet.** Use a trusted LAN or private encrypted network such as WireGuard or Tailscale. See [SECURITY.md](SECURITY.md).

## macOS quick start

1. Clone the repository and install dependencies:

   ```sh
   git clone https://github.com/oksklok/codex-pocket.git
   cd codex-pocket
   npm ci
   ```

2. Authenticate Codex and start its shared runtime if needed:

   ```sh
   codex login
   codex app-server daemon start
   ```

3. Double-click **Codex Pocket.app**, then choose **Open Pocket** from the menu-bar icon. Keep the app bundle inside the repository so it can find the gateway and dependencies.

4. Use the **Tasks** sidebar to select or create a task.

`npm start` runs the gateway directly without the menu-bar host.

### Phone access

For LAN/private-VPN access, configure `lanEnabled`, `host`, `port`, and a four-digit `pin` in `.codex-pocket.local.json`, then restart Pocket. Pocket defaults to `127.0.0.1:4173`.

A true standalone PWA install requires a trusted HTTPS origin. A private reverse proxy such as Caddy can provide HTTPS; keep it reachable only over the same trusted LAN or private VPN. HTTPS does not change Pocket's authentication boundary.

The optional `accessUrls` setting can list the HTTP(S) origins a phone should use. Machine-local certificates, keys, reverse-proxy configuration, and SSH material belong outside the repository.

## SSH machines

On each remote machine, authenticate Codex and make sure its shared app-server is available. From the Pocket host, verify the SSH alias works without prompting:

```sh
ssh -o BatchMode=yes devbox codex --version
```

Then open **Tasks → Add Machine**, enter a display name and SSH alias, save, and restart Pocket. Pocket uses the host's existing SSH config, keys, and agent; it does not store SSH credentials.

An optional Wake-on-LAN MAC address adds a **Wake** action for an offline SSH machine. Sending the packet only confirms that the packet was sent.

Server-backed settings live in the Git-ignored `.codex-pocket.local.json`; browser appearance and input/display preferences stay in browser local storage.

## Architecture and limits

```text
Local / SSH Codex app-server runtimes
                ↓ supported protocol
         Node.js Pocket gateway
                ↓ filtered SSE + paginated history
         Desktop / mobile browser
```

Pocket uses supported app-server protocol surfaces. It does not scrape Codex databases, rollout/session files, terminal output, or Desktop UI.

Only the selected runtime keeps a task attachment. Cross-machine switching attaches the destination before releasing the previous task, so a failed destination attach leaves the current task intact.

History is paginated and activity details load on demand. Pocket does not request full history merely to estimate context usage; if the runtime does not provide authoritative usage, Context remains unknown.

Image transport is limited to validated input and image paths surfaced by trusted runtime items. It is not a general file browser.

Message delivery uses bounded in-memory receipts. A timeout or lost response can be reconciled, but Pocket never automatically repeats a prompt whose delivery is uncertain.

## DeepSeek Harness

The optional [DeepSeek Harness backend](docs/deepseek.md) runs alongside the OpenAI/Codex backend. DeepSeek state and credentials stay on the execution machine; an SSH gateway does not need the provider key.

The DeepSeek guide covers installation, lifecycle, limitations, and the coordinated deployment/rollback path.

## Development

```sh
npm ci
npm start
```

Useful commands:

```sh
npm run probe -- --list-only --monitor-seconds 0
npm run probe-remote -- devbox --list-only --monitor-seconds 0
zsh macos/build-app.sh
```

Validate changed behavior directly rather than maintaining a permanent regression suite. Temporary probes, mock fixtures, and headless-browser fixtures are fine while solving a concrete issue; delete them afterward. Deployment changes should be exercised with `node scripts/deploy.mjs` in a disposable environment.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contributor conventions and [SECURITY.md](SECURITY.md) for security guidance.

## Docker / headless hosts

Docker runs Pocket as an SSH-runtime-only gateway; it does not run Codex locally in the container.

Create two private directories beside `compose.yaml`:

- `data/.codex-pocket.local.json` with `lanEnabled: true`, `host: "0.0.0.0"`, `port: 4173`, a four-digit `pin`, and at least one SSH machine.
- `ssh/` with the outbound SSH key, config, and verified `known_hosts`.

The supplied container runs as UID 1000. The mounted data and SSH files must be accessible to that user; keep private keys at restrictive permissions. The SSH directory is mounted read-only.

Start or rebuild the gateway with:

```sh
docker compose up -d --build
```

For a machine that also exposes DeepSeek, configure its `dshPath` and follow [docs/deepseek.md](docs/deepseek.md).

Deploy gateway/adapter updates from the checkout on the gateway host:

```sh
node scripts/deploy.mjs
```

The deploy command stages and verifies execution-side adapter changes, updates only idle runtimes, and preserves rollback material. See the DeepSeek guide for protocol changes and rollback.

`CODEX_POCKET_DATA_DIR` separates writable settings/runtime state from application files. `CODEX_POCKET_HEADLESS=1` removes the local runtime and requires at least one SSH machine. Stop a Compose host with `docker compose down`; the web Quit action is disabled in headless mode.
