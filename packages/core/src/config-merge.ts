/**
 * Config-section merge machinery (#542 split from config.ts): the
 * descriptor-driven field mergers (CORE-4) and the per-leaf picker.
 * Owns ConfigError so the dependency points one way
 * (config.ts -> config-merge.ts).
 */

import { BOOL, INT_NON_NEG, type Spec, STR, STR_ARRAY, Validator } from "./_validate.js";

export class ConfigError extends Error {}

export type ConfigSource = "default" | "global" | "env";

// ---- descriptor-driven analyzer merge (CORE-4) -------------------------

/**
 * Field kinds a section descriptor can declare. The camelCase config
 * key is the single source of truth: the snake_case YAML key is derived
 * mechanically and the fallback comes from the section's defaults
 * object, so a leaf can no longer drift between its three spellings
 * (CORE-4 — mergeAnalyzers used to spell all three out per leaf, 175
 * lines of mechanical picker calls).
 */
export type SectionFieldKind = "bool" | "str" | "int" | "strArray";

export interface SectionField<S> {
  readonly key: Extract<keyof S, string>;
  readonly kind: SectionFieldKind;
}

export function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Merge one config section: every field in `picked` resolves
 * global-YAML → default via {@link makePicker} (stamping `sources`);
 * fields NOT listed stay pinned to their defaults with no YAML lookup
 * and no source stamp — e.g. `semgrep.bundledRules` and
 * `astGrep.registryConfig`, kept only for RulePackAnalyzerConfig type
 * parity.
 */
export function mergeSection<S extends object>(
  glo: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
  trackPrefix: string,
  defaults: S,
  picked: ReadonlyArray<SectionField<S>>,
): S {
  const pick = makePicker(glo, sources);
  const overrides: Partial<Record<Extract<keyof S, string>, unknown>> = {};
  for (const f of picked) {
    const trackKey = `${trackPrefix}.${f.key}`;
    const yamlKey = camelToSnake(f.key);
    const fallback = defaults[f.key];
    switch (f.kind) {
      case "bool":
        overrides[f.key] = pick(trackKey, yamlKey, BOOL, fallback as boolean);
        break;
      case "str":
        overrides[f.key] = pick(trackKey, yamlKey, STR, fallback as string);
        break;
      case "int":
        overrides[f.key] = pick(trackKey, yamlKey, INT_NON_NEG, fallback as number);
        break;
      case "strArray":
        overrides[f.key] = Object.freeze(
          pick(trackKey, yamlKey, STR_ARRAY, [...(fallback as ReadonlyArray<string>)]),
        );
        break;
    }
  }
  // The switch above resolves each field with the Spec matching its
  // declared kind, so the merged object satisfies S; the cast just
  // re-attaches the interface the per-key loop erased.
  return Object.freeze({ ...defaults, ...overrides } as S);
}

// ---- per-leaf picker ---------------------------------------------------

/**
 * Curry the global mapping + the source-tracking record, then return a
 * generic picker that resolves a single leaf against any `Spec<T>`.
 * Walks global → fallback and stamps the source map as it goes.
 */
export type PickFn = <T>(trackKey: string, yamlKey: string, spec: Spec<T>, fallback: T) => T;

export function makePicker(
  glo: Record<string, unknown> | null,
  sources: Record<string, ConfigSource>,
): PickFn {
  const globalV = new Validator(ConfigError, "<global>");
  return <T>(trackKey: string, yamlKey: string, spec: Spec<T>, fallback: T): T => {
    const gloVal = glo === null ? undefined : globalV.get(glo, yamlKey, spec);
    if (gloVal !== undefined) {
      sources[trackKey] = "global";
      return gloVal;
    }
    sources[trackKey] = "default";
    return fallback;
  };
}

export function sectionRecord(
  raw: Record<string, unknown> | null,
  key: string,
  source: string,
): Record<string, unknown> | null {
  if (raw === null) return null;
  const inner = raw[key];
  if (inner === undefined) return null;
  if (inner === null) return {};
  if (typeof inner !== "object" || Array.isArray(inner)) {
    throw new ConfigError(`${source}: section '${key}' must be a mapping.`);
  }
  return inner as Record<string, unknown>;
}
