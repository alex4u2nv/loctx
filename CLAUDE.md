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
  #259. The one sanctioned exception is
  `components/overflow-menu.tsx`: an anchored, flip-aware popover is a
  genuinely different primitive from a centered modal, so it portals to
  `document.body` on its own. Don't add other portal exceptions without
  filing an issue first.
- Icons: register in `components/icon.tsx`, reference by semantic
  name. Don't import FontAwesome icons elsewhere.
- Imperative state APIs (e.g. `confirm()`) stay rare. When the only
  user-side API is a callback, prefer a declarative component.
- Styling: the web UI uses **Tailwind v4** (`@tailwindcss/vite`) with a
  TailAdmin-flavoured token set defined in `client/styles.css`
  (`@theme` — brand `#465fff`, gray scale, Outfit font). The legacy
  `--*` CSS custom properties are **kept and remapped** onto that
  palette, so the shared component classes (`.card`, `.btn`,
  `.data-table`, …) and the inline `var(--…)` styles scattered through
  the routes all re-skin from one place. Light/dark is a `.dark` class
  on `<html>` (`lib/appearance.ts`), not multiple `data-theme`s. The
  app shell (fixed sidebar + sticky header, content panel) lives in
  `app.tsx`. Use Tailwind utilities for new layout; reuse the shared
  component classes for chrome rather than re-styling from scratch.
- Admin IA: workspace settings are split into concern tabs
  (`Admin` ops, `Config`, `Analyzers`, `Models`, `Doctor`, `Logs`).
  **All analyzer provisioning** — install/enable/disable, rule dirs,
  reindex, duplicate detection, engine tuning — lives on the
  `Analyzers` tab (`routes/analyzers.tsx`), not the Config page. Keep
  a concern in one place; don't re-split enable/install/config across
  screens.

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
- `packages/eval` — offline retrieval-quality eval harness. Versioned
  gold sets, TREC run files, Markdown reports. See its README.
- `apps/cli` — `loctx` binary.
- `apps/mcp` — MCP server (stdio + HTTP via `@loctx/web`).
- `apps/web` — admin UI (React + Hono). Has client + server halves.

### Retrieval changes: regenerate the eval baseline

Any PR that touches `packages/core/src/{retrieval,chunking,embeddings,indexing}/**`
needs to run the eval harness and post the report. CI does this
automatically on the PR via `.github/workflows/eval.yml`. Locally:

```
pnpm eval run v1
pnpm eval report packages/eval/runs
```

The CI workflow is report-only in v1 — no regression gating yet.
Treat large drops in `Hit@10` / `MRR@10` / `nDCG@10` as a soft
blocker pending human review. Bumping the gold set version (`v1 → v2`)
is a separate PR — never edit `golden/v1/` in place.

## Build + verify

This repo uses pnpm (>= 9) — npm/yarn aren't tested. `corepack enable && corepack prepare pnpm@9.15.9 --activate` is enough.

```
pnpm run verify       # build + lint + typecheck + test, all workspaces
pnpm run build        # build only
pnpm run typecheck    # tsc --noEmit, all workspaces
pnpm run lint         # biome
pnpm --filter @loctx/core test       # vitest, core only
```

E2E (web) is `pnpm --filter @loctx/web test:e2e`; needs the
daemon running.

## Pointers for future audits

- `docs/audits/2026-05-17-web-modularity.md` — first web-modularity
  inventory.
- Audit issue: #255. Modal consolidation issue: #259 (closed).
- `docs/audits/2026-07-17-lancedb-write-coordination.md` — design for
  unblocking indexing concurrency + the ANN index trigger (#447).
  Implementation split into #488–#491.
