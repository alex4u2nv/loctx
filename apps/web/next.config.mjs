/** @type {import('next').NextConfig} */
const nextConfig = {
  // Transpile workspace packages so we can import them as TS source.
  transpilePackages: ["@loctx/core", "@loctx/mcp"],
  // Native + URL-import packages must run on the Node runtime, not webpack-
  // bundled. better-sqlite3 is a native binding; chromadb ships an `https://`
  // import that webpack can't handle. The pages/components that touch
  // @loctx/core must be server components.
  serverExternalPackages: [
    "better-sqlite3",
    "chromadb",
    "chokidar",
    "@huggingface/transformers",
    "onnxruntime-node",
  ],
  experimental: {
    // typedRoutes requires a Next build to populate `.next/types/...` before
    // tsc can typecheck Link hrefs. Off until the build pipeline runs Next
    // before tsc consistently.
    typedRoutes: false,
  },
};

export default nextConfig;
