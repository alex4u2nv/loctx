# Contributing

## Setup

This repo uses [pnpm](https://pnpm.io/) (>= 9). If you have Node 22+, `corepack enable && corepack prepare pnpm@9.15.9 --activate` is the cleanest install.

```bash
git clone git@github.com:alex4u2nv/loctx.git
cd loctx
pnpm install
pnpm run build
pnpm --filter @loctx/cli link --global
pnpm --filter @loctx/mcp link --global
```

`loctx` and `loctx-mcp` are now on `$PATH`. Re-run `pnpm run build` after source changes (or use `pnpm --filter @loctx/cli dev` for the watch loop).

## Verify

```bash
pnpm run verify   # lint, typecheck, tests
```

CI runs the same command **plus the Playwright e2e suite**. The pre-push
git hook also runs both — so a push only goes through after the full CI
gate succeeds locally. The pre-commit hook (also lefthook) auto-formats
staged files with biome and runs an advisory Claude staged-diff review;
skip the review for a single commit with `CLAUDE_PRECOMMIT_SKIP=1 git
commit …`. To pre-stage the Playwright browser one time:

```bash
pnpm --filter @loctx/web exec playwright install chromium
```

PRs cannot merge until CI passes.

A `LOCTX_E2E_NETWORK=1` suite in `apps/cli/tests/integration/scenarios.test.ts` downloads a real model and runs end to end. CI skips it.

## Conventions

- TypeScript strict, ESM imports with `.js` extensions, Biome for lint and format.
- Comments document the *why*, not the *what*. If a comment narrates identifiers, delete it.
- One concern per PR. Squash-merge keeps `main` linear.
- Branch names: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`, `test/<topic>`.
- Commit subjects: imperative, under 70 characters, prefixed with conventional scope. Example: `fix(core): pin chokidar to 3.x`.

## Issues

Bugs need OS, Node version, `loctx doctor` output, and reproduction steps. Avoid pasting indexed file content; see [docs/PRIVACY.md](docs/PRIVACY.md) for what stays safe to share.

Security reports go through [SECURITY.md](SECURITY.md), not public issues.

## Releasing

```bash
node scripts/release-bump.mjs <patch|minor|major|X.Y.Z>
# review the diff, move CHANGELOG [Unreleased] under [X.Y.Z]
git commit -am "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z
```

The `release.yml` workflow runs verify, then publishes `@loctx/core`, `@loctx/cli`, and `@loctx/mcp` in dependency order. `@loctx/web` stays private.
