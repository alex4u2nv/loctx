/**
 * Horizontal bar chart. SVG, no external library.
 *
 * Used on the `/projects/:id` inspect view for the byExtension and
 * topFiles datasets. The data is already sorted (largest first) by
 * the caller. We size each bar proportional to the largest value
 * rather than the absolute sum so a project with one outlier file
 * (e.g. package-lock.json at 155 chunks) doesn't crush every other
 * bar into invisibility.
 *
 * Labels live inline. The numeric value is rendered at the right edge
 * of each row; an optional sub-label (e.g. "12 files") sits under the
 * primary label for two-line entries.
 */

export interface BarRow {
  readonly key: string;
  readonly label: string;
  /** Numeric value driving the bar width. */
  readonly value: number;
  /** Optional second line under `label` (e.g. file counts, units). */
  readonly hint?: string;
  /** Tooltip-only payload (full path, full error). */
  readonly title?: string;
}

const MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const WIDTH = 480;
const ROW_HEIGHT = 18;
const ROW_GAP = 2;
const LABEL_COL = 120;
const VALUE_COL = 44;
const BAR_X = LABEL_COL + 6;
const BAR_MAX_W = WIDTH - LABEL_COL - VALUE_COL - 12;
const LABEL_TRUNCATE = 22;

export function BarChart({ rows }: { rows: ReadonlyArray<BarRow> }) {
  if (rows.length === 0) {
    return <p className="pullquote">No data.</p>;
  }
  const maxValue = rows.reduce((m, r) => Math.max(m, r.value), 0);
  const height = rows.length * (ROW_HEIGHT + ROW_GAP);
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label="bar chart"
      style={{ display: "block", maxWidth: "100%" }}
    >
      {rows.map((r, i) => {
        const y = i * (ROW_HEIGHT + ROW_GAP);
        const barW = maxValue === 0 ? 0 : Math.max(2, (r.value / maxValue) * BAR_MAX_W);
        return (
          <g key={r.key} transform={`translate(0, ${y})`}>
            <title>{r.title ?? r.label}</title>
            <text
              x={LABEL_COL - 4}
              y={ROW_HEIGHT / 2 + 4}
              textAnchor="end"
              style={{
                fontSize: "0.72rem",
                fill: "var(--text)",
                fontFamily: MONO_STACK,
              }}
            >
              {truncate(r.label, LABEL_TRUNCATE)}
              {r.hint !== undefined ? (
                <tspan style={{ fill: "var(--subtle)" }}>{` ${r.hint}`}</tspan>
              ) : null}
            </text>
            <rect
              x={BAR_X}
              y={(ROW_HEIGHT - 10) / 2}
              width={barW}
              height={10}
              rx={2}
              ry={2}
              style={{ fill: "var(--primary)" }}
            />
            <text
              x={WIDTH - 4}
              y={ROW_HEIGHT / 2 + 4}
              textAnchor="end"
              style={{
                fontSize: "0.72rem",
                fill: "var(--muted)",
                fontFamily: MONO_STACK,
              }}
            >
              {r.value.toLocaleString()}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  // Truncate from the LEFT for file paths so the meaningful tail
  // (filename + parent dir) stays visible; ellipsis at the start
  // signals "more above". Ext keys are short and fall through.
  if (s.includes("/")) return `…${s.slice(s.length - n + 1)}`;
  return `${s.slice(0, n - 1)}…`;
}
