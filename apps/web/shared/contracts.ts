/**
 * Wire types shared by the Hono server and the React SPA. No runtime
 * imports — keep this file dependency-free so both sides can pull it
 * without dragging in @loctx/core (which the client must not bundle).
 * `import type` from workspace packages is fine: type-only imports are
 * erased at compile time and never reach the client bundle.
 * Split into per-domain modules under contracts/ (#542); this file
 * is the re-export barrel so `@shared/contracts` imports stay valid.
 */

export * from "./contracts/agent-setup.js";
export * from "./contracts/config.js";
export * from "./contracts/doctor.js";
export * from "./contracts/duplicates.js";
export * from "./contracts/ops.js";
export * from "./contracts/projects.js";
export * from "./contracts/quality.js";
export * from "./contracts/search.js";
export * from "./contracts/status.js";
export * from "./contracts/tools.js";
