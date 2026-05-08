/**
 * Chroma-backed vector store with collection identity guards.
 *
 * The chromadb client is loaded lazily so importing this module is cheap.
 */

import { mkdirSync } from "node:fs";
import {
  type ChunkId,
  type EmbeddingIdentity,
  type FileId,
  type ProjectId,
  collectionSuffix,
  identityToString,
} from "../models.js";
import type { StateStore } from "./state.js";

const COLLECTION_PREFIX = "loctx_";

export interface EmbeddedChunk {
  readonly chunkId: ChunkId;
  readonly fileId: FileId;
  readonly projectId: ProjectId;
  readonly relPath: string;
  readonly embedding: ReadonlyArray<number>;
  readonly document: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface VectorQuery {
  readonly embedding: ReadonlyArray<number>;
  readonly k?: number;
  readonly where?: Readonly<Record<string, unknown>>;
}

export interface VectorMatch {
  readonly chunkId: string;
  readonly score: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly document: string;
}

export function collectionNameFor(identity: EmbeddingIdentity): string {
  return `${COLLECTION_PREFIX}${collectionSuffix(identity)}`;
}

type ChromaCollection = {
  upsert(args: {
    ids: string[];
    embeddings: number[][];
    metadatas: Record<string, unknown>[];
    documents: string[];
  }): Promise<void>;
  delete(args: { where: Record<string, unknown> }): Promise<void>;
  query(args: {
    queryEmbeddings: number[][];
    nResults?: number;
    where?: Record<string, unknown>;
  }): Promise<{
    ids: string[][];
    distances: number[][] | null;
    metadatas: Record<string, unknown>[][] | null;
    documents: string[][] | null;
  }>;
  count(): Promise<number>;
};

export class VectorStore {
  private collection: ChromaCollection | null = null;
  public readonly collectionName: string;

  constructor(
    public readonly chromaDir: string,
    public readonly identity: EmbeddingIdentity,
    private readonly state: StateStore,
  ) {
    mkdirSync(chromaDir, { recursive: true });
    this.collectionName = collectionNameFor(identity);
    state.registerCollection(this.collectionName, identity);
  }

  /** Lazy: opens the Chroma client + collection on first use. */
  private async ready(): Promise<ChromaCollection> {
    if (this.collection !== null) return this.collection;
    const { ChromaClient } = (await import("chromadb")) as unknown as {
      ChromaClient: new (args: { path: string }) => {
        getOrCreateCollection(args: {
          name: string;
          metadata: Record<string, unknown>;
        }): Promise<ChromaCollection>;
      };
    };
    const client = new ChromaClient({ path: this.chromaDir });
    this.collection = await client.getOrCreateCollection({
      name: this.collectionName,
      metadata: {
        "loctx.identity": identityToString(this.identity),
        "loctx.provider": this.identity.provider,
        "loctx.model": this.identity.model,
        "loctx.dimension": this.identity.dimension,
        "loctx.normalize": this.identity.normalize,
      },
    });
    return this.collection;
  }

  async count(): Promise<number> {
    return (await this.ready()).count();
  }

  async upsertChunks(chunks: ReadonlyArray<EmbeddedChunk>): Promise<void> {
    if (chunks.length === 0) return;
    const collection = await this.ready();
    await collection.upsert({
      ids: chunks.map((c) => c.chunkId),
      embeddings: chunks.map((c) => [...c.embedding]),
      metadatas: chunks.map((c) => ({
        project_id: c.projectId,
        file_id: c.fileId,
        rel_path: c.relPath,
        ...c.metadata,
      })),
      documents: chunks.map((c) => c.document),
    });
  }

  async deleteFileChunks(projectId: ProjectId, relPath: string): Promise<void> {
    const collection = await this.ready();
    await collection.delete({
      where: { $and: [{ project_id: projectId }, { rel_path: relPath }] },
    });
  }

  async deleteProjectChunks(projectId: ProjectId): Promise<void> {
    const collection = await this.ready();
    await collection.delete({ where: { project_id: projectId } });
  }

  async query(request: VectorQuery): Promise<VectorMatch[]> {
    const collection = await this.ready();
    const result = await collection.query({
      queryEmbeddings: [[...request.embedding]],
      nResults: Math.max(1, request.k ?? 10),
      ...(request.where !== undefined ? { where: request.where } : {}),
    });
    const ids = result.ids[0] ?? [];
    if (ids.length === 0) return [];
    const distances = result.distances?.[0] ?? new Array(ids.length).fill(0);
    const metadatas = result.metadatas?.[0] ?? new Array(ids.length).fill({});
    const documents = result.documents?.[0] ?? new Array(ids.length).fill("");

    return ids.map((id, i) => ({
      chunkId: id,
      score: 1 - (distances[i] ?? 0),
      metadata: metadatas[i] ?? {},
      document: documents[i] ?? "",
    }));
  }
}
