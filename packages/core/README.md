# @loctx/core

The loctx engine: local-first indexing, hybrid retrieval, and quality
analyzers for a whole workspace of projects. Everything runs on-device;
nothing leaves the machine.

- Watcher-driven pipeline: discover project roots, filter, chunk into
  line-addressable windows, embed with a local ONNX model.
- Storage: SQLite for state and FTS5 lexical search, embedded LanceDB
  for vectors. The two branches fuse via reciprocal rank fusion.
- Background analyzers annotate files after indexing: complexity,
  duplicate windows, and a heuristic quality rule pack. Findings attach
  to search results and roll up into ranked quality reports.

This package is the library layer. Most users want the CLI:

```
npm install -g @loctx/cli
```

Docs, admin UI, and MCP tools: [github.com/alex4u2nv/loctx](https://github.com/alex4u2nv/loctx).

Apache-2.0.
