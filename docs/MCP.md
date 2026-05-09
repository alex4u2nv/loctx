# MCP setup

loctx exposes three MCP tools (`search_workspace`, `workspace_status`,
`refresh_workspace`) over two transports. Pick the one that fits your
agent and workflow.

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

If you've installed via `npm link` from a local clone, the binary is on
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

You should see exactly three:

```
search_workspace
workspace_status
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
deleted file persist, run `loctx reset project <path>` (work in
progress) to clear the project's data, or restart the daemon — the
filesystem watcher catches new changes from the watcher start point on.

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
