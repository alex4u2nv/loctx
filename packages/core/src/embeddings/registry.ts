/**
 * Curated embedding-model registry.
 *
 * Hand-picked models the `loctx model` CLI presents to users. Each entry
 * carries the HF identifier, on-disk size, vector dimension, and
 * primary use case so the wizard / model commands can recommend
 * sensibly (code-tuned vs general purpose vs higher quality).
 *
 * This is deliberately not a live HF browse — keeping it curated avoids
 * hallucinated picks and makes the install footprint predictable.
 */

export type EmbeddingUseCase = "code" | "mixed" | "docs";

export interface EmbeddingModelInfo {
  /** Hugging Face identifier — drop into `LocalEmbeddingProvider.modelName`. */
  readonly name: string;
  /** One-line summary shown by `loctx model list`. */
  readonly description: string;
  /** Approximate on-disk size of the downloaded model in MB. */
  readonly sizeMB: number;
  /** Embedding output dimension — must agree with the LanceDB collection. */
  readonly dimension: number;
  /** Whether the model output is L2-normalized; affects cosine vs dot semantics. */
  readonly normalize: boolean;
  /** Primary use case the model was tuned for. */
  readonly useCase: EmbeddingUseCase;
}

export const EMBEDDING_REGISTRY: ReadonlyArray<EmbeddingModelInfo> = Object.freeze([
  {
    name: "Xenova/all-MiniLM-L6-v2",
    description: "Fast, decent quality. Default. 90 MB / 384-dim.",
    sizeMB: 90,
    dimension: 384,
    normalize: true,
    useCase: "mixed",
  },
  {
    name: "Xenova/bge-small-en-v1.5",
    description: "Strong general-text retrieval. Slightly bigger than MiniLM.",
    sizeMB: 130,
    dimension: 384,
    normalize: true,
    useCase: "mixed",
  },
  {
    name: "Xenova/all-mpnet-base-v2",
    description:
      "Higher quality on both code and prose. ~3x slower than MiniLM, ~5% more accurate.",
    sizeMB: 420,
    dimension: 768,
    normalize: true,
    useCase: "mixed",
  },
  {
    name: "Xenova/jina-embeddings-v2-base-code",
    description: "Tuned for source code. Best for code-only workflows.",
    sizeMB: 320,
    dimension: 768,
    normalize: true,
    useCase: "code",
  },
]);

/** Look up a model by HF identifier. Returns null when not in the catalog. */
export function findModel(name: string): EmbeddingModelInfo | null {
  return EMBEDDING_REGISTRY.find((m) => m.name === name) ?? null;
}
