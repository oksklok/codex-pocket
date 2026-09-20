# Contributing

Install the locked dependencies with Node.js 22.6 or newer and npm:

```sh
npm ci
```

A read-only smoke check is `npm run probe -- --list-only --monitor-seconds 0`; it initializes and lists tasks without attaching to one. Record the app-server version from initialization as well as `codex --version`. Update compatibility claims only for the checks actually performed. Keep `SPIKE_REPORT.md` historical.

Do not add automated tests or test harnesses. Validate changed behavior directly: run the gateway or CLI, exercise the affected flow (including `scripts/deploy.mjs` in a disposable environment when deployment changes), and record exactly what you ran and observed. The read-only smoke check above is an example of that direct validation. Preserve operational safeguards such as health checks, ownership checks and rollback verification.

Only rebuild the native app with `zsh macos/build-app.sh` when its source changes.

### Behaviors to preserve

- New Task sends explicit starting settings and remembers successful choices per runtime/browser. Folder prefill uses the selected task on that runtime; a blank folder resolves to that runtime user's home.
- Wide task navigation/creation focuses the composer; narrow layouts do not. Escape closes narrow sidebar overlays, while wide pinned sidebars remain open.
- Text, image, and file drafts are task-scoped, in memory, limited to eight non-empty drafts, and lost on reload. Staged files live in the target machine's temp directory; Pocket has no automatic deletion or expiry policy.
- Tasks Unavailable is a catalog failure on a connected transport. Offline is a transport failure. Keep the 15-second SSH probes/three-miss limit separate from the five-second catalog budget.
- Unknown message delivery uses receipts and recovery; never retry a message POST automatically.
- Preserve labels, keyboard focus, input selection/IME composition, and responsive control sizes when changing rendering or icons.

Bug reports should include the host/client operating systems, Codex version (`codex --version`), Node version (`node --version`), and clear reproduction steps.

Do not include credentials, Pocket PINs, private prompts, or sensitive logs in issues, pull requests, or commits. Remove private details from any examples you share.
