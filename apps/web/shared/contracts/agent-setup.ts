/**
 * agent-setup contracts (split from the 687-line contracts.ts, #542).
 */

// ---- agent setup (#agent-setup) ----------------------------------------

/** One file loctx would write for an agent, with the computed action. */
export interface AgentTargetStatus {
  readonly purpose: "mcp" | "rules";
  readonly path: string;
  readonly scope: "project" | "user";
  readonly action: "create" | "update" | "skip";
  readonly reason: string;
}

/** Per-agent setup state for a project: detected, already-registered, and
 *  the files that would change. */
export interface AgentPlanStatus {
  readonly id: string;
  readonly label: string;
  readonly present: boolean;
  readonly registered: boolean;
  readonly targets: ReadonlyArray<AgentTargetStatus>;
}

export interface AgentSetupPayload {
  readonly projectRoot: string;
  readonly agents: ReadonlyArray<AgentPlanStatus>;
}

export interface AgentSetupApplyResponse {
  readonly ok: true;
  readonly results: ReadonlyArray<{
    readonly path: string;
    readonly action: string;
    readonly ok: boolean;
    readonly error?: string;
  }>;
}

export interface AgentRefreshResponse {
  readonly ok: true;
  /** Number of already-wired projects re-stamped. */
  readonly wired: number;
  /** Total rules/skill files updated across those projects. */
  readonly filesWritten: number;
  readonly projects: ReadonlyArray<{ readonly root: string; readonly updated: number }>;
}
