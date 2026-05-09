/**
 * Persistent allowlist of embedding models the user has explicitly
 * downloaded. Pairs with the network egress gate from #43.
 *
 * Why this exists: the gate blocks outbound HTTP per-process. After
 * `loctx model download X` succeeds, the daemon (a separate process)
 * still has an empty allowlist. With the model cached locally there's
 * no actual network call needed for `loctx start`, but the gate fires
 * defensively before HF gets a chance to load from cache.
 *
 * The trusted-models store records "user explicitly downloaded these"
 * and lives next to the rest of loctx's local state. The embedding
 * provider checks it before requiring an in-process allow flag — if
 * the model is on the trusted list, skip the gate entirely. The user's
 * explicit `model download` action is the consent signal.
 *
 * Out of scope: detecting whether the HF cache actually still has the
 * files. If the user clears `~/.cache/huggingface` after marking the
 * model trusted, HF's next load will produce its own network failure;
 * loctx's gate doesn't try to second-guess.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STORE_FILENAME = "trusted-models.json";

export function trustedModelStorePath(dataDir: string): string {
  return join(dataDir, STORE_FILENAME);
}

/** True iff the user has run `loctx model download <modelName>` previously. */
export function isModelTrusted(dataDir: string, modelName: string): boolean {
  return loadTrusted(dataDir).has(modelName);
}

/** Add `modelName` to the trusted list. Idempotent. */
export function markModelTrusted(dataDir: string, modelName: string): void {
  const trusted = loadTrusted(dataDir);
  if (trusted.has(modelName)) return;
  trusted.add(modelName);
  saveTrusted(dataDir, trusted);
}

/** Remove `modelName` from the trusted list. No-op if not present. */
export function unmarkModelTrusted(dataDir: string, modelName: string): void {
  const trusted = loadTrusted(dataDir);
  if (!trusted.has(modelName)) return;
  trusted.delete(modelName);
  saveTrusted(dataDir, trusted);
}

/** Snapshot of the trusted set (sorted, for deterministic display). */
export function listTrustedModels(dataDir: string): ReadonlyArray<string> {
  return [...loadTrusted(dataDir)].sort();
}

// ---- internals ---------------------------------------------------------

function loadTrusted(dataDir: string): Set<string> {
  const path = trustedModelStorePath(dataDir);
  if (!existsSync(path)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((s): s is string => typeof s === "string"));
  } catch {
    // Corrupt store — treat as empty rather than crash. The user can
    // recover by re-running `loctx model download`.
    return new Set();
  }
}

function saveTrusted(dataDir: string, models: Set<string>): void {
  const path = trustedModelStorePath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify([...models].sort(), null, 2), "utf-8");
}
