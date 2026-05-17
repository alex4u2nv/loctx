import type { Runtime } from "@loctx/core";

// Generate a single human-readable warning describing the in-flight
// reconcile, suitable for prepending to a `warnings: string[]` on
// /api/search or /api/find-usages (#44). Returns an empty array when
// the reconciler is idle so callers can spread unconditionally.
export function reconcileWarnings(runtime: Runtime): string[] {
  const s = runtime.reconciler.status();
  if (!s.running) return [];
  const fileLabel =
    s.currentProjectIndexed !== null && s.currentProjectTotal !== null
      ? `, ${s.currentProjectIndexed}/${s.currentProjectTotal} files`
      : "";
  const projectLabel = s.currentProjectName ?? "—";
  return [
    `Index reconciling (project ${s.completed + 1}/${s.total}: ${projectLabel}${fileLabel}); results may be partial until the pass completes.`,
  ];
}
