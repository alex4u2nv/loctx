/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages and their native/URL-loading deps stay external —
  // webpack rewrites `new URL(..., import.meta.url)` in ways that break
  // Node's fileURLToPath, and chromadb/onnxruntime/better-sqlite3 must run
  // through Node's loader. Pages/components that touch @loctx/* must be
  // server components.
  serverExternalPackages: [
    "@loctx/core",
    "@loctx/mcp",
    "better-sqlite3",
    "chromadb",
    "chokidar",
    "@huggingface/transformers",
    "onnxruntime-node",
    "@modelcontextprotocol/sdk",
    "tree-sitter",
    "tree-sitter-python",
    "tree-sitter-javascript",
    "tree-sitter-typescript",
    "tree-sitter-go",
    "tree-sitter-rust",
    "tree-sitter-java",
  ],
  // Type-safe `next/link` href validation. Requires `.next/types/...` to
  // exist before tsc runs — apps/web's `typecheck` script runs `next build`
  // first to populate them. Local `npm run verify` runs build before
  // typecheck via the workspace pipeline, and CI explicitly does
  // `npm run build && npm run verify`.
  typedRoutes: true,
};

export default nextConfig;
