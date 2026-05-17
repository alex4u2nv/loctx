# Web client modularity audit — 2026-05-17

Tracks #255. Inventories candidates for shared-component extraction
in `apps/web/client/**`, with a verdict for each. Promotion PRs land
piecemeal against the entries marked `promote`.

## Verdict legend

- **promote** — extract to `apps/web/client/components/` now; the
  duplication is established and the cost is paid.
- **keep local** — only one real caller; would be premature
  abstraction.
- **already shared** — addressed elsewhere; no action.

## Inventory

### 1. Modals / dialogs

**Already shared.** Resolved by #259 / PR #261:

- `components/modal.tsx` owns portal, backdrop, Escape, aria
  scaffolding.
- `components/confirm.tsx`, `components/snippet-modal.tsx`,
  `components/mcp-help.tsx` all wrap `<Modal>`.
- DoD enforced: 1 `createPortal` in the codebase, 1 hand-rolled
  Escape listener (the Enter-to-confirm in `ConfirmHost`, not
  Escape).

No further action.

### 2. Data tables

**Promote.** The `data-table` markup is hand-rolled in:

- `routes/projects.tsx` (active + orphaned project rows)
- `routes/find-usages.tsx` (defs + refs)
- `routes/project-detail.tsx` (multiple — bar charts replaced one set
  but file lists + failing files remain)
- `routes/search.tsx` (search hits)
- `routes/models.tsx` (model list)

Five-plus call sites is way past the threshold. Propose a tiny
primitive:

```ts
interface Column<T> {
  readonly key: string;
  readonly header: string;
  readonly cell: (row: T) => ReactNode;
  readonly numeric?: boolean;
  readonly dim?: boolean;
}

interface DataTableProps<T> {
  readonly columns: ReadonlyArray<Column<T>>;
  readonly rows: ReadonlyArray<T>;
  readonly rowKey: (row: T) => string;
  readonly onRowClick?: (row: T) => void;
  readonly emptyMessage?: string;
}
```

Scope cap: this should be ~40 lines, not a generic data-grid. No
sorting, no pagination, no virtualization in v1. If a future caller
needs those, add via opt-in props.

### 3. Result row → modal flow

**Promote (depends on #2).** Both `SearchResults` and `UsageTable` in
`project-detail.tsx` independently track `useState<Hit | null>(null)`
+ click-to-open + render `<SnippetModal>`. Same pattern in any
future result list.

Solution: a `useSnippetSelection<T>()` hook that returns
`{ selected, open, close }` paired with a `<DataTable
onRowClick={open}>` from #2. The result-row → modal pattern then
collapses to ~6 lines per call site.

### 4. Action buttons (`IconButton`)

**Promote.** `IconButton` lives locally in `routes/projects.tsx` but
the same affordance was hand-rolled as a `<Link className="btn">` for
the inspect button in PR #257, and as standalone buttons in
`routes/models.tsx` and `routes/admin.tsx`. Move to
`components/icon-button.tsx`, support both `onClick` and `href` so
the inspect-link case isn't an exception.

Add a `title?: string` and `animate?: boolean` prop (the latter
already needed by the rebuild hammer); these stay on the primitive.

### 5. Card / surface containers

**Promote.** `ChartCard` is inline in `routes/project-detail.tsx`,
`StatCard`-shaped chrome is hand-rolled in `routes/status.tsx` (the
Daemon / Coverage / Details tiles), and the dashboard hero card
follows the same pattern. Promote to `components/surface-card.tsx`
with props `{ eyebrow?, title?, subtitle?, children, accent? }`.

This one's mostly about consistency: the cards already use the same
CSS tokens (`--surface`, `--border`, `--radius-card`), but the markup
varies. Promote forces convergence.

### 6. Search / find-usages forms

**Promote (smallest impact).** `routes/find-usages.tsx`,
`routes/search.tsx`, and the scoped panels in
`routes/project-detail.tsx` all hand-write near-identical
`<form className="search-form">` blocks with a labeled input + submit
button.

Propose `QueryForm`:

```ts
interface QueryFormProps {
  readonly fields: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly label: string;
    readonly placeholder?: string;
    readonly optional?: boolean;
  }>;
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly onSubmit: (values: Record<string, string>) => void;
}
```

Call sites then specify just the field list + submit handler.

### 7. Per-row in-flight tracking

**Keep local (for now).** Only `purgingRoots` exists today (PR #252's
`useState<ReadonlySet<string>>`). The rebuild path uses an
SSE-driven server tracker, not local state.

Promote to a `useInFlightSet()` hook only when a second per-row
in-flight pattern lands (e.g. activate / deactivate gaining
visible-while-pending feedback).

### 8. Inline styles vs. CSS classes

**Promote (incremental).** Today's session-added components mix
`style={{...}}` with class names — most repeats are:

- The `snippet-pre` `<pre>` styling (background, border, padding,
  maxHeight, overflow). Used in `snippet-modal.tsx` (plain fallback)
  and `mcp-help.tsx`. Promote to a `.snippet-pre` CSS class.
- The `ChartCard` container (surface bg, border, radius, padding).
  Promote to `.chart-card` after #5 lands.
- The modal-action button row (margin top, etc.). Already
  half-covered by `.modal-actions`; verify and standardize.

Not a single-PR concern — promote one block at a time as the related
components land. No `style={{ background: 'var(--surface-2)' }}`
should remain in `apps/web/client/components/` once #5 + #2 are in.

## Sequencing

Recommended order for the promotion PRs:

1. **`DataTable`** (#2) — biggest reuse multiplier; every other
   audit item touches a table.
2. **`useSnippetSelection` + clickable-row integration** (#3) —
   depends on #2.
3. **`IconButton` to `components/`** (#4) — independent, small.
4. **`SurfaceCard`** (#5) — independent, small.
5. **`QueryForm`** (#6) — independent, but lower payoff than #2;
   ship after the others if time permits.
6. **CSS class migration** (#8) — finishing pass after each
   structural promotion.

`useInFlightSet` stays deferred until a second caller materializes.

## Out of scope

- Visual redesign — structural cleanup only.
- React state management migrations.
- The `server/`, `core/`, and `cli/` workspaces — separate audits if
  warranted.
