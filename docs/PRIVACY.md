# Privacy

loctx is local-first.

- No telemetry.
- One network surface: the embedding model download from Hugging Face on first use, gated by `loctx model download <name>`. Persisted afterward; the daemon never re-prompts.
- Indexed data lives on your machine. Nothing uploads.
- Secret-shaped files (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*credentials*`, etc.) are excluded by default. Negation rules in `.loctxignore` cannot re-include them.
- Admin UI and MCP HTTP bind to `localhost`. No auth. Don't bind to `0.0.0.0` without your own auth layer.

## What loctx reads

Files under `workspace_roots`, filtered by built-in rules plus `.gitignore` and `.loctxignore`. Defaults skip `.git/`, `node_modules/`, `.venv/`, `__pycache__/`, `dist/`, `build/`, `.next/`, files larger than `max_file_size_bytes` (1 MB default), files that fail UTF-8 decode, and the secret-glob baseline.

Run `loctx config show` for the effective rules.

### AI-tooling directories (`.claude/`, `.cursor/`, `.aider/`)

These hold project intent — rules, slash commands, prompts — that loctx is built to surface. Many developers list these dirs in `~/.gitignore_global` to keep AI tooling state out of git commits; loctx re-includes them at the indexer layer so that VCS posture doesn't silently hide project rules from search.

To exclude one of these dirs from indexing for a specific project, add it to that project's `.loctxignore`:

```
# .loctxignore
.claude/
```

`.loctxignore` evaluates after the built-in re-include, so the project's intent wins.

## Where loctx stores it

Resolved via [`env-paths`](https://github.com/sindresorhus/env-paths). Override with `LOCTX_DATA_DIR` and `LOCTX_CONFIG_DIR`. `loctx status` prints the resolved paths.

## What goes over the network

`loctx model download <model>` (or accepting the wizard's first-run prompt) fetches model weights from Hugging Face. The download is gated by an outbound allowlist inside `@loctx/core`. The result writes to `<dataDir>/trusted-models.json`. Subsequent boots skip the network entirely.

Verify by watching `lsof -i -p $(pgrep -f loctx)`.

## What's safe to share

- `loctx doctor`: paths scrubbed when a project root is in scope. Safe.
- `loctx status`: includes data dir paths and project roots. Redact if directory names matter.
- `loctx search`: includes file content snippets. Review before sharing.
- Watcher logs (`<dataDir>/logs/`): relative paths, no content. Generally safe.

## Uninstall

```bash
loctx stop
loctx reset index --force
rm -rf "$(loctx config show | awk '/dataDir/{print $3}')"
rm -rf "$(loctx config show | awk '/configDir/{print $3}')"
pnpm --filter @loctx/cli unlink --global                   # local-link installs
pnpm --filter @loctx/mcp unlink --global
# or
npm uninstall -g @loctx/cli @loctx/mcp                     # global npm installs
# or
pnpm rm -g @loctx/cli @loctx/mcp                           # global pnpm installs
```

The Hugging Face cache (`~/.cache/huggingface/`) is shared with other tools. Delete only if no other tool depends on it.

## Reporting a privacy concern

If loctx transmits data outside the documented surface, file it as a security issue per [SECURITY.md](../SECURITY.md).
