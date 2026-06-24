/**
 * Programmatic API surface for `@loctx/eval`. Mirrors the CLI verbs so
 * a Node test or higher-level driver can call them directly without
 * shelling out.
 */

export { compareCommand } from "./cmd/compare.js";
export { indexCommand } from "./cmd/index.js";
export { reportCommand, resolveRunJson } from "./cmd/report.js";
export { runCommand } from "./cmd/run.js";
export * from "./corpus.js";
export * from "./metrics.js";
export * from "./qrels.js";
export * from "./report.js";
export * from "./runner.js";
export * from "./toml.js";
export * from "./trec.js";
export * from "./types.js";
