export { type EmbeddingProvider, FakeEmbeddingProvider } from "./base.js";
export { DEFAULT_LOCAL_MODEL, LocalEmbeddingProvider } from "./local.js";
export {
  type EmbeddingModelInfo,
  type EmbeddingUseCase,
  EMBEDDING_REGISTRY,
  findModel,
} from "./registry.js";
