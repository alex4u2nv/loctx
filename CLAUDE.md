# CLAUDE.md — loctx project instructions

This file is read by Claude (and other AI coding assistants) when
working in this repo. It captures repo-specific conventions that
aren't enforced by lint, type-check, or test alone.

## House rules

### "Extract before the third caller"

The strongest module-design rule we have:

> When **two** routes / components render the same JSX structure, the
> work to extract it is real but optional. When a **third** caller
> would land that pattern, extract to `apps/web/client/components/`
> **first**, then add the third caller against the extracted component.

Counterexample we've already paid for: a 198-line MCP-help modal
shipped in parallel with two `<SnippetModal>` rewrites and three
overlapping `createPortal` blocks. Consolidation became #259 — work
we'd have avoided by extracting `<Modal>` *before* the third dialog.

Concrete heuristics:

- If two files share more than ~15 lines of JSX, set a watch for a
  third caller. Don't extract on the second one; do extract the
  moment a third use is reasonable.
- If you're about to write a duplicate `useState<X | null>(null)` +
  `onClick={() => setOpen(row)}` + portal pattern, you're past the
  threshold — pull the shared piece first.
- Aim for **structural** sharing (the modal scaffolding, the table
  shell, the form layout), not behavioural sharing. Different routes
  will keep their own handlers; the shared component owns the
  chrome.

### Stay close to existing patterns

- Hand-drawn SVG for charts (`components/flow-chart.tsx`,
  `components/bar-chart.tsx`). Don't pull in a charting dep without
  filing an issue first.
- Modals: every dialog goes through `components/modal.tsx`. New
  `createPortal` calls outside `modal.tsx` are a regression — see
  #259.
- Icons: register in `components/icon.tsx`, reference by semantic
  name. Don't import FontAwesome icons elsewhere.
- Imperative state APIs (e.g. `confirm()`) stay rare. When the only
  user-side API is a callback, prefer a declarative component.

### When in doubt, keep it local

Premature abstraction is worse than duplication. If you have a
component that serves exactly one route and the abstraction would
need 3+ props to satisfy a hypothetical second caller, keep it local.
Promote when the second real caller arrives.

### Audit + housekeeping

- `docs/audits/` — dated audit docs (modularity, security, perf).
  When you do a structural cleanup pass, file the inventory there
  first, then ship PRs against the inventory.
- Issues tagged `chore:` are usually safe-to-batch refactors that
  don't change behaviour. Keep them small per PR so they review
  fast.

## Workspaces

- `packages/core` — runtime: indexer, watcher, embeddings, retrieval.
- `apps/cli` — `loctx` binary.
- `apps/mcp` — MCP server (stdio + HTTP via `@loctx/web`).
- `apps/web` — admin UI (React + Hono). Has client + server halves.

## Build + verify

```
npm run verify        # build + lint + typecheck + test, all workspaces
npm run build         # build only
npm run typecheck     # tsc --noEmit, all workspaces
npm run lint          # biome
npm test --workspace @loctx/core    # vitest, core only
```

E2E (web) is `npm run test:e2e --workspace @loctx/web`; needs the
daemon running.

## Pointers for future audits

- `docs/audits/2026-05-17-web-modularity.md` — first web-modularity
  inventory.
- Audit issue: #255. Modal consolidation issue: #259 (closed).
