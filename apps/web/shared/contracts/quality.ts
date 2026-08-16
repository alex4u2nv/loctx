/**
 * quality contracts (split from the 687-line contracts.ts, #542).
 */

// ---- project quality report (#525) --------------------------------------

export interface QualityFindingRow {
  readonly ruleId: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly category: string;
  readonly lineFrom: number;
  readonly lineTo: number;
}

export interface QualityReportFileRow {
  readonly fileId: string;
  readonly relPath: string;
  readonly weight: number;
  readonly findings: ReadonlyArray<QualityFindingRow>;
}

export interface QualityRuleSummaryRow {
  readonly ruleId: string;
  readonly count: number;
  readonly files: number;
  readonly worstSeverity: "error" | "warning" | "info";
}

export interface QualityReportPayload {
  readonly files: ReadonlyArray<QualityReportFileRow>;
  /** Full-report rule rollups (stable under the rule filter). */
  readonly rules: ReadonlyArray<QualityRuleSummaryRow>;
  readonly totals: {
    readonly files: number;
    readonly findings: number;
    readonly errors: number;
    readonly warnings: number;
    readonly infos: number;
  };
  /** Coverage caps hit while building the report — never silent. */
  readonly notes: ReadonlyArray<string>;
  /** Non-null when the stored quality rules are off; report is partial. */
  readonly disabled: string | null;
}
