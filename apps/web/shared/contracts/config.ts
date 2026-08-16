/**
 * config contracts (split from the 687-line contracts.ts, #542).
 */

export type ConfigSourceKind = "default" | "global" | "env";

export interface ConfigLayerPayload {
  readonly kind: "global";
  /** Absolute path on disk; null when this layer doesn't exist yet. */
  readonly path: string | null;
  /** Per-leaf values literally present in this YAML, keyed by dot-path. */
  readonly values: Record<string, unknown>;
}

export interface ConfigFieldSchemaWire {
  readonly key: string;
  readonly label: string;
  readonly help: string;
  readonly type: "string" | "int" | "bool" | "enum" | "string-array";
  readonly default: unknown;
  readonly enumValues?: ReadonlyArray<string>;
  readonly min?: number;
  readonly max?: number;
}

export interface ConfigSectionSchemaWire {
  readonly id: string;
  readonly label: string;
  readonly help: string;
  readonly fields: ReadonlyArray<ConfigFieldSchemaWire>;
}

export interface ConfigPayload {
  readonly raw: unknown;
  readonly globalSource: string | null;
  /** Per-leaf provenance from `Config.sources`. */
  readonly sources: Readonly<Record<string, ConfigSourceKind>>;
  /** Effective values keyed by dot-path (post-merge). */
  readonly effective: Readonly<Record<string, unknown>>;
  /** What's literally in the global YAML (so the editor can explain inheritance). */
  readonly layers: ReadonlyArray<ConfigLayerPayload>;
  readonly schema: ReadonlyArray<ConfigSectionSchemaWire>;
}

export interface ConfigWriteRequest {
  readonly patch: Record<string, unknown>;
}

export interface ConfigWriteResponse {
  readonly ok: true;
  readonly path: string;
  readonly bytesWritten: number;
  /**
   * True when the daemon hot-reloaded the new config into its live state,
   * so the change is already in effect (analyzers, reconciliation interval,
   * and the /api/config payload). False/absent means it only hit disk and
   * a restart is needed. Settings like daemon port/hostname and the
   * embedding model always need a restart regardless.
   */
  readonly reloaded?: boolean;
}

export interface ConfigWriteError {
  readonly ok: false;
  readonly errors: ReadonlyArray<{ readonly key: string; readonly message: string }>;
}

export interface ModelInfo {
  readonly id: string;
  readonly current: boolean;
  readonly downloaded: boolean;
  /** Model license the user accepts by downloading (e.g. "apache-2.0", "gemma"). */
  readonly license: string;
}

export interface ModelsPayload {
  readonly current: string;
  readonly available: ReadonlyArray<ModelInfo>;
}
