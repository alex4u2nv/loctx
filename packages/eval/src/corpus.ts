/**
 * Pinned-corpus snapshotting and indexing.
 *
 * Each gold-set version pairs with a `corpus.toml` that names the repo
 * and the exact commit sha. The harness materialises that sha into a
 * temp directory (cheap via `git worktree add` when a clone is local,
 * `git clone` + `checkout` otherwise) and runs loctx's indexer against
 * it. Determinism check: hashes the chunk-boundary set after indexing
 * and surfaces the digest in the run JSON so two runs against the same
 * corpus can be compared byte-for-byte. See "Chunking determinism" in
 * the eval-harness plan.
 */

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type Config,
  type Project,
  type Runtime,
  buildRuntime,
  loadConfig,
  makeProject,
} from "@loctx/core";
import { parseCorpusToml } from "./toml.js";
import type { CorpusConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export class CorpusError extends Error {}

export function loadCorpusConfig(path: string): CorpusConfig {
  const text = readFileSync(path, "utf-8");
  return parseCorpusToml(text, path);
}

/**
 * Resolve a repo string to a usable git source. Strategy:
 *
 *   1. If the string is a path that exists on disk and contains `.git`,
 *      use it as a local source — fastest, no network.
 *   2. Otherwise, assume an URL and clone into the temp dir.
 *
 * Local-clone preference matters because the v1 corpus is the loctx
 * repo itself; the worktree we're running inside already has the
 * commit graph, no need to round-trip to GitHub.
 */
export function resolveGitSource(
  repo: string,
  searchRoots: ReadonlyArray<string>,
):
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "url"; readonly url: string } {
  // Direct path
  const absRepo = resolve(repo);
  if (existsSync(absRepo) && existsSync(join(absRepo, ".git"))) {
    return { kind: "local", path: absRepo };
  }
  // Search-root probes: walk each up to the filesystem root looking
  // for a `.git`. Picks up CI checkouts, dev clones run from any
  // subdirectory, and worktree siblings without forcing the caller
  // to compute the repo root themselves.
  for (const start of searchRoots) {
    const root = findRepoRoot(start);
    if (root !== null) return { kind: "local", path: root };
  }
  return { kind: "url", url: repo };
}

function findRepoRoot(start: string): string | null {
  let cur = resolve(start);
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = resolve(cur, "..");
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

export interface CorpusSnapshot {
  readonly root: string;
  readonly cleanup: () => void;
}

/**
 * Materialise the corpus's pinned sha into a temp dir. Uses
 * `git worktree add --detach` against a local source when possible
 * (no extra disk for the object DB), otherwise a shallow clone +
 * checkout. Returns a cleanup function the caller must invoke when
 * done — leaving a `git worktree` registered without cleanup will
 * make a future `git worktree prune` warn about it.
 */
export async function snapshotCorpus(
  corpus: CorpusConfig,
  searchRoots: ReadonlyArray<string>,
): Promise<CorpusSnapshot> {
  const tmpRoot = join(
    tmpdir(),
    `loctx-eval-corpus-${corpus.name}-${corpus.sha.slice(0, 12)}-${process.pid}`,
  );
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });

  const source = resolveGitSource(corpus.repo, searchRoots);
  const worktreePath = join(tmpRoot, "checkout");
  if (source.kind === "local") {
    try {
      await execFileAsync("git", [
        "-C",
        source.path,
        "worktree",
        "add",
        "--detach",
        worktreePath,
        corpus.sha,
      ]);
    } catch (err) {
      const msg = (err as Error).message;
      throw new CorpusError(
        `git worktree add ${worktreePath} ${corpus.sha} failed (from ${source.path}): ${msg}`,
      );
    }
    return Object.freeze({
      root: worktreePath,
      cleanup: () => {
        // Best-effort: remove the worktree registration first so the
        // source repo doesn't accumulate "prunable" entries, then
        // drop the tmp dir. We swallow worktree-remove failures —
        // the rmSync still cleans the filesystem either way, and a
        // user can always `git worktree prune` to clear stale refs.
        try {
          execFileSync("git", ["-C", source.path, "worktree", "remove", "--force", worktreePath], {
            stdio: "ignore",
          });
        } catch {
          // Intentional — see comment above.
        }
        rmSync(tmpRoot, { recursive: true, force: true });
      },
    });
  }

  // URL clone fallback. We don't shallow-clone because the user-specified
  // sha may not be the tip; a full clone is simpler than `--depth 1`
  // + `git fetch <sha>` (the latter requires uploadpack.allowReachableSHA1InWant).
  try {
    await execFileAsync("git", ["clone", source.url, worktreePath]);
    await execFileAsync("git", ["-C", worktreePath, "checkout", "--detach", corpus.sha]);
  } catch (err) {
    throw new CorpusError(
      `git clone ${source.url} → ${worktreePath} (sha ${corpus.sha}) failed: ${(err as Error).message}`,
    );
  }
  return Object.freeze({
    root: worktreePath,
    cleanup: () => rmSync(tmpRoot, { recursive: true, force: true }),
  });
}

/**
 * Build a sandboxed loctx runtime that stores its index data inside a
 * temp dir scoped to this corpus run. Forces `LOCTX_EMBEDDING_PROVIDER=fake`
 * for now: ONNX model downloads aren't a meaningful signal in eval, and
 * the deterministic fake provider is bit-exact across runs (covers the
 * "embedder nondeterminism" risk in the plan).
 *
 * The caller owns the returned runtime + dataDir cleanup — invoke
 * `closeRuntime()` to release both.
 */
export async function buildSandboxedRuntime(corpus: CorpusConfig): Promise<{
  readonly runtime: Runtime;
  readonly dataDir: string;
  readonly close: () => Promise<void>;
}> {
  const dataDir = join(
    tmpdir(),
    `loctx-eval-data-${corpus.name}-${corpus.sha.slice(0, 12)}-${process.pid}`,
  );
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  // env mutation is the documented seam for the embedding-provider
  // override. Restoring on close keeps the host process clean for
  // long-running parents (CI, parent eval driver, etc.).
  const previousProvider = process.env["LOCTX_EMBEDDING_PROVIDER"];
  const previousDataDir = process.env["LOCTX_DATA_DIR"];
  const previousConfigDir = process.env["LOCTX_CONFIG_DIR"];
  process.env["LOCTX_EMBEDDING_PROVIDER"] = "fake";
  process.env["LOCTX_DATA_DIR"] = dataDir;
  process.env["LOCTX_CONFIG_DIR"] = join(dataDir, "config");

  const config: Config = loadConfig();
  const runtime = await buildRuntime(config);

  return Object.freeze({
    runtime,
    dataDir,
    close: async () => {
      await runtime.close();
      if (previousProvider === undefined) process.env["LOCTX_EMBEDDING_PROVIDER"] = undefined;
      else process.env["LOCTX_EMBEDDING_PROVIDER"] = previousProvider;
      if (previousDataDir === undefined) process.env["LOCTX_DATA_DIR"] = undefined;
      else process.env["LOCTX_DATA_DIR"] = previousDataDir;
      if (previousConfigDir === undefined) process.env["LOCTX_CONFIG_DIR"] = undefined;
      else process.env["LOCTX_CONFIG_DIR"] = previousConfigDir;
      rmSync(dataDir, { recursive: true, force: true });
    },
  });
}

/**
 * Index a corpus checkout end-to-end. Returns the project that was
 * indexed plus a stable chunk-boundary digest for determinism checks.
 *
 * The digest covers `(rel_path, start_line, end_line)` for every chunk
 * the indexer wrote; identical across runs of the same corpus content
 * even when chunk ids (which include the chunkSha) shift around. A
 * mismatch surfaces in the run JSON as `chunkBoundaryHash` so reviewers
 * can spot non-deterministic chunking immediately.
 */
export async function indexCorpus(
  runtime: Runtime,
  corpusRoot: string,
): Promise<{ readonly project: Project; readonly chunkBoundaryHash: string }> {
  const project = makeProject(corpusRoot);
  runtime.state.upsertProjectWithActive(project, true);
  await runtime.indexer.indexProject(project);
  const boundaries = collectChunkBoundaries(runtime, project);
  return Object.freeze({ project, chunkBoundaryHash: hashBoundaries(boundaries) });
}

function collectChunkBoundaries(runtime: Runtime, project: Project): ReadonlyArray<string> {
  const files = runtime.state.listFiles(project.id);
  const out: string[] = [];
  for (const f of files) {
    const chunks = runtime.state.listChunks(f.fileId);
    for (const c of chunks) {
      out.push(`${f.relPath}:${c.startLine}-${c.endLine}`);
    }
  }
  out.sort();
  return out;
}

function hashBoundaries(boundaries: ReadonlyArray<string>): string {
  const h = createHash("sha256");
  for (const b of boundaries) h.update(`${b}\n`);
  return h.digest("hex");
}
