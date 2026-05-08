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
  // typedRoutes requires a Next build to populate `.next/types/...` before
  // tsc can typecheck Link hrefs. Off until the build pipeline runs Next
  // before tsc consistently.
  typedRoutes: false,
};

export default nextConfig;
