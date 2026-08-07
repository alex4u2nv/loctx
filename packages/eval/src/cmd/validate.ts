/**
 * `loctx-eval validate <golden-set>` (#469) — gold-set integrity check.
 *
 * qrels.jsonl encodes each relevant doc as a `rel_path` + line span, but
 * nothing verified those spans still exist in the pinned corpus. A stale
 * qrel (file renamed, span moved out of any chunk) silently scores 0 and
 * reads as a retrieval regression instead of what it is: gold-set rot.
 * The "never edit golden/vN in place, bump to vN+1" policy is
 * convention-only without a mechanical tripwire — this is that tripwire.
 *
 * Indexes the pinned corpus, then cross-checks every qrel span against
 * the actual chunk boundaries:
 *   - exact:       a chunk's span exactly matches the qrel span.
 *   - drift:       a chunk overlaps but no exact match — fine (the
 *                  scorer uses span-overlap, not exact docids), reported
 *                  as a heads-up.
 *   - no-overlap:  the file is indexed but no chunk covers the span.
 *   - missing-file: the rel_path has no indexed chunks at all.
 * The last two are rot — the qrel can never be satisfied — and make the
 * command exit non-zero.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSandboxedRuntime, indexCorpus, loadCorpusConfig, snapshotCorpus } from "../corpus.js";
import { loadQrels, spansOverlap } from "../qrels.js";
import type { Qrel } from "../types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GOLDEN_ROOT = resolve(HERE, "..", "..", "golden");

export type QrelStatus = "exact" | "drift" | "no-overlap" | "missing-file";

export interface QrelValidation {
  readonly queryId: string;
  readonly relPath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly status: QrelStatus;
}

export interface ValidateCommandResult {
  /** False when any qrel is `no-overlap` or `missing-file`. */
  readonly ok: boolean;
  readonly total: number;
  readonly counts: Readonly<Record<QrelStatus, number>>;
  readonly failures: ReadonlyArray<QrelValidation>;
  readonly all: ReadonlyArray<QrelValidation>;
}

export interface ValidateCommandOptions {
  readonly goldenSet: string;
  readonly goldenRoot?: string;
}

export async function validateCommand(
  options: ValidateCommandOptions,
): Promise<ValidateCommandResult> {
  const goldenRoot = options.goldenRoot ?? DEFAULT_GOLDEN_ROOT;
  const setDir = join(goldenRoot, options.goldenSet);
  const corpus = loadCorpusConfig(join(setDir, "corpus.toml"));
  const qrels = loadQrels(join(setDir, "qrels.jsonl"));
  const searchRoots = [process.cwd(), resolve(process.cwd(), "..")];

  const snap = await snapshotCorpus(corpus, searchRoots);
  let runtimeBox: Awaited<ReturnType<typeof buildSandboxedRuntime>> | undefined;
  try {
    runtimeBox = await buildSandboxedRuntime(corpus);
    const { runtime } = runtimeBox;
    const { project } = await indexCorpus(runtime, snap.root);

    // rel_path → sorted chunk spans.
    const spansByPath = new Map<string, Array<{ start: number; end: number }>>();
    for (const f of runtime.state.listFiles(project.id)) {
      const spans = runtime.state
        .listChunks(f.fileId)
        .map((c) => ({ start: c.startLine, end: c.endLine }));
      spansByPath.set(f.relPath, spans);
    }

    const all = qrels.map((q) => classify(q, spansByPath.get(q.relPath)));
    const counts: Record<QrelStatus, number> = {
      exact: 0,
      drift: 0,
      "no-overlap": 0,
      "missing-file": 0,
    };
    for (const v of all) counts[v.status] += 1;
    const failures = all.filter((v) => v.status === "no-overlap" || v.status === "missing-file");
    return Object.freeze({
      ok: failures.length === 0,
      total: all.length,
      counts: Object.freeze(counts),
      failures: Object.freeze(failures),
      all: Object.freeze(all),
    });
  } finally {
    if (runtimeBox !== undefined) await runtimeBox.close();
    snap.cleanup();
  }
}

/**
 * Classify one qrel against the chunk spans of its file. Exported for
 * unit tests — the end-to-end command indexes a corpus, but the
 * exact/drift/no-overlap/missing-file decision is pure.
 */
export function classify(
  q: Qrel,
  spans: ReadonlyArray<{ start: number; end: number }> | undefined,
): QrelValidation {
  const base = {
    queryId: q.queryId as string,
    relPath: q.relPath,
    startLine: q.startLine,
    endLine: q.endLine,
  };
  if (spans === undefined || spans.length === 0) {
    return { ...base, status: "missing-file" };
  }
  let overlap = false;
  for (const s of spans) {
    if (s.start === q.startLine && s.end === q.endLine) return { ...base, status: "exact" };
    // Same inclusive span-overlap rule the metrics use — routed through
    // the shared helper so validate and scoring can't drift apart.
    if (spansOverlap({ startLine: s.start, endLine: s.end }, q)) overlap = true;
  }
  return { ...base, status: overlap ? "drift" : "no-overlap" };
}
