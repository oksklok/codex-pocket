# Contributing

Install dependencies with Node.js 22.6 or newer and npm:

```sh
npm install
```

Run the existing tests before submitting a change:

```sh
npm test
```

The optional desktop/mobile browser regression is `tests/task-local.browser.mjs`. It requires Playwright to already be available; it is not part of `npm test`:

```sh
node --experimental-strip-types tests/task-local.browser.mjs
```

If Playwright is installed elsewhere, set `POCKET_PLAYWRIGHT_MODULE` to its module path. For changes to the native macOS host, also run `zsh macos/build-app.sh`.

Bug reports should include the host/client operating systems, Codex version (`codex --version`), Node version (`node --version`), and clear reproduction steps.

Do not include credentials, Pocket PINs, private prompts, or sensitive logs in issues, pull requests, or commits. Remove private details from any examples you share.
