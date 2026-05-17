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
const VALUE_COL_W = 44;
// Reserved width for the hint column ("12 files"). 0 when the dataset
// has no hints (file lists), so the label gets the full pre-bar gutter.
const HINT_COL_W = 44;
const COL_GAP = 8;

interface ColumnLayout {
  readonly labelX: number;
  readonly hintX: number;
  readonly barX: number;
  readonly barMaxW: number;
  readonly valueX: number;
  readonly labelTruncate: number;
}

/**
 * Build a column layout for the chart. Without `showHint` the label
 * column reclaims the hint column's width so file-path rows can show
 * more characters. Same chart class — every row inside one render uses
 * the same columns, which is what fixes the alignment bug in #254.
 */
function computeLayout(showHint: boolean): ColumnLayout {
  const valueX = WIDTH - 4;
  const valueColLeft = valueX - VALUE_COL_W;
  const barRightLimit = valueColLeft - COL_GAP;
  const hintW = showHint ? HINT_COL_W : 0;
  const labelW = showHint ? 88 : 88 + HINT_COL_W;
  const labelX = labelW; // right-edge anchor
  const hintX = labelX + hintW + (showHint ? COL_GAP : 0);
  const barX = hintX + COL_GAP;
  const barMaxW = Math.max(20, barRightLimit - barX);
  // Mono char width ~ 5px at 0.72rem; subtract one char of breathing room.
  const labelTruncate = Math.max(8, Math.floor(labelW / 5) - 1);
  return { labelX, hintX, barX, barMaxW, valueX, labelTruncate };
}

export function BarChart({ rows }: { rows: ReadonlyArray<BarRow> }) {
  if (rows.length === 0) {
    return <p className="pullquote">No data.</p>;
  }
  const maxValue = rows.reduce((m, r) => Math.max(m, r.value), 0);
  const showHint = rows.some((r) => r.hint !== undefined);
  const layout = computeLayout(showHint);
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
        const barW = maxValue === 0 ? 0 : Math.max(2, (r.value / maxValue) * layout.barMaxW);
        const baselineY = ROW_HEIGHT / 2 + 4;
        return (
          <g key={r.key} transform={`translate(0, ${y})`}>
            <title>{r.title ?? r.label}</title>
            {/* Label column: right-anchored at labelX. Every row's label
                ends at the same pixel regardless of hint presence — #254. */}
            <text
              x={layout.labelX}
              y={baselineY}
              textAnchor="end"
              style={{
                fontSize: "0.72rem",
                fill: "var(--text)",
                fontFamily: MONO_STACK,
              }}
            >
              {truncate(r.label, layout.labelTruncate)}
            </text>
            {/* Hint column: right-anchored at hintX so multi-digit
                counts stay aligned column-wise rather than line-wise. */}
            {showHint && r.hint !== undefined ? (
              <text
                x={layout.hintX}
                y={baselineY}
                textAnchor="end"
                style={{
                  fontSize: "0.72rem",
                  fill: "var(--subtle)",
                  fontFamily: MONO_STACK,
                }}
              >
                {r.hint}
              </text>
            ) : null}
            <rect
              x={layout.barX}
              y={(ROW_HEIGHT - 10) / 2}
              width={barW}
              height={10}
              rx={2}
              ry={2}
              style={{ fill: "var(--primary)" }}
            />
            <text
              x={layout.valueX}
              y={baselineY}
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
