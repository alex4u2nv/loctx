/**
 * status contracts (split from the 687-line contracts.ts, #542).
 */

export interface StatusPayload {
  readonly daemon:
    | {
        readonly running: true;
        readonly pid: number;
        readonly hostname: string | null;
        readonly port: number | null;
        readonly startedAt: string;
        readonly version: string;
      }
    | {
        readonly running: false;
        readonly pidLockPath: string;
      };
  readonly runtime: {
    readonly configGlobal: string | null;
    readonly dataDir: string;
    readonly vectorDir: string;
    readonly stateDb: string;
    /**
     * On-disk size of the index in bytes: the LanceDB vector store
     * (`vectorDir`) plus the SQLite state DB and its WAL/SHM sidecars.
     * Best-effort; 0 if the paths can't be read.
     */
    readonly indexSizeBytes: number;
    readonly embeddingProvider: string;
    readonly embeddingModel: string;
    /** True once the embedding model has been initialized successfully. */
    readonly embeddingReady: boolean;
    readonly retrievalMode: string;
    readonly watcherDebounceMs: number;
    readonly reconciliationIntervalSeconds: number;
    readonly reconciliationRunOnStart: boolean;
    /** Auto-compaction cadence in hours; 0 means auto-compaction is off. */
    readonly compactIntervalHours: number;
  };
  /**
   * Live reconciliation state — non-null only while a pass is in
   * flight. The UI shows a banner during reconciliation so users know
   * search results may be incomplete.
   */
  readonly reconciliation: {
    readonly running: boolean;
    readonly startedAt: string | null;
    readonly currentProjectName: string | null;
    readonly completed: number;
    readonly total: number;
    /**
     * Files indexed so far inside `currentProjectName` (#44). Null until
     * the indexer reports progress or when idle. Pairs with
     * `currentProjectTotal` for "loctx: 86 / 219 files" mid-pass.
     */
    readonly currentProjectIndexed: number | null;
    readonly currentProjectTotal: number | null;
  };
  /**
   * Analyzer enrichment queue — backfill + reprocessing by lizard /
   * semgrep / ast-grep. `depth` > 0 means files are being (re)analyzed;
   * the projects page surfaces this so a slow backfill isn't invisible.
   */
  readonly analyzers: {
    readonly depth: number;
    readonly running: number;
    readonly completed: number;
    readonly failures: number;
    readonly lastRunAt: string | null;
  };
  /**
   * Background index maintenance (vector-store compaction). `running` is
   * true while a pass is in flight — the UI shows a banner because
   * compaction is CPU/IO-heavy and an operator should know it's loctx.
   */
  readonly maintenance: {
    readonly running: boolean;
    readonly startedAt: string | null;
    readonly lastRunAt: string | null;
    readonly lastFreedBytes: number | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly root: string;
  }>;
  /**
   * "Value served" estimate across every retrieval call the daemon has
   * logged (#value-metrics) — tokens the agent didn't spend by getting
   * ranked snippets instead of grep + read-whole-file. An estimate, shown
   * with "≈". Zeroed until the first retrieval query lands.
   */
  readonly value: ValueMetrics;
}

/**
 * Estimated value of loctx's retrieval vs. a grep + read-whole-file
 * baseline. All token figures are estimates (fixed chars-per-token).
 */
export interface ValueMetrics {
  readonly queries: number;
  readonly tokensSaved: number;
  readonly baselineTokens: number;
  /** Saved as a share of baseline, 0–100. */
  readonly reductionPct: number;
  readonly filesReadAvoided: number;
  readonly zeroHitQueries: number;
  /** Zero-hit queries as a share of all queries, 0–100. */
  readonly zeroHitPct: number;
  readonly avgLatencyMs: number;
}

/** Per-project slice of {@link ValueMetrics} for the projects table. */
export interface ProjectValue {
  readonly tokensSaved: number;
  readonly queriesServed: number;
  readonly filesReadAvoided: number;
}
