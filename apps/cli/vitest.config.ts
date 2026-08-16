import { defineConfig } from "vitest/config";
import { workspaceTest } from "../../vitest.shared";

// CLI integration tests spawn real daemons; generous timeouts.
export default defineConfig({ test: workspaceTest({ testTimeout: 60_000, hookTimeout: 60_000 }) });
