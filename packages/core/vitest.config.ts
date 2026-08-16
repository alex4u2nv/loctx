import { defineConfig } from "vitest/config";
import { workspaceTest } from "../../vitest.shared";

export default defineConfig({ test: workspaceTest() });
