/**
 * Flow-chart hero — sankey-style visualisation without the
 * canvas-filling sankey scaling.
 *
 * d3-sankey scales link widths to fill the available height, which
 * looks great for many parallel flows but absurd for 2 (each link
 * eats half the hero). We draw cubic-bezier links by hand (see
 * `linkPath`) and compute thickness ourselves as a log-scale
 * function of chunk count, so a workspace with 19 projects fans
 * into thin separated threads and a workspace with 2 projects gets
 * two clean lines instead of a solid blob.
 *
 * Names are truncated to NAME_TRUNCATE chars; the full name lives
 * in the <title> tooltip. The visible list caps at MAX_OUTPUTS with
 * an "+ N more" overflow node that aggregates the rest.
 */

import type { WatcherState } from "@shared/contracts";

export interface FlowProject {
  readonly id: string;
  readonly name: string;
  readonly chunks: number;
  readonly watcher: WatcherState | null;
  /**
   * Daemon is actively writing chunks for this project — either via a
   * rebuild or a reconcile pass (#310). Drives the "indexing" pulse on
   * the flow-chart link so the dashboard mirrors what the /projects
   * health badge already shows.
   */
  readonly inFlight?: boolean;
}

const MAX_OUTPUTS = 6;
const NAME_TRUNCATE = 26;
const WIDTH = 960;
const HEIGHT = 340;
const SOURCE_X = 16;
const SOURCE_WIDTH = 110;
const OUTPUT_X = 540;
const OUTPUT_NODE_WIDTH = 14;
const MIN_LINK_WIDTH = 3;
const MAX_LINK_WIDTH = 16;
// How far each link's source endpoint sits inside the source rect's
// right edge, so the link visibly anchors onto the rect rather than
// just touching its boundary.
const LINK_OVERLAP = 8;
const OUTPUT_LINK_OVERLAP = OUTPUT_NODE_WIDTH / 2;
// Vertical spacing between adjacent source-side endpoints. Small enough
// to feel like the lines branch out of one node, big enough that a flat
// middle link doesn't disappear underneath the row above it.
const SOURCE_FAN_STEP = 10;

type OutputKind = "active" | "indexing" | "paused" | "failed" | "ready" | "dim" | "more";

interface OutputNode {
  readonly key: string;
  readonly label: string;
  readonly chunks: number;
  readonly watcher: WatcherState | null;
  readonly hiddenCount?: number;
  readonly cy: number;
  readonly thickness: number;
  readonly kind: OutputKind;
}

export function FlowChart({
  totalChunks,
  projects,
}: {
  totalChunks: number;
  projects: ReadonlyArray<FlowProject>;
}) {
  const counts = projects.reduce(
    (acc, p) => {
      const kind = classify(p.watcher, p.chunks, undefined, p.inFlight === true);
      acc[kind] = (acc[kind] ?? 0) + 1;
      return acc;
    },
    {} as Record<OutputKind, number>,
  );
  // Sort by chunk count desc so the noisiest projects survive the cap.
  const sorted = [...projects].sort((a, b) => b.chunks - a.chunks);
  const visible = sorted.slice(0, MAX_OUTPUTS);
  const hidden = sorted.slice(MAX_OUTPUTS);
  const hiddenChunks = hidden.reduce((acc, p) => acc + p.chunks, 0);

  const rows: Array<{
    key: string;
    label: string;
    chunks: number;
    watcher: WatcherState | null;
    inFlight?: boolean;
    hiddenCount?: number;
  }> = visible.map((p) => ({
    key: p.id,
    label: truncate(p.name),
    chunks: p.chunks,
    watcher: p.watcher,
    ...(p.inFlight === true ? { inFlight: true } : {}),
  }));
  if (hidden.length > 0) {
    rows.push({
      key: "__more__",
      label: `+ ${hidden.length} more`,
      chunks: hiddenChunks,
      watcher: null,
      hiddenCount: hidden.length,
    });
  }

  // Lay out output nodes vertically with even spacing.
  const top = 20;
  const bottom = HEIGHT - 20;
  const span = bottom - top;
  const rowCount = rows.length;
  const outputs: OutputNode[] = rows.map((r, i) => ({
    ...r,
    // +1 in the denominator so the rows sit centred rather than
    // hugging the top/bottom edges.
    cy: top + ((i + 1) * span) / (rowCount + 1),
    thickness: thicknessFor(r.chunks, totalChunks),
    kind: classify(r.watcher, r.chunks, r.hiddenCount, r.inFlight === true),
  }));

  // Source bar — vertically centred, height proportional to total chunks
  // capped so a tiny workspace doesn't show a sliver.
  const sourceCy = HEIGHT / 2;
  const sourceHeight = Math.max(60, Math.min(HEIGHT - 40, rowCount * 32 + 40));
  const sourceY = sourceCy - sourceHeight / 2;

  return (
    <div className="flow-chart-wrap">
    <svg
      className="flow-chart"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={`Index flow: ${totalChunks.toLocaleString()} chunks across ${projects.length} projects`}
    >
      <defs>
        <linearGradient id="flow-link-active" x1="0" x2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.95" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.55" />
        </linearGradient>
        <linearGradient id="flow-link-ready" x1="0" x2="1">
          <stop offset="0%" stopColor="var(--primary-dim)" stopOpacity="0.85" />
          <stop offset="100%" stopColor="var(--primary-dim)" stopOpacity="0.5" />
        </linearGradient>
        <linearGradient id="flow-link-paused" x1="0" x2="1">
          <stop offset="0%" stopColor="var(--warn)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--warn)" stopOpacity="0.45" />
        </linearGradient>
        <linearGradient id="flow-link-failed" x1="0" x2="1">
          <stop offset="0%" stopColor="var(--bad)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--bad)" stopOpacity="0.45" />
        </linearGradient>
        <linearGradient id="flow-link-indexing" x1="0" x2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.7" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.3" />
        </linearGradient>
        <linearGradient id="flow-link-dim" x1="0" x2="1">
          <stop offset="0%" stopColor="var(--border-strong)" stopOpacity="0.7" />
          <stop offset="100%" stopColor="var(--border-strong)" stopOpacity="0.4" />
        </linearGradient>
      </defs>

      {/* Render order matters:
          1. Source rect (so links visibly emerge over its right edge —
             without this, a perfectly horizontal middle link gets
             absorbed by the rect's body and drop-shadow glow).
          2. Links — start a few px INSIDE the rect so each one
             unambiguously anchors to it, and converge near the rect's
             vertical centre so the visual reads as "branching out"
             from the cube rather than fanning along its full height.
          3. Source text labels last so they sit on top of the link
             stubs that pass under them. */}
      <g className="flow-chart-node source">
        <rect
          x={SOURCE_X}
          y={sourceY}
          width={SOURCE_WIDTH}
          height={sourceHeight}
          rx={8}
        />
        <title>
          Index source · {totalChunks.toLocaleString()} chunks across {projects.length} project
          {projects.length === 1 ? "" : "s"}
        </title>
      </g>

      {outputs.map((o, i) => {
        const srcY = sourceFanY(i, outputs.length, sourceCy);
        const linkClass =
          o.kind === "indexing" ? "flow-chart-link indexing" : "flow-chart-link";
        const link = linkPath({
          sourceX: SOURCE_X + SOURCE_WIDTH - LINK_OVERLAP,
          sourceY: srcY,
          targetX: OUTPUT_X + OUTPUT_LINK_OVERLAP,
          targetY: o.cy,
          index: i,
          total: outputs.length,
        });
        return (
          <path
            key={`link-${o.key}`}
            className={linkClass}
            d={link}
            stroke={linkGradient(o)}
            strokeWidth={o.thickness}
            fill="none"
          />
        );
      })}

      <g className="flow-chart-node source labels">
        <text
          className="flow-chart-source-label"
          x={SOURCE_X + 12}
          y={sourceCy - 8}
          textAnchor="start"
          dominantBaseline="middle"
        >
          OUTPUT
        </text>
        <text
          className="flow-chart-source-value"
          x={SOURCE_X + 12}
          y={sourceCy + 10}
          textAnchor="start"
          dominantBaseline="middle"
        >
          {totalChunks.toLocaleString()}
        </text>
      </g>

      {/* Output nodes */}
      {outputs.map((o) => {
        const nodeHeight = Math.max(o.thickness + 4, 10);
        return (
          <g key={`node-${o.key}`} className={nodeClass(o)}>
            <rect
              x={OUTPUT_X}
              y={o.cy - nodeHeight / 2}
              width={OUTPUT_NODE_WIDTH}
              height={nodeHeight}
              rx={3}
            />
            <text
              className="flow-chart-name"
              x={OUTPUT_X + OUTPUT_NODE_WIDTH + 10}
              y={o.cy - 7}
              textAnchor="start"
              dominantBaseline="middle"
            >
              {o.label}
            </text>
            <text
              className="flow-chart-value"
              x={OUTPUT_X + OUTPUT_NODE_WIDTH + 10}
              y={o.cy + 8}
              textAnchor="start"
              dominantBaseline="middle"
            >
              {o.hiddenCount !== undefined
                ? `${o.hiddenCount} hidden`
                : `${o.chunks.toLocaleString()} chunks`}
            </text>
            <title>
              {o.hiddenCount !== undefined
                ? `${o.hiddenCount} more projects collapsed`
                : `${o.label} · ${o.chunks.toLocaleString()} chunks`}
            </title>
          </g>
        );
      })}
    </svg>
    <Legend counts={counts} />
    </div>
  );
}

const LEGEND_ITEMS: ReadonlyArray<{ kind: OutputKind; label: string }> = [
  { kind: "active", label: "active" },
  { kind: "indexing", label: "indexing" },
  { kind: "ready", label: "ready" },
  { kind: "paused", label: "paused" },
  { kind: "failed", label: "failed" },
  { kind: "dim", label: "empty" },
];

function Legend({ counts }: { counts: Record<OutputKind, number> }) {
  const items = LEGEND_ITEMS.filter((it) => (counts[it.kind] ?? 0) > 0);
  if (items.length === 0) return null;
  return (
    <ul className="flow-chart-legend" aria-label="Watcher state legend">
      {items.map((it) => (
        <li key={it.kind} className={`flow-chart-legend-item ${it.kind}`}>
          <span className="flow-chart-legend-swatch" />
          <span className="flow-chart-legend-label">{it.label}</span>
          <span className="flow-chart-legend-count">{counts[it.kind]}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Map a chunk count to a stroke width. Log scale keeps a 4000-chunk
 * project visible without dwarfing a 65-chunk one. `total` is just the
 * highest expected value used to normalise — single projects with low
 * counts still get the minimum stroke.
 */
function thicknessFor(chunks: number, total: number): number {
  if (chunks <= 0 || total <= 0) return MIN_LINK_WIDTH;
  const norm = Math.log10(chunks + 1) / Math.log10(total + 1);
  return MIN_LINK_WIDTH + norm * (MAX_LINK_WIDTH - MIN_LINK_WIDTH);
}

function classify(
  watcher: WatcherState | null,
  chunks: number,
  hiddenCount: number | undefined,
  inFlight = false,
): OutputKind {
  if (hiddenCount !== undefined) return "more";
  if (watcher === "failed") return "failed";
  if (watcher === "paused") return "paused";
  // Daemon is actively writing chunks (rebuild or reconcile pass) —
  // takes precedence over the "active" steady state so the link
  // animates while real work is happening.
  if (inFlight) return "indexing";
  // Active watcher but nothing indexed yet → in-progress / queued.
  if (watcher === "active" && chunks === 0) return "indexing";
  if (watcher === "active") return "active";
  if (chunks > 0) return "ready";
  return "dim";
}

function linkGradient(o: OutputNode): string {
  switch (o.kind) {
    case "active":
      return "url(#flow-link-active)";
    case "indexing":
      return "url(#flow-link-indexing)";
    case "paused":
      return "url(#flow-link-paused)";
    case "failed":
      return "url(#flow-link-failed)";
    case "ready":
      return "url(#flow-link-ready)";
    case "more":
    case "dim":
      return "url(#flow-link-dim)";
  }
}

function nodeClass(o: OutputNode): string {
  return `flow-chart-node ${o.kind}`;
}

/**
 * Place each link's source endpoint a few pixels apart vertically,
 * centred on the source rect's middle. This gives the visual feel of
 * lines branching out from one node without making coincident endpoints
 * (which would render as a single overlapping cluster and could hide a
 * perfectly horizontal middle link). Total spread is bounded so the
 * cluster always reads as "one source", not a tall fan.
 */
function sourceFanY(i: number, n: number, cy: number): number {
  if (n <= 1) return cy;
  // Centre the spread on cy: positions go (i - (n-1)/2) * step.
  const offset = (i - (n - 1) / 2) * SOURCE_FAN_STEP;
  return cy + offset;
}

function linkPath({
  sourceX,
  sourceY,
  targetX,
  targetY,
  index,
  total,
}: {
  readonly sourceX: number;
  readonly sourceY: number;
  readonly targetX: number;
  readonly targetY: number;
  readonly index: number;
  readonly total: number;
}): string {
  const dx = targetX - sourceX;
  const midX = sourceX + dx * 0.5;
  const middle = (total - 1) / 2;
  const relative = total <= 1 ? 0 : index - middle;
  const sign = relative === 0 ? 1 : Math.sign(relative);
  const bend = Math.max(8, Math.abs(relative) * 10);
  const sourceControlY = sourceY + sign * bend;
  const targetControlY = targetY - sign * bend;
  return `M${sourceX},${sourceY}C${midX},${sourceControlY},${midX},${targetControlY},${targetX},${targetY}`;
}

function truncate(name: string): string {
  if (name.length <= NAME_TRUNCATE) return name;
  return `${name.slice(0, NAME_TRUNCATE - 1)}…`;
}
