# @loctx/mcp

The stdio MCP server for [loctx](https://github.com/alex4u2nv/loctx), a
local-first code-index daemon for coding agents. Exposes seven tools:
`search_workspace`, `find_usages`, `find_literal`, `find_duplicates`,
`quality_report`, `workspace_status`, `refresh_workspace`.

Most setups use the integrated daemon's HTTP endpoint instead
(`loctx start`, then `http://localhost:3022/mcp`); this binary serves
the same tools over stdio for clients that prefer spawning a process:

```json
{ "mcpServers": { "loctx": { "command": "loctx-mcp" } } }
```

Install alongside the CLI:

```
npm install -g @loctx/cli @loctx/mcp
```

Apache-2.0.
