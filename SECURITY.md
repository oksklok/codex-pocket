# Security

Codex Pocket can control powerful Codex actions. Treat it as a privileged local/private-network tool. Its four-digit PIN is not internet-grade authentication. Never expose Pocket directly to the public internet; use a trusted LAN or a private encrypted VPN such as WireGuard or Tailscale.

HTTPS or a reverse proxy does not make Pocket's four-digit PIN internet-grade authentication. Do not expose Pocket publicly just because it has HTTPS.

Security fixes target current `main`. There is no maintained historical release matrix yet.

## Reporting a vulnerability

This repository does not currently have GitHub private vulnerability reporting enabled. Use a [GitHub issue](https://github.com/oksklok/codex-pocket/issues/new) only for a non-sensitive summary or to ask the maintainer to arrange a private reporting method. Do not post exploit details that would put users at risk while arranging that method.

Never publish PINs, SSH keys or other SSH material, private prompts, logs, or other sensitive runtime data in reports.
