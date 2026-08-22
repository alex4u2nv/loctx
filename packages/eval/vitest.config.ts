import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup-git-guard.ts"],
    testTimeout: 30_000,
  },
});
