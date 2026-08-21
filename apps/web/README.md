# @loctx/web

The admin UI and HTTP server for [loctx](https://github.com/alex4u2nv/loctx):
a prebuilt React SPA plus a Hono server that mounts the API, the SPA,
and the MCP endpoint on one localhost port.

This package is not used standalone — `@loctx/cli` depends on it and
loads `@loctx/web/server` when `loctx start` boots the daemon. Install
the CLI:

```
npm install -g @loctx/cli
```

Apache-2.0.
