# Contributing

Install the locked dependencies with Node.js 22.6 or newer:

```sh
npm ci
```

A read-only smoke check is:

```sh
npm run probe -- --list-only --monitor-seconds 0
```

Record the app-server and Codex CLI versions when compatibility matters.

## Working rules

- Prefer the smallest practical change. Avoid speculative refactors and cleanup for cleanup's sake.
- Validate the behavior you changed directly. Temporary probes, mock fixtures, and headless-browser fixtures are fine; delete them afterward.
- Do not add a maintained regression suite unless that project decision is explicitly changed.
- Exercise deployment changes with `node scripts/deploy.mjs` in a disposable environment and preserve its ownership, integrity, readiness, and rollback safeguards.
- Rebuild the native app with `zsh macos/build-app.sh` only when its source changes.
- Preserve ambiguous-delivery semantics: never automatically resend a prompt whose delivery may have succeeded.
- Preserve touch-friendly focus behavior: input capability decides composer autofocus; viewport width only decides docked-vs-drawer layout.
- Keep accessibility labels, keyboard behavior, input selection/IME handling, and responsive control sizing intact.

## Documentation

Current-facing docs should describe stable user contracts, setup, and operational invariants. Avoid copying implementation details into several files or keeping completed audit/checklist documents in the repository; Git history already preserves that context.

Use `README.md` for product/setup information, `docs/ui-style-guide.md` for UI conventions, and `docs/deepseek.md` for the DSH backend and deployment lifecycle.

## Security

Do not include credentials, Pocket PINs, SSH keys, private prompts, sensitive logs, or machine-local configuration in issues, pull requests, or commits. See [SECURITY.md](SECURITY.md).
