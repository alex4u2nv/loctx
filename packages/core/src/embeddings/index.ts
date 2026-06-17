export { type EmbeddingProvider, FakeEmbeddingProvider } from "./base.js";
export { DEFAULT_LOCAL_MODEL, LocalEmbeddingProvider } from "./local.js";
export {
  EMBEDDING_REGISTRY,
  type EmbeddingModelInfo,
  type EmbeddingUseCase,
  findModel,
} from "./registry.js";
