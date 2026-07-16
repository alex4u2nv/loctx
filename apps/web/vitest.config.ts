import { defineConfig } from "vitest/config";

// Server-side unit tests only. The Playwright E2E suite lives under
// tests/e2e/*.spec.ts and is run separately via `pnpm test:e2e`; keeping
// the vitest include narrow avoids vitest trying to collect the
// browser-driven specs (different runner, different globals).
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
