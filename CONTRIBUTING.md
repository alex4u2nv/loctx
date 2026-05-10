# Contributing

## Setup

```bash
git clone git@github.com:alex4u2nv/loctx.git
cd loctx
npm install
npm run build
npm link --workspace @loctx/cli --workspace @loctx/mcp
```

`loctx` and `loctx-mcp` are now on `$PATH`. Re-run `npm run build` after source changes.

## Verify

```bash
npm run verify   # lint, typecheck, tests
```

CI runs the same command. PRs cannot merge until it passes.

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
