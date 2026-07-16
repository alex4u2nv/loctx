import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const PROXY_TARGET = process.env.LOCTX_DEV_API ?? "http://localhost:3022";

export default defineConfig({
  root: "client",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "client"),
      "@shared": resolve(__dirname, "shared"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: PROXY_TARGET, changeOrigin: true },
      "/mcp": { target: PROXY_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: resolve(__dirname, "dist/client"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        // Pin the React runtime into its own vendor chunk (#458) so a
        // change to a route component doesn't churn the framework bytes
        // — the vendor chunk hash stays stable and browsers keep it
        // cached across deploys. shiki is already isolated via dynamic
        // import (lib/highlight.ts), so it stays out of this.
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
});
