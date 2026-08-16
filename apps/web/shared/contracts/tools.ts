/**
 * tools contracts (split from the 687-line contracts.ts, #542).
 */

/**
 * Analyzer tool names. Mirrors `ToolName` in `@loctx/core`
 * (`packages/core/src/tools.ts`) — duplicated because contracts stays
 * import-free by design. `server/api/tools.ts` assigns core's `ToolName`
 * into `ToolStatus.name`, so any drift fails the server typecheck.
 */
export type AnalyzerToolName = "lizard" | "semgrep" | "ast-grep";

/** Optional analyzer tools the daemon can provision (lizard, semgrep, ast-grep). */
export interface ToolStatus {
  readonly name: AnalyzerToolName;
  readonly enabled: boolean;
  /** True when the configured `command` resolves to a runnable binary. */
  readonly installed: boolean;
  readonly command: string;
  /** Where loctx would install it (its managed venv / bin path). */
  readonly managedPath: string;
  /**
   * True for a rule-pack tool that has no rules AND no registry fallback —
   * installed but inert. semgrep with a `registryConfig` is NOT needsRules
   * (it runs the community pack); ast-grep with no rules always is.
   */
  readonly needsRules: boolean;
  /**
   * Configured rule directories for rule-pack tools (semgrep, ast-grep),
   * editable inline on the Analyzers panel. `null` for lizard (no rules).
   */
  readonly ruleDirs: ReadonlyArray<string> | null;
  /**
   * Registry fallback ruleset used when `ruleDirs` is empty (semgrep, e.g.
   * `p/default`). `null` for tools without a registry (lizard, ast-grep).
   */
  readonly registryConfig: string | null;
}

export interface ToolsStatusPayload {
  readonly tools: ReadonlyArray<ToolStatus>;
}

/** Result of re-running an installed analyzer over the existing index. */
export type ToolsBackfillResponse =
  | { readonly ok: true; readonly tool: string; readonly backfilled: number }
  | { readonly ok: false; readonly tool: string; readonly error: string };

/** Result of storing a definitions schema (upload / URL / generated). */
export type DefinitionSchemaResponse =
  | { readonly ok: true; readonly path: string; readonly scanned?: number }
  | { readonly ok: false; readonly error: string };

export type ToolsInstallResponse =
  | {
      readonly ok: true;
      readonly tool: string;
      readonly command: string;
      readonly backfilled: number;
      /** Combined stdout+stderr of the install steps (pip / fetch / unzip). */
      readonly log?: string;
    }
  | { readonly ok: false; readonly tool: string; readonly error: string; readonly log?: string };
