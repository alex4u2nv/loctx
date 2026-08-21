# @loctx/cli

`loctx` — a local-first code-index daemon for coding agents. It indexes
every project under a workspace root and serves search, cross-references,
and quality reports to MCP clients (Claude Code, Codex, Cursor) plus a
React admin UI, all on one localhost port. Nothing leaves the machine.

## Install

```
npm install -g @loctx/cli
```

Node >= 22. Native modules (better-sqlite3, LanceDB, ONNX runtime,
tree-sitter) compile or use prebuilds at install time.

## Use

```
loctx init          # write the global config
loctx start         # daemon: watcher + admin UI + MCP on one port
loctx setup-agent   # wire MCP config into your agent
loctx skills install  # optional: coding-practice skills, user-level
```

Point an MCP client at `http://localhost:3022/mcp` and the agent gets
seven tools: `search_workspace`, `find_usages`, `find_literal`,
`find_duplicates`, `quality_report`, `workspace_status`,
`refresh_workspace`.

Docs and source: [github.com/alex4u2nv/loctx](https://github.com/alex4u2nv/loctx).

Apache-2.0.
