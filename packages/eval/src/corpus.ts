/**
 * Pinned-corpus snapshotting and indexing.
 *
 * Each gold-set version pairs with a `corpus.toml` that names the repo
 * and the exact commit sha. The harness materialises that sha into a
 * temp directory (cheap via `git worktree add` when a clone is local,
 * `git clone` + `checkout` otherwise) and runs loctx's indexer against
 * it. Determinism check: hashes the chunk-boundary set after indexing
 * and surfaces the digest in the run JSON so two runs against the same
 * corpus can be compared byte-for-byte.
 */

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildRuntime,
  type Config,
  loadConfig,
  makeProject,
  type Project,
  type Runtime,
} from "@loctx/core";
import { errorMessage } from "./errors.js";
import { parseCorpusToml } from "./toml.js";
import type { CorpusConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export class CorpusError extends Error {}

/**
 * `packages/eval/golden` — resolved relative to this module so it works
 * from `src/` (tsx dev) and `dist/` (built) alike. Single definition
 * (CLI-3, 2026-08-06 audit); the cmd modules used to each recompute it.
 */
export const DEFAULT_GOLDEN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "golden");

export interface GoldenSetOptions {
  readonly goldenSet: string;
  readonly goldenRoot?: string;
}

/** Directory of one gold-set version (`<goldenRoot>/<goldenSet>`). */
export function goldenSetDir(options: GoldenSetOptions): string {
  return join(options.goldenRoot ?? DEFAULT_GOLDEN_ROOT, options.goldenSet);
}

/** Everything a command callback needs after the corpus is indexed. */
export interface CorpusRuntimeContext {
  readonly corpus: CorpusConfig;
  readonly setDir: string;
  readonly runtime: Runtime;
  readonly project: Project;
  readonly chunkBoundaryHash: string;
}

/**
 * Own the corpus lifecycle for one eval command (CLI-3, 2026-08-06
 * audit): resolve the gold-set dir, load `corpus.toml`, snapshot the
 * pinned sha, build the sandboxed runtime, index the checkout, run
 * `fn`, and tear everything down in reverse order — the ~16-line
 * preamble/teardown that `index`, `run`, and `validate` each repeated.
 */
export async function withCorpusRuntime<T>(
  options: GoldenSetOptions,
  fn: (ctx: CorpusRuntimeContext) => Promise<T>,
): Promise<T> {
  const setDir = goldenSetDir(options);
  const corpus = loadCorpusConfig(join(setDir, "corpus.toml"));
  // Search-roots probe: the worktree we're running in, plus its parent
  // (the parent loctx clone). Either may be a usable local git source
  // even when corpus.repo points to a public URL.
  const searchRoots = [process.cwd(), resolve(process.cwd(), "..")];
  const snap = await snapshotCorpus(corpus, searchRoots);
  let runtimeBox: Awaited<ReturnType<typeof buildSandboxedRuntime>> | undefined;
  try {
    runtimeBox = await buildSandboxedRuntime(corpus);
    const { runtime } = runtimeBox;
    const { project, chunkBoundaryHash } = await indexCorpus(runtime, snap.root);
    return await fn({ corpus, setDir, runtime, project, chunkBoundaryHash });
  } finally {
    if (runtimeBox !== undefined) await runtimeBox.close();
    snap.cleanup();
  }
}

export function loadCorpusConfig(path: string): CorpusConfig {
  const text = readFileSync(path, "utf-8");
  return parseCorpusToml(text, path);
}

/**
 * Resolve a repo string to a usable git source. Strategy:
 *
 *   1. If the string is a path that exists on disk and contains `.git`,
 *      use it as a local source — fastest, no network.
 *   2. Otherwise probe the search roots for a local checkout — but only
 *      accept one that actually contains the pinned `sha` (#468).
 *   3. Failing both, treat `repo` as a URL and clone.
 *
 * The local-source preference matters because the v1 corpus is the
 * loctx repo itself; the worktree we're running inside already has the
 * commit graph, no need to round-trip to GitHub.
 *
 * The sha-containment guard is the fix for #468: without it, the
 * search-root probe bound the *nearest* `.git` ancestor as the corpus
 * source regardless of which repo it was. A v2 gold set pinning a
 * different public repo, run from inside a loctx checkout, would resolve
 * the local loctx repo and then fail at `git worktree add <foreign-sha>`
 * with a confusing CorpusError. Checking "does this local repo contain
 * the sha" is more robust than matching remote URLs, which trips on SSH
 * host aliases (this repo's own remote is `git@alex:…`, not github.com,
 * yet still contains the v1 sha).
 */
export function resolveGitSource(
  repo: string,
  searchRoots: ReadonlyArray<string>,
  sha?: string,
):
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "url"; readonly url: string } {
  const usableLocal = (root: string): boolean => sha === undefined || repoContainsCommit(root, sha);
  // Direct path
  const absRepo = resolve(repo);
  if (existsSync(absRepo) && existsSync(join(absRepo, ".git")) && usableLocal(absRepo)) {
    return { kind: "local", path: absRepo };
  }
  // Search-root probes: walk each up to the filesystem root looking
  // for a `.git`. Picks up CI checkouts, dev clones run from any
  // subdirectory, and worktree siblings without forcing the caller
  // to compute the repo root themselves — but only when the found
  // repo can actually satisfy the pinned sha.
  for (const start of searchRoots) {
    const root = findRepoRoot(start);
    if (root !== null && usableLocal(root)) return { kind: "local", path: root };
  }
  return { kind: "url", url: repo };
}

/**
 * process.env minus git's repo-override variables (#530). Hooks run
 * from a linked worktree (lefthook pre-push) export GIT_DIR /
 * GIT_WORK_TREE / GIT_INDEX_FILE, and those OVERRIDE `-C` — every git
 * call below would silently operate on the hook's repo instead of the
 * one it was pointed at, making resolveGitSource report "sha not
 * found" and fall back to a URL clone.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const { GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...rest } = process.env;
  void GIT_DIR;
  void GIT_WORK_TREE;
  void GIT_INDEX_FILE;
  return rest;
}

/** True when `root` is a git repo whose object DB contains `sha` as a commit. */
function repoContainsCommit(root: string, sha: string): boolean {
  try {
    execFileSync("git", ["-C", root, "cat-file", "-e", `${sha}^{commit}`], {
      stdio: "ignore",
      env: gitEnv(),
    });
    return true;
  } catch {
    return false;
  }
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

  const source = resolveGitSource(corpus.repo, searchRoots, corpus.sha);
  const worktreePath = join(tmpRoot, "checkout");
  if (source.kind === "local") {
    try {
      await execFileAsync(
        "git",
        ["-C", source.path, "worktree", "add", "--detach", worktreePath, corpus.sha],
        { env: gitEnv() },
      );
    } catch (err) {
      const msg = errorMessage(err);
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
            env: gitEnv(),
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
    await execFileAsync("git", ["clone", source.url, worktreePath], { env: gitEnv() });
    await execFileAsync("git", ["-C", worktreePath, "checkout", "--detach", corpus.sha], {
      env: gitEnv(),
    });
  } catch (err) {
    throw new CorpusError(
      `git clone ${source.url} → ${worktreePath} (sha ${corpus.sha}) failed: ${errorMessage(err)}`,
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
 * "embedder nondeterminism" risk: real models can differ across platforms).
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
      // Restore-by-delete for originally-unset vars (#466): assigning
      // `undefined` to a process.env key coerces to the STRING
      // "undefined" and keeps the key present, so the next loadConfig()
      // in this process would read LOCTX_DATA_DIR="undefined".
      restoreEnv("LOCTX_EMBEDDING_PROVIDER", previousProvider);
      restoreEnv("LOCTX_DATA_DIR", previousDataDir);
      restoreEnv("LOCTX_CONFIG_DIR", previousConfigDir);
      rmSync(dataDir, { recursive: true, force: true });
    },
  });
}

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
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

export function hashBoundaries(boundaries: ReadonlyArray<string>): string {
  const h = createHash("sha256");
  for (const b of boundaries) h.update(`${b}\n`);
  return h.digest("hex");
}
