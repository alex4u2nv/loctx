# MCP setup

loctx exposes six MCP tools (`search_workspace`, `workspace_status`,
`find_usages`, `find_duplicates`, `find_literal`, `refresh_workspace`)
over two transports. Pick the one that fits your agent and workflow.

## Tool selection cheat-sheet

The agent picks the wrong tool when the question's shape doesn't match
the tool's job. Use this table to translate user intent into the right
call.

| Intent | Right tool | Why |
|---|---|---|
| "Where is `authenticate` defined / called / imported?" (exact code symbol) | `find_usages` | Exact-match, returns every def + ref. No fuzz, no ranking. |
| "What's the code that does JWT signing?" / "Where do we debounce websocket reconnects?" (semantic) | `search_workspace` | Vector + lexical fusion; top-N ranked. |
| "Find code about X for a refactor — also include callers" | `search_workspace` with `coverage: true` | Expands top hits via the symbol cross-ref graph. |
| "List every file containing the literal string `agents/foo.md`" (audit, exhaustive) | `find_literal` | Substring scan over indexed chunk text. One row per matching line, with `column` + `lineText`. Coverage caveat: chunker gaps (#360) are blind spots — the response always includes a `coverageNote`. Supplement with `rg` when the audit is safety-critical. |
| "Are there duplicate code blocks across the workspace?" | `find_duplicates` | Hash-based, cross-file. Requires `analyzers.background_enabled` + `analyzers.duplicates.enabled` in config. |
| "Is the index up to date? Walk it now." | `refresh_workspace` | Triggers a reconcile. Slow on a cold workspace. |
| "What projects are indexed and where is the data?" | `workspace_status` | Cheap. Includes `indexHealth` so you know if a reconcile is in flight. |

## Transports

| Transport | When to use | Binary | Endpoint |
|---|---|---|---|
| **stdio** | Agent spawns the server as a child process. Default for Claude Code, Codex, Goose. | `loctx-mcp` | n/a (stdin/stdout) |
| **HTTP** | Long-running shared daemon serving multiple agents and the admin UI. Default for Cursor's HTTP MCP support. | `loctx start` | `http://<host>:<port>/mcp` (default `localhost:3022`) |

The two are mutually exclusive per agent connection but coexist on one
machine — you can run `loctx start` for the admin UI + HTTP MCP and
also have agents launch `loctx-mcp` directly when they prefer stdio.

## Stdio: `loctx-mcp`

`loctx-mcp` is a single binary that speaks MCP on stdin/stdout. The
agent spawns it; loctx dies when the agent's connection closes. No
shared state, no port allocation, one process per agent.

### Claude Code

Edit `~/.config/claude-code/mcp.json` (or your platform equivalent):

```json
{
  "mcpServers": {
    "loctx": {
      "command": "npx",
      "args": ["loctx-mcp"]
    }
  }
}
```

If you've installed via `pnpm --filter @loctx/mcp link --global` (or `npm link`) from a local clone, the binary is on
`$PATH` and you can drop the `npx`:

```json
{
  "mcpServers": {
    "loctx": {
      "command": "loctx-mcp"
    }
  }
}
```

Restart Claude Code. The three tools should appear under the loctx
namespace.

### Codex

The Codex MCP config format mirrors Claude Code's. The same snippet
above works dropped into Codex's config file. If your Codex version
predates MCP support, fall back to the HTTP transport via `loctx start`.

### Goose

Goose's MCP support uses the standard `mcp_servers` config block. Same
shape as the snippets above; refer to your Goose version's docs for the
exact file path.

### Other clients

Any client that follows the MCP stdio convention (`command` + `args`)
will work with `loctx-mcp`. The protocol version is `2024-11-05`.

## HTTP: `loctx start`

`loctx start` runs the integrated daemon: a filesystem watcher, the
Next.js admin UI, and the MCP HTTP transport on one port. The HTTP MCP
endpoint is `/mcp` on whatever port + hostname `daemon.port` /
`daemon.hostname` are set to in your config (defaults to
`localhost:3022`).

Boot it:

```bash
loctx start
```

Wire your agent to the URL:

```json
{
  "mcpServers": {
    "loctx": {
      "url": "http://localhost:3022/mcp"
    }
  }
}
```

Use HTTP transport when you want one shared loctx process to back
multiple agents and the admin UI simultaneously, or when your agent
client doesn't support stdio. Stdio is preferred otherwise — fewer
moving parts.

## Verification

Once connected, walk through this sequence to confirm everything is
wired correctly. Both transports support the same tool surface.

### 1. Initialize

The MCP `initialize` handshake should return `serverInfo.name = "loctx"`
and `protocolVersion = "2024-11-05"`. Most clients do this automatically.

### 2. List tools

You should see exactly six:

```
search_workspace
workspace_status
find_usages
find_duplicates
find_literal
refresh_workspace
```

### 3. Workspace status

Call `workspace_status` with empty arguments. The result lists every
indexed project (active and orphaned), the configured `workspace_roots`,
and the storage paths.

```json
{
  "configPath": "/Users/you/.config/loctx/config.yaml",
  "paths": { "dataDir": "...", "vectorDir": "..." },
  "embedding": { "provider": "huggingface-transformers", "model": "..." },
  "workspaceRoots": ["/Users/you/Workspaces"],
  "projects": [
    { "id": "abc123", "name": "alpha", "root": "/Users/you/Workspaces/alpha", "status": "active", "lastIndexedAt": "2026-05-09T..." }
  ]
}
```

If `projects` is empty, your `workspace_roots` aren't pointed at any
directory containing `.git` markers. See "Troubleshooting" below.

### 4. Refresh workspace

If you've never indexed, call `refresh_workspace` (no arguments). This
runs the indexer over every discovered project and returns per-project
counts:

```json
{
  "summaries": [
    { "projectId": "abc123", "indexed": 423, "skipped": 17, "failed": 0, "elapsedSeconds": 4.2 }
  ]
}
```

### 5. Search

Call `search_workspace` with a query:

```json
{
  "query": "authenticate user",
  "limit": 5
}
```

The response includes ranked code/doc chunks with `absPath`,
`projectRoot`, `projectName`, `relPath`, `startLine`, `endLine`, `score`,
`snippet`, `language`, `kind`, and `symbols` — everything an agent needs
to open the file or grep for adjacent context without a follow-up tool
call.

To scope the search:

```json
{
  "query": "rate limit middleware",
  "path": "/Users/you/Workspaces/alpha/src/auth",
  "limit": 5
}
```

`path` accepts an absolute file or directory anywhere on disk:
- A project root → search that project only.
- A subtree under a project root → search that subtree.
- Anywhere else → warn and search every indexed project.

## Troubleshooting

### No projects discovered

`workspace_status` returns `projects: []`. Causes:

1. `workspace_roots` isn't set or doesn't exist. Check with
   `loctx config show`. Default config falls back to `process.cwd()`,
   which is rarely what you want for an agent.
2. The directories you pointed at don't contain any `.git`-marked
   subdirectories. loctx discovers projects by looking for `.git/` (up
   to 4 levels deep). Plain code directories without git won't show up.
3. Roots use `~` and the daemon is running with a stripped environment.
   Tilde-expansion uses `$HOME`; if it's missing, expand the path
   yourself in the config.

### Stale results

`refresh_workspace` reindexes from scratch. If chunks for a recently-
deleted file persist, run `loctx purge <path>` to clear the project's
chunk + vector rows (daemon-aware: hits `/api/reset/project` when the
daemon is up; otherwise drops the rows in-process). Then `loctx index`
or restart the daemon — the filesystem watcher catches new changes
from the watcher start point on. To wipe and re-index in one step,
use `loctx rebuild <path>` instead.

### Wrong scope

The search returned nothing relevant despite the project being indexed.
Check the `resolvedScope.mode` field on the response:

- `subtree` with a `relPrefix` you didn't expect — your `path` parameter
  pointed inside a project root. Pass the project root, or `"all"` /
  omit `path` to search everything.
- `all` when you wanted project-scoped — your `path` was outside every
  indexed project. The response includes a warning explaining where it
  fell back from.

### Model download stalls

First search loads the embedding model (~90 MB for the default
`Xenova/all-MiniLM-L6-v2`). Pre-download it:

```bash
loctx model download Xenova/all-MiniLM-L6-v2
```

Or run the wizard which offers to fetch it during setup:

```bash
loctx init
```

### Daemon not running (HTTP transport)

`fetch http://localhost:3022/mcp` returns `ECONNREFUSED`. Either:

1. The daemon hasn't been started — run `loctx start`.
2. The daemon is running on a different port — check `loctx config
   show`'s `daemon` block, or the running PID with `loctx status`.

### `EMFILE: too many open files, watch`

The chokidar watcher opens 1–2 file descriptors per directory. With
several mid-sized projects, the OS default limit (256 on macOS, often
1024 on Linux) is exhausted and the watcher floods stderr.

```bash
ulimit -n 10240                       # for the current shell
echo 'ulimit -n 10240' >> ~/.zshrc    # permanent (or ~/.bashrc)
loctx restart
```

`loctx doctor` shows the current limit; `loctx start --no-watch` is a
workaround when bumping the limit isn't possible.

### Permission denied / port in use

Default port `3022` is unprivileged but may be in use. Override in
config:

```yaml
daemon:
  port: 3030
  hostname: localhost
```

Then `loctx restart`.

## When to use which transport

- **Stdio (`loctx-mcp`)** — one agent, ephemeral, no admin UI. Cleanest
  for "I want loctx in Claude Code, that's it." Each agent process gets
  its own loctx process; storage is shared via `$XDG_DATA_HOME`.

- **HTTP (`loctx start`)** — multiple agents, persistent watcher, admin
  UI. Cleanest for "I want loctx running all day, agents come and go,
  and I want to inspect the index in a browser." One shared process,
  one storage directory, one set of running watchers.

The choice doesn't affect retrieval quality or the tool surface. It's
purely about process model.

## Trust model

The MCP surface and the admin HTTP API share the same trust boundary:
loopback-only network exposure, no per-tool authentication. Anything on
your machine that can reach `127.0.0.1:<port>` can use the MCP tools
without further proof.

Concretely, `search_workspace` and (with `path`) `find_usages` return
indexed file content — snippets, symbol context, and ranked chunks of
your code. That's by design for AI coding agents, but it means MCP
clients you connect to loctx are reading your indexed code in full.

Practical guidance:

- Keep the daemon bound to `127.0.0.1` (the default). Binding to
  `0.0.0.0` or `localhost` (which is DNS-rebindable) weakens this
  boundary; see SECURITY.md.
- Only point trusted agents at loctx. The agent gets the same read
  access a human user of the admin UI would have.
- Things excluded from indexing (gitignored, `secret_globs` matched,
  binary, oversized) never reach the index and so never reach MCP.
  Audit your filtering rules — `loctx doctor` reports the active set.
- The stdio transport (`loctx-mcp`) is process-scoped to its parent
  agent, which is a stronger isolation than the HTTP port; prefer it
  when feasible.

Future hardening (not yet implemented) could include per-client tokens
or per-tool capability gates. Until then, treat MCP access as
equivalent to read access on your indexed source.
