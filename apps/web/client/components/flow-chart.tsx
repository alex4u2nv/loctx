/**
 * Flow-chart hero — sankey-style visualisation without the
 * canvas-filling sankey scaling.
 *
 * d3-sankey scales link widths to fill the available height, which
 * looks great for many parallel flows but absurd for 2 (each link
 * eats half the hero). We use d3-shape's linkHorizontal to draw
 * smooth curves and compute thickness ourselves as a log-scale
 * function of chunk count, so a workspace with 19 projects fans
 * into thin separated threads and a workspace with 2 projects gets
 * two clean lines instead of a solid blob.
 *
 * Names are truncated to NAME_TRUNCATE chars; the full name lives
 * in the <title> tooltip. The visible list caps at MAX_OUTPUTS with
 * an "+ N more" overflow node that aggregates the rest.
 */

import type { WatcherState } from "@shared/contracts";
import { linkHorizontal } from "d3-shape";

export interface FlowProject {
  readonly id: string;
  readonly name: string;
  readonly chunks: number;
  readonly watcher: WatcherState | null;
}

const MAX_OUTPUTS = 6;
const NAME_TRUNCATE = 22;
const WIDTH = 720;
const HEIGHT = 320;
const SOURCE_X = 16;
const SOURCE_WIDTH = 96;
const OUTPUT_X = 600;
const OUTPUT_NODE_WIDTH = 14;
const MIN_LINK_WIDTH = 2;
const MAX_LINK_WIDTH = 14;

interface OutputNode {
  readonly key: string;
  readonly label: string;
  readonly chunks: number;
  readonly watcher: WatcherState | null;
  readonly hiddenCount?: number;
  readonly cy: number;
  readonly thickness: number;
}

export function FlowChart({
  totalChunks,
  projects,
}: {
  totalChunks: number;
  projects: ReadonlyArray<FlowProject>;
}) {
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
    hiddenCount?: number;
  }> = visible.map((p) => ({
    key: p.id,
    label: truncate(p.name),
    chunks: p.chunks,
    watcher: p.watcher,
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
  }));

  interface Point {
    readonly x: number;
    readonly y: number;
  }
  interface LinkInput {
    readonly source: Point;
    readonly target: Point;
  }
  const path = linkHorizontal<LinkInput, Point>()
    .source((d) => d.source)
    .target((d) => d.target)
    .x((d) => d.x)
    .y((d) => d.y);

  // Source bar — vertically centred, height proportional to total chunks
  // capped so a tiny workspace doesn't show a sliver.
  const sourceCy = HEIGHT / 2;
  const sourceHeight = Math.max(60, Math.min(HEIGHT - 40, rowCount * 28 + 32));
  const sourceY = sourceCy - sourceHeight / 2;

  return (
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
        <linearGradient id="flow-link-dim" x1="0" x2="1">
          <stop offset="0%" stopColor="var(--border-strong)" stopOpacity="0.7" />
          <stop offset="100%" stopColor="var(--border-strong)" stopOpacity="0.4" />
        </linearGradient>
      </defs>

      {/* Links first so the source/output rects sit on top */}
      {outputs.map((o) => {
        const link = path({
          source: { x: SOURCE_X + SOURCE_WIDTH, y: sourceCy },
          target: { x: OUTPUT_X, y: o.cy },
        });
        return (
          <path
            key={`link-${o.key}`}
            className="flow-chart-link"
            d={link ?? ""}
            stroke={linkGradient(o)}
            strokeWidth={o.thickness}
            fill="none"
          />
        );
      })}

      {/* Source (OUTPUT) block */}
      <g className="flow-chart-node source">
        <rect
          x={SOURCE_X}
          y={sourceY}
          width={SOURCE_WIDTH}
          height={sourceHeight}
          rx={8}
        />
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
        <title>
          Index source · {totalChunks.toLocaleString()} chunks across {projects.length} project
          {projects.length === 1 ? "" : "s"}
        </title>
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

function linkGradient(o: OutputNode): string {
  if (o.hiddenCount !== undefined) return "url(#flow-link-dim)";
  if (o.watcher === "active" && o.chunks > 0) return "url(#flow-link-active)";
  if (o.chunks > 0) return "url(#flow-link-ready)";
  return "url(#flow-link-dim)";
}

function nodeClass(o: OutputNode): string {
  const base = "flow-chart-node";
  if (o.hiddenCount !== undefined) return `${base} more`;
  if (o.watcher === "active" && o.chunks > 0) return `${base} active`;
  if (o.chunks > 0) return `${base} ready`;
  return `${base} dim`;
}

function truncate(name: string): string {
  if (name.length <= NAME_TRUNCATE) return name;
  return `${name.slice(0, NAME_TRUNCATE - 1)}…`;
}
