/**
 * Project indexer: discovery → filtering → chunking → embedding → storage.
 */

import { createHash } from "node:crypto";
import { type Dirent, opendirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { resolvedMarkdownLinks } from "../analyzers/index.js";
import { type CodeChunk, chunkFile, detectLanguage } from "../chunking/index.js";
import { chunkIdFor, fileIdFor } from "../discovery.js";
import type { EmbeddingProvider } from "../embeddings/index.js";
import { ignoredSubpath, type ProjectFilter } from "../filtering.js";
import { type ChunkId, type FileId, identityToString, type Project } from "../models.js";
import type {
  ChunkInsert,
  EmbeddedChunk,
  FileState,
  StateStore,
  VectorStore,
} from "../storage/index.js";
import { mapWithConcurrency } from "./concurrency.js";

export type ChunkerFn = (relPath: string, content: string) => CodeChunk[];
export type FilterFactory = (project: Project) => ProjectFilter;

export type FileIndexResult =
  | { readonly kind: "indexed"; readonly relPath: string; readonly chunks: number }
  | { readonly kind: "skipped"; readonly relPath: string; readonly reason: string }
  | { readonly kind: "error"; readonly relPath: string; readonly error: string };

export interface IndexSummary {
  readonly project: Project;
  readonly indexed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly elapsedSeconds: number;
  readonly failures: ReadonlyArray<FileIndexResult>;
  readonly total: number;
}

/**
 * Hook fired after a file is successfully (re)indexed. Used by the
 * background analyzer dispatcher in container.ts to enqueue
 * enrichments for the freshly-indexed file. Optional; skipping it
 * leaves the indexer's behavior unchanged.
 */
export type AfterFileIndexed = (event: {
  readonly project: Project;
  readonly fileId: FileId;
  readonly absPath: string;
  readonly relPath: string;
  readonly contentSha: string;
}) => void;

export interface IndexerOptions {
  readonly chunkerFn?: ChunkerFn;
  readonly afterFileIndexed?: AfterFileIndexed;
}

export class ProjectIndexer {
  private readonly chunkerFn: ChunkerFn;
  private readonly afterFileIndexed: AfterFileIndexed;
  /**
   * Per-fileId mutex covering the whole persist() sequence (SQLite +
   * LanceDB writes). Two concurrent persists for the same file — typical
   * race: watcher dispatch + reconciler walk — would otherwise interleave
   * between the state and vector writes, leaving the two stores
   * disagreeing on which chunk-set is current. Different files keep
   * their own chains so cross-file work stays parallel.
   */
  private readonly fileWriteMutex = new PerKeyMutex();

  constructor(
    public readonly state: StateStore,
    public readonly vectors: VectorStore,
    public readonly embeddings: EmbeddingProvider,
    public readonly filterFactory: FilterFactory,
    options: IndexerOptions = {},
  ) {
    this.chunkerFn = options.chunkerFn ?? chunkFile;
    this.afterFileIndexed = options.afterFileIndexed ?? (() => undefined);
  }

  // ---- public --------------------------------------------------------

  async indexProject(
    project: Project,
    options: {
      signal?: AbortSignal;
      concurrency?: number;
      /**
       * Per-file progress callback. Fires once before the first file
       * (indexed=0, total=N) so callers can render a determinate UI as
       * soon as the walk completes, then again after each file. The
       * indexer doesn't throttle — callers that care about emit volume
       * (e.g. SSE forwarders) should debounce themselves.
       */
      onProgress?: (event: { readonly indexed: number; readonly total: number }) => void;
    } = {},
  ): Promise<IndexSummary> {
    // Indexing implies activation: if the caller is invoking indexProject,
    // the project should appear in the active inventory bucket so future
    // daemon runs include it. Preserves active=true for projects that were
    // already active.
    this.state.upsertProjectWithActive(project, true);
    const filter = this.filterFactory(project);
    const started = performance.now();

    // Bounded concurrency across files. Each `indexFile` serialises
    // its own SQLite+LanceDB writes through the per-fileId mutex, so
    // parallel callers don't corrupt a single file's state. But the
    // LanceDB writer mutex underneath only orders per-call writes —
    // two concurrent files producing back-to-back `delete` +
    // `mergeInsert` ops can still leave Lance with a stale fragment
    // reference if the file-level reordering happens to interleave
    // unfortunately (observed in the Playwright e2e fixture). Until
    // we add coarser write coordination, default to sequential
    // (concurrency=1) and let opt-in callers raise it. See #204.
    //
    // Cancellation: check `options.signal` before pulling each file
    // so a user who activates → immediately deactivates a project
    // doesn't burn the remaining files through the embedder (#217).
    const paths: string[] = [];
    for (const absPath of iterFiles(project.root, filter.rules.ignoredDirs)) {
      paths.push(absPath);
    }
    const concurrency = Math.max(1, options.concurrency ?? 1);
    const { onProgress } = options;
    onProgress?.({ indexed: 0, total: paths.length });
    // Count-based progress is monotonically increasing under any
    // concurrency since the increment is serial within the worker
    // pool's awaited microtask.
    let completed = 0;
    const { results, aborted } = await mapWithConcurrency(
      paths,
      concurrency,
      async (absPath) => {
        const result = await this.indexFile(project, absPath, { filter });
        completed += 1;
        onProgress?.({ indexed: completed, total: paths.length });
        return result;
      },
      options.signal,
    );

    const indexed = results.filter((r) => r.kind === "indexed").length;
    const skipped = results.filter((r) => r.kind === "skipped").length;
    const failures = results.filter((r) => r.kind === "error");

    // Stamp last_indexed_at only on a complete pass. An aborted pass
    // produces a partial summary the caller can inspect; the reconciler
    // will pick up the unindexed files on its next run.
    if (!aborted) this.state.markProjectIndexed(project.id);
    return Object.freeze({
      project,
      indexed,
      skipped,
      failed: failures.length,
      elapsedSeconds: (performance.now() - started) / 1000,
      failures: Object.freeze(failures),
      total: results.length,
    });
  }

  async indexFile(
    project: Project,
    absPath: string,
    options: { filter?: ProjectFilter } = {},
  ): Promise<FileIndexResult> {
    const rel = relative(resolve(project.root), resolve(absPath));
    if (rel.startsWith("..")) {
      return { kind: "error", relPath: absPath, error: "outside-project" };
    }
    const relPath = rel.split(sep).join("/");

    const filter = options.filter ?? this.filterFactory(project);
    const decision = filter.shouldIndex(absPath);
    if (!decision.shouldIndex) {
      return { kind: "skipped", relPath, reason: decision.reason };
    }

    let contentBytes: Buffer;
    try {
      contentBytes = readFileSync(absPath);
    } catch (err) {
      const message = `read-error: ${(err as Error).message}`;
      // Persist the failure on the file row so doctor can surface
      // persistent I/O issues (permission denied, deleted-between-stat-
      // and-open, etc.) instead of silently skipping. Existing file
      // metadata is preserved as a best-guess; the error field is the
      // signal that gets read back by isUnchanged() to force a retry
      // once the disk issue clears. See #184.
      this.recordReadError(project, relPath, message);
      return { kind: "error", relPath, error: message };
    }

    const content = decodeUtf8(contentBytes);
    if (content === null) {
      return { kind: "skipped", relPath, reason: "not-utf8" };
    }

    const contentSha = createHash("sha256").update(contentBytes).digest("hex");
    const identityStr = identityToString(this.embeddings.identity);

    if (this.isUnchanged(project, relPath, contentSha, identityStr)) {
      return { kind: "skipped", relPath, reason: "unchanged" };
    }

    const chunks = this.chunkerFn(relPath, content);
    if (chunks.length === 0) {
      return { kind: "skipped", relPath, reason: "empty" };
    }

    await this.persist(project, relPath, chunks, contentSha, identityStr, absPath);
    return { kind: "indexed", relPath, chunks: chunks.length };
  }

  async deleteFile(project: Project, relPath: string): Promise<void> {
    await this.vectors.deleteFileChunks(project.id, relPath);
    this.state.deleteFile(project.id, relPath);
  }

  /**
   * Re-evaluate every indexed file against a freshly-built ProjectFilter
   * and prune anything that's now excluded (#89). Used when an ignore
   * rule changes — `.loctxignore`, `.gitignore`, or `.git/info/exclude`
   * — to keep the index consistent with current intent without waiting
   * for a full re-walk.
   *
   * Re-inclusion of newly un-ignored files is NOT done here: those
   * re-enter via the normal watcher add/change path or the next full
   * `indexProject` pass. Per the issue scope.
   *
   * Returns counts the watcher logs at debug verbosity.
   */
  async reevaluateFilter(project: Project): Promise<{
    readonly checked: number;
    readonly pruned: number;
    readonly prunedRelPaths: ReadonlyArray<string>;
  }> {
    const filter = this.filterFactory(project);
    const indexedFiles = this.state.listFiles(project.id);
    const pruned: string[] = [];
    for (const file of indexedFiles) {
      const decision = filter.shouldIndex(join(project.root, file.relPath));
      if (!decision.shouldIndex) {
        await this.deleteFile(project, file.relPath);
        pruned.push(file.relPath);
      }
    }
    return Object.freeze({
      checked: indexedFiles.length,
      pruned: pruned.length,
      prunedRelPaths: Object.freeze(pruned),
    });
  }

  // ---- internals -----------------------------------------------------

  /**
   * Stamp a failed read on the file row so doctor and downstream tools
   * can see persistent I/O failures. Existing metadata (size, mtime,
   * sha) is preserved when we have a previous row to avoid losing
   * context; otherwise we write a minimal placeholder. Returns
   * silently on any state write failure — we're already on the error
   * path and don't want to mask the original read error.
   */
  private recordReadError(project: Project, relPath: string, message: string): void {
    const fileId = fileIdFor(project, relPath);
    const previous = this.state.getFile(project.id, relPath);
    try {
      this.state.upsertFile({
        fileId,
        projectId: project.id,
        relPath,
        size: previous?.size ?? 0,
        mtime: previous?.mtime ?? 0,
        contentSha: previous?.contentSha ?? "",
        indexedAt: new Date().toISOString(),
        embeddingIdentity:
          previous?.embeddingIdentity ?? identityToString(this.embeddings.identity),
        error: message,
      });
    } catch (e) {
      console.error(
        `[indexer] could not record read error for ${relPath}: ${(e as Error).message}`,
      );
    }
  }

  private isUnchanged(
    project: Project,
    relPath: string,
    contentSha: string,
    identityStr: string,
  ): boolean {
    const existing = this.state.getFile(project.id, relPath);
    return (
      existing !== null &&
      existing.error === null &&
      existing.contentSha === contentSha &&
      existing.embeddingIdentity === identityStr
    );
  }

  private async persist(
    project: Project,
    relPath: string,
    chunks: CodeChunk[],
    contentSha: string,
    identityStr: string,
    absPath: string,
  ): Promise<void> {
    const fileId = fileIdFor(project, relPath);
    // Embedding work happens outside the mutex — it's CPU/GPU-bound and
    // doesn't touch storage, so blocking other files behind it would
    // cost throughput. The mutex guards only the actual writes below.
    const embeddings = await this.embeddings.embedDocuments(chunks.map((c) => c.content));
    const language = detectLanguage(relPath) ?? "";

    const embedded: EmbeddedChunk[] = chunks.map((c, i) => {
      const cid: ChunkId = chunkIdFor(fileId, c.startLine, c.endLine, c.chunkSha);
      const embedding = embeddings[i];
      if (embedding === undefined) {
        throw new Error(`Missing embedding for chunk ${i} of ${relPath}`);
      }
      return {
        chunkId: cid,
        fileId,
        projectId: project.id,
        relPath,
        embedding,
        document: c.content,
        metadata: {
          language,
          kind: c.kind,
          start_line: c.startLine,
          end_line: c.endLine,
          symbols: c.symbols.join(","),
        },
      };
    });

    const chunkInserts: ChunkInsert[] = embedded.map((ec, i) => {
      const c = chunks[i];
      if (c === undefined) throw new Error("chunk index out of range");
      return {
        chunkId: ec.chunkId,
        fileId,
        projectId: project.id,
        relPath,
        startLine: c.startLine,
        endLine: c.endLine,
        kind: c.kind,
        symbols: c.symbols,
        document: c.content,
        ...(c.analyzer !== undefined ? { analyzer: c.analyzer } : {}),
        ...(c.symbols.length > 0 && c.symbols[0] !== undefined ? { symbolDef: c.symbols[0] } : {}),
        ...(c.symbolRefs !== undefined && c.symbolRefs.length > 0
          ? { symbolRefs: c.symbolRefs }
          : {}),
      };
    });

    const stat = statSync(absPath);
    const fileState: FileState = {
      fileId,
      projectId: project.id,
      relPath,
      size: stat.size,
      mtime: stat.mtimeMs / 1000,
      contentSha,
      indexedAt: new Date().toISOString(),
      embeddingIdentity: identityStr,
      error: null,
    };

    // All writes for `fileId` run as one critical section. Order matters:
    // SQLite is the system of record (it owns the `contentSha` that
    // marks a file as up-to-date), and LanceDB is a derived index. By
    // writing state first and stamping `upsertFile` last, a crash leaves
    // the file's row pointing at the *old* sha; the next reconciler pass
    // sees the mismatch and retries the whole sequence idempotently. The
    // alternative (vectors first) could leave orphan vectors invisible
    // to reconciliation. See #188, #193.
    await this.fileWriteMutex.runExclusive(fileId, async () => {
      this.state.replaceChunks(fileId, chunkInserts);
      await this.vectors.deleteFileChunks(project.id, relPath);
      await this.vectors.upsertChunks(embedded);
      // Stamp the file row last — this is the "commit" marker that a
      // future reconciler uses to decide the file is up-to-date.
      this.state.upsertFile(fileState);
      // Record the file's outbound markdown links (doc cross-link graph, #427)
      // so authority ranking can count inbound references. Markdown only; links
      // live in the chunk bodies. MUST run after upsertFile: file_links has a
      // FK to files(file_id), so the file row has to exist first (#eval).
      if (/\.(md|markdown)$/i.test(relPath)) {
        const body = chunks.map((c) => c.content).join("\n");
        this.state.replaceFileLinks(fileId, resolvedMarkdownLinks(body, dirname(absPath)));
      }
    });

    // Background analyzer enrichment hook (#61, #62, #64, #65). Synchronous
    // — handler is expected to enqueue work without blocking. Wrapped in
    // try/catch so a misbehaving dispatcher cannot break indexing.
    try {
      this.afterFileIndexed({
        project,
        fileId,
        absPath,
        relPath,
        contentSha,
      });
    } catch (err) {
      console.error(`[indexer] afterFileIndexed hook threw: ${(err as Error).message}`);
    }
  }
}

/**
 * Per-key serialization primitive. Each unique key gets its own FIFO
 * chain of pending tasks; callers with different keys run in parallel.
 * The chain entry is cleaned up once the last waiter resolves so the
 * map size tracks live keys only.
 *
 * Used by ProjectIndexer to serialize all writes for a single fileId
 * (vectors + state) without blocking work on other files.
 */
class PerKeyMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const result = prev.then(fn);
    // Continue the chain whether fn rejects or resolves so one failing
    // call doesn't deadlock subsequent waiters on the same key.
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, settled);
    // Drop the entry once this run is the tail and has settled — keeps
    // the map size bounded to the number of live, in-flight keys.
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return result;
  }
}

// ---- helpers ----------------------------------------------------------

function decodeUtf8(buf: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

function* iterFiles(root: string, ignoredDirs: ReadonlySet<string>): Generator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;

    let entries: Dirent[];
    try {
      const handle = opendirSync(dir);
      entries = [];
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        entries.push(entry);
      }
      handle.closeSync();
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const subdirs: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        const full = join(dir, entry.name);
        // Path-specific prune (e.g. `.claude/worktrees`): basename matching
        // can't express it, so check the segments relative to the root.
        if (ignoredSubpath(relative(root, full).split(sep)) !== null) continue;
        subdirs.push(full);
      } else if (entry.isFile()) {
        yield join(dir, entry.name);
      }
    }
    // Push in reverse so we pop in alphabetical order. subdirs is local —
    // mutating it in place is fine, and reads more cleanly than an index loop.
    stack.push(...subdirs.reverse());
  }
}
