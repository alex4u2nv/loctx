/**
 * Tiny `<table className="data-table">` primitive. Wraps the pattern
 * every route was duplicating:
 *
 *   1. Pull column definitions out of JSX so the header + body can't
 *      drift apart.
 *   2. Single place to add row-click + keyboard activation for tables
 *      that pop a modal.
 *   3. Per-cell alignment hints (`numeric`, `dim`) via a `cellClassName`
 *      callback so each column owns its visual.
 *
 * Out of scope (deliberately):
 *   - Sorting, pagination, virtualization. If a future caller needs
 *     them, add opt-in props; don't grow the surface preemptively.
 *   - Header-row click handlers; tables in this app don't sort yet.
 *   - Anything that diverges from the existing `.data-table` CSS — the
 *     styling stays in styles.css; this component just owns markup.
 *
 * See `docs/audits/2026-05-17-web-modularity.md` item 2 for context.
 */

import type { CSSProperties, ReactNode } from "react";

export interface Column<T> {
  /** Stable key for React reconciliation across re-renders. */
  readonly key: string;
  /** Header label. Pass an empty string for unlabeled columns. */
  readonly header: string;
  /** Cell renderer. Receives the row; returns whatever <td> should hold. */
  readonly cell: (row: T) => ReactNode;
  /** Adds `className="num"` to header + every cell. Right-aligned. */
  readonly numeric?: boolean;
  /** Adds `className="dim"` to every cell. Header stays normal weight. */
  readonly dim?: boolean;
  /** Optional inline style applied to the `<col>` for fixed-width layout. */
  readonly colStyle?: CSSProperties;
  /** Optional extra class merged into the header cell. */
  readonly headerClassName?: string;
}

export interface DataTableProps<T> {
  readonly columns: ReadonlyArray<Column<T>>;
  readonly rows: ReadonlyArray<T>;
  /** Stable per-row key. */
  readonly rowKey: (row: T, index: number) => string;
  /**
   * When set, rows become clickable: cursor + Enter/Space + role=button.
   * Use for the result-row → modal pattern in #255 entry 3.
   */
  readonly onRowClick?: (row: T) => void;
  /** Rendered as a centered "no data" cell when `rows` is empty. */
  readonly emptyMessage?: string;
  /** Adds an extra class to the outer `<table>` (e.g. `usage-table`). */
  readonly className?: string;
  /**
   * When colStyle is set on any column, we render a `<colgroup>` so
   * the styles apply pre-cell. Skipped otherwise to keep markup tight.
   */
  readonly tableLayout?: "auto" | "fixed";
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyMessage,
  className,
  tableLayout,
}: DataTableProps<T>) {
  const tableClass = className !== undefined ? `data-table ${className}` : "data-table";
  const hasCols = columns.some((c) => c.colStyle !== undefined);
  const clickable = onRowClick !== undefined;
  return (
    <table
      className={tableClass}
      {...(tableLayout !== undefined ? { style: { tableLayout } } : {})}
    >
      {hasCols ? (
        <colgroup>
          {columns.map((c) => (
            <col
              key={c.key}
              {...(c.colStyle !== undefined ? { style: c.colStyle } : {})}
            />
          ))}
        </colgroup>
      ) : null}
      <thead>
        <tr>
          {columns.map((c) => {
            const classes: string[] = [];
            if (c.numeric === true) classes.push("num");
            if (c.headerClassName !== undefined) classes.push(c.headerClassName);
            return (
              <th key={c.key} {...(classes.length > 0 ? { className: classes.join(" ") } : {})}>
                {c.header}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && emptyMessage !== undefined ? (
          <tr>
            <td
              colSpan={columns.length}
              style={{ color: "var(--subtle)", textAlign: "center", padding: "var(--space-5)" }}
            >
              {emptyMessage}
            </td>
          </tr>
        ) : (
          rows.map((row, i) => (
            <tr
              key={rowKey(row, i)}
              {...(clickable
                ? {
                    onClick: () => onRowClick(row),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    },
                    tabIndex: 0,
                    role: "button",
                    style: { cursor: "pointer" },
                  }
                : {})}
            >
              {columns.map((c) => {
                const cls: string[] = [];
                if (c.numeric === true) cls.push("num");
                if (c.dim === true) cls.push("dim");
                return (
                  <td key={c.key} {...(cls.length > 0 ? { className: cls.join(" ") } : {})}>
                    {c.cell(row)}
                  </td>
                );
              })}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
