/**
 * Shared vitest test-config shape (#543). The four workspace configs
 * were near-identical (semantic duplicate group, similarity 0.98);
 * each keeps only its real deviations — timeouts and, for web, the
 * include that excludes the Playwright specs.
 */

export function workspaceTest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { include: ["tests/**/*.test.ts"], testTimeout: 30_000, ...overrides };
}
