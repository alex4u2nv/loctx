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
 *
 * loctx never redistributes weights: the user downloads straight from
 * Hugging Face and accepts the model provider's license. That's why each
 * entry carries `license` — the CLI/UI surface it at download time so
 * non-permissive terms (e.g. Gemma) are a visible, informed choice
 * rather than a hidden one.
 */

export type EmbeddingUseCase = "code" | "mixed" | "docs";

/** How the token embeddings collapse to one vector. Must match the model
 *  card — CLS-pooled models (GTE family) produce garbage under mean. */
export type EmbeddingPooling = "mean" | "cls";

export interface EmbeddingModelInfo {
  /** Hugging Face identifier — drop into `LocalEmbeddingProvider.modelName`. */
  readonly name: string;
  /** One-line summary shown by `loctx model list`. */
  readonly description: string;
  /** Approximate on-disk size of the downloaded weights (at `dtype`) in MB. */
  readonly sizeMB: number;
  /** Embedding output dimension — must agree with the LanceDB collection. */
  readonly dimension: number;
  /** Whether the model output is L2-normalized; affects cosine vs dot semantics. */
  readonly normalize: boolean;
  /** Primary use case the model was tuned for. */
  readonly useCase: EmbeddingUseCase;
  /**
   * Model license the user accepts by downloading from HF (SPDX-ish id,
   * e.g. "apache-2.0", "mit", "gemma"). Surfaced by `loctx model list`,
   * the wizard, and the web Models tab.
   */
  readonly license: string;
  /** Pooling strategy passed to the transformers.js pipeline. */
  readonly pooling: EmbeddingPooling;
  /**
   * ONNX weight variant passed as `dtype` to transformers.js — controls
   * which file is downloaded (fp32 `model.onnx`, q8 `model_quantized.onnx`,
   * …). `sizeMB` above describes THIS variant. Changing it changes the
   * embedding values, so treat it as part of the model choice.
   */
  readonly dtype: string;
  /** Prepended to every query before embedding (asymmetric-retrieval models). */
  readonly queryPrefix?: string;
  /** Prepended to every document chunk before embedding. */
  readonly documentPrefix?: string;
}

export const EMBEDDING_REGISTRY: ReadonlyArray<EmbeddingModelInfo> = Object.freeze([
  {
    name: "Xenova/all-MiniLM-L6-v2",
    description: "Fast, decent quality. Default. 90 MB / 384-dim.",
    sizeMB: 90,
    dimension: 384,
    normalize: true,
    useCase: "mixed",
    license: "apache-2.0",
    pooling: "mean",
    dtype: "fp32",
  },
  {
    name: "Xenova/bge-small-en-v1.5",
    description: "Strong general-text retrieval. Slightly bigger than MiniLM.",
    sizeMB: 130,
    dimension: 384,
    normalize: true,
    useCase: "mixed",
    license: "mit",
    pooling: "mean",
    dtype: "fp32",
  },
  {
    name: "Xenova/all-mpnet-base-v2",
    description:
      "Higher quality on both code and prose. ~3x slower than MiniLM, ~5% more accurate.",
    sizeMB: 420,
    dimension: 768,
    normalize: true,
    useCase: "mixed",
    license: "apache-2.0",
    pooling: "mean",
    dtype: "fp32",
  },
  {
    name: "Xenova/jina-embeddings-v2-base-code",
    description: "Tuned for source code. Best for code-only workflows.",
    sizeMB: 320,
    dimension: 768,
    normalize: true,
    useCase: "code",
    license: "apache-2.0",
    pooling: "mean",
    dtype: "fp32",
  },
  {
    name: "Alibaba-NLP/gte-modernbert-base",
    description:
      "2025-gen ModernBERT: top code retrieval (CoIR 79.3) + strong prose, 8k context. 8-bit.",
    sizeMB: 150,
    dimension: 768,
    normalize: true,
    useCase: "code",
    license: "apache-2.0",
    pooling: "cls",
    dtype: "q8",
  },
  {
    name: "onnx-community/embeddinggemma-300m-ONNX",
    description:
      "Google's on-device model (Sept 2025), SOTA under 500M params. ~10x slower than MiniLM. 8-bit. Gemma license.",
    sizeMB: 310,
    dimension: 768,
    normalize: true,
    useCase: "mixed",
    license: "gemma",
    pooling: "mean",
    dtype: "q8",
    queryPrefix: "task: search result | query: ",
    documentPrefix: "title: none | text: ",
  },
]);

/** Look up a model by HF identifier. Returns null when not in the catalog. */
export function findModel(name: string): EmbeddingModelInfo | null {
  return EMBEDDING_REGISTRY.find((m) => m.name === name) ?? null;
}
