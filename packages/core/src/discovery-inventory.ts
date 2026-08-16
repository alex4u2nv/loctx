/**
 * Active / inactive / orphaned project categorization (#542 split
 * from discovery.ts). Type-only imports back into discovery.ts are
 * erased at compile time, so no runtime cycle.
 */

import { statSync } from "node:fs";
import type { MarkerKind, WorkspaceDiscovery } from "./discovery.js";
import type { Project } from "./models.js";
import type { StateStore } from "./storage/state.js";

// ---- active / inactive / orphaned categorization -----------------------

export interface AbsorbedMarker {
  /** Absolute path of the inner directory carrying its own project marker. */
  readonly path: string;
  /** Forward-slash path relative to the parent project's root. */
  readonly relPath: string;
  /** Marker filename/dirname that identified the inner directory (e.g. `.git`). */
  readonly marker: string;
  readonly markerKind: MarkerKind;
}

export interface ActiveProject {
  readonly project: Project;
  readonly lastIndexedAt: string | null;
  readonly lastReconciledAt: string | null;
  /** Marker filename/dirname that identified this directory as a project. */
  readonly marker: string;
  readonly markerKind: MarkerKind;
  /**
   * Inner subdirectories carrying their own project markers that were
   * absorbed into this parent project (#286). Empty when none.
   */
  readonly absorbedMarkers: ReadonlyArray<AbsorbedMarker>;
}

/**
 * Discovered under `workspace_roots` but the user hasn't activated it.
 * Indexer/watcher/reconciler skip these; UI surfaces them with an
 * "Activate" affordance.
 */
export interface InactiveProject {
  readonly project: Project;
  readonly marker: string;
  readonly markerKind: MarkerKind;
  /** True when a state row already exists with active=0 (vs. never recorded). */
  readonly known: boolean;
}

export interface OrphanedProject {
  readonly project: Project;
  readonly lastIndexedAt: string | null;
  readonly lastReconciledAt: string | null;
  /** False if the recorded `root` no longer exists on disk. */
  readonly rootExists: boolean;
  /**
   * Why this project is no longer active. "outside-roots" — recorded root
   * isn't reachable from any configured workspace_root. "missing" — recorded
   * root path doesn't exist on disk anymore.
   */
  readonly reason: "outside-roots" | "missing";
}

export interface ProjectInventory {
  readonly active: ReadonlyArray<ActiveProject>;
  readonly inactive: ReadonlyArray<InactiveProject>;
  readonly orphaned: ReadonlyArray<OrphanedProject>;
}

/**
 * Categorise every project the daemon knows about into three buckets:
 *
 *   - **active**: discovered under `workspace_roots` AND has a state row
 *     with `active=1`. These are the ones the indexer / watcher /
 *     reconciler operate on.
 *   - **inactive**: discovered AND (no state row OR `active=0`). User
 *     hasn't opted in yet; they show up in the UI with an "Activate"
 *     button.
 *   - **orphaned**: in state but no longer discoverable. Either
 *     `workspace_roots` shrank ("outside-roots") or the directory was
 *     deleted on disk ("missing"). Search still hits these; nothing
 *     else does.
 */
export function inventoryProjects(
  discovery: WorkspaceDiscovery,
  state: StateStore,
): ProjectInventory {
  const recorded = state.listProjects();
  const recordedById = new Map(recorded.map((r) => [r.id, r]));
  const discovered = discovery.discoverWithMarkers();
  const discoveredIds = new Set(discovered.map((h) => h.project.id));

  const active: ActiveProject[] = [];
  const inactive: InactiveProject[] = [];

  for (const hit of discovered) {
    const r = recordedById.get(hit.project.id);
    if (r?.active) {
      active.push({
        project: hit.project,
        lastIndexedAt: r.lastIndexedAt,
        lastReconciledAt: r.lastReconciledAt,
        marker: hit.marker,
        markerKind: hit.markerKind,
        absorbedMarkers: discovery.findAbsorbedMarkers(hit.project.root),
      });
    } else {
      inactive.push({
        project: hit.project,
        marker: hit.marker,
        markerKind: hit.markerKind,
        known: r !== undefined,
      });
    }
  }

  const orphaned: OrphanedProject[] = recorded
    .filter((r) => !discoveredIds.has(r.id))
    .map((r) => {
      const rootExists = isDir(r.root);
      return {
        project: { id: r.id, name: r.name, root: r.root },
        lastIndexedAt: r.lastIndexedAt,
        lastReconciledAt: r.lastReconciledAt,
        rootExists,
        reason: rootExists ? ("outside-roots" as const) : ("missing" as const),
      };
    })
    // Stable ordering: orphaned by root path.
    .sort((a, b) => a.project.root.localeCompare(b.project.root));

  return Object.freeze({
    active: Object.freeze(active),
    inactive: Object.freeze(inactive),
    orphaned: Object.freeze(orphaned),
  });
}

/** True when the path exists and is a directory (races tolerated). */
function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
