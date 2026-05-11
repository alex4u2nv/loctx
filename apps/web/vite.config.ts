import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const PROXY_TARGET = process.env.LOCTX_DEV_API ?? "http://localhost:3022";

export default defineConfig({
  root: "client",
  plugins: [react()],
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
  },
});
