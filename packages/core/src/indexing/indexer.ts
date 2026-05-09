/**
 * Project indexer: discovery → filtering → chunking → embedding → storage.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { type Dirent, opendirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { type CodeChunk, chunkFile, detectLanguage } from "../chunking/index.js";
import { chunkIdFor, fileIdFor } from "../discovery.js";
import type { EmbeddingProvider } from "../embeddings/index.js";
import type { ProjectFilter } from "../filtering.js";
import { type ChunkId, type Project, identityToString } from "../models.js";
import type {
  ChunkState,
  EmbeddedChunk,
  FileState,
  StateStore,
  VectorStore,
} from "../storage/index.js";

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

export interface IndexerOptions {
  readonly chunkerFn?: ChunkerFn;
}

export class ProjectIndexer {
  private readonly chunkerFn: ChunkerFn;

  constructor(
    public readonly state: StateStore,
    public readonly vectors: VectorStore,
    public readonly embeddings: EmbeddingProvider,
    public readonly filterFactory: FilterFactory,
    options: IndexerOptions = {},
  ) {
    this.chunkerFn = options.chunkerFn ?? chunkFile;
  }

  // ---- public --------------------------------------------------------

  async indexProject(project: Project): Promise<IndexSummary> {
    this.state.upsertProject(project);
    const filter = this.filterFactory(project);
    const started = performance.now();

    // Sequential by design: parallelizing across the embedding model would
    // amplify GPU/CPU pressure without bounding it. Collect results first,
    // then tally — counters drop out of pure filters over the discriminated
    // union, no mutation.
    const results: FileIndexResult[] = [];
    for (const absPath of iterFiles(project.root, filter.rules.ignoredDirs)) {
      results.push(await this.indexFile(project, absPath, { filter }));
    }

    const indexed = results.filter((r) => r.kind === "indexed").length;
    const skipped = results.filter((r) => r.kind === "skipped").length;
    const failures = results.filter((r) => r.kind === "error");

    this.state.markProjectIndexed(project.id);
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
      return { kind: "error", relPath, error: `read-error: ${(err as Error).message}` };
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

  // ---- internals -----------------------------------------------------

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

    await this.vectors.deleteFileChunks(project.id, relPath);
    await this.vectors.upsertChunks(embedded);

    const chunkStates: ChunkState[] = embedded.map((ec, i) => {
      const c = chunks[i];
      if (c === undefined) throw new Error("chunk index out of range");
      return {
        chunkId: ec.chunkId,
        fileId,
        startLine: c.startLine,
        endLine: c.endLine,
        kind: c.kind,
        symbols: c.symbols,
      };
    });
    this.state.replaceChunks(fileId, chunkStates);

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
    this.state.upsertFile(fileState);
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
        subdirs.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        yield join(dir, entry.name);
      }
    }
    // Push in reverse so we pop in alphabetical order. subdirs is local —
    // mutating it in place is fine, and reads more cleanly than an index loop.
    stack.push(...subdirs.reverse());
  }
}
