# loctx

A local-first code-index daemon for coding agents. This package is a
convenience alias for [`@loctx/cli`](https://www.npmjs.com/package/@loctx/cli)
so the install is one memorable name:

```
npm install -g loctx
```

Then:

```
loctx init          # write the global config
loctx start         # daemon: watcher + admin UI + MCP on one port
loctx setup-agent   # wire MCP config into your agent
```

loctx indexes every project under a workspace root on-device and serves
search, cross-references, and quality reports to MCP clients (Claude
Code, Codex, Cursor). Nothing leaves the machine.

Docs and source: [github.com/alex4u2nv/loctx](https://github.com/alex4u2nv/loctx).

Apache-2.0.
