/**
 * Shared types used across loctx modules.
 */

export type ProjectId = string & { readonly __brand: "ProjectId" };
export type FileId = string & { readonly __brand: "FileId" };
export type ChunkId = string & { readonly __brand: "ChunkId" };

export const projectId = (raw: string): ProjectId => raw as ProjectId;
export const fileId = (raw: string): FileId => raw as FileId;
export const chunkId = (raw: string): ChunkId => raw as ChunkId;

export interface Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly root: string;
}

export interface EmbeddingIdentity {
  readonly provider: string;
  readonly model: string;
  readonly dimension: number;
  readonly normalize: boolean;
}

/** Filesystem-safe slug derived from an identity, used as Chroma collection suffix. */
export function collectionSuffix(identity: EmbeddingIdentity): string {
  const provider = identity.provider.replaceAll("/", "-");
  const model = identity.model.replaceAll("/", "-");
  const norm = identity.normalize ? "n1" : "n0";
  return `${provider}__${model}__d${identity.dimension}__${norm}`;
}

export function identityToString(identity: EmbeddingIdentity): string {
  const norm = identity.normalize ? "1" : "0";
  return `${identity.provider}|${identity.model}|d=${identity.dimension}|n=${norm}`;
}
