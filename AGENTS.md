# Codex Pocket agent instructions

- Read `CONTRIBUTING.md`, `docs/ui-style-guide.md`, and `docs/deepseek.md` before relevant work.
- Prefer the smallest practical change. Avoid unrelated refactors, cleanup, branches, or worktrees unless requested.
- Start from current `main` and preserve unrelated work.
- Commit and push when requested. Deploy only when explicitly requested.
- Preserve ambiguous-delivery safety: never automatically resend a prompt whose delivery may have succeeded.
- Keep viewport/layout behavior separate from input-capability/touch behavior.
- Machine Details is runtime inspection-only; runtime installation/update belongs to the established deployment tooling.
- For deployment, use the maintainer's local deployment procedure rather than inventing a new one.
