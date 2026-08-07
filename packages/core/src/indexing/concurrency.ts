/**
 * Bounded worker pool shared by the indexer (per-file) and the
 * reconciler (per-project) — CORE-9. Both previously hand-rolled the
 * same cursor/worker/`Promise.all` shape, and both must change
 * identically when #488–#491 raise indexing concurrency; one
 * implementation keeps that a single edit.
 */

/**
 * Run `fn` over `items` with at most `concurrency` in flight.
 *
 *   - `results` collects resolved values in completion order — callers
 *     that need positional output assign into their own array inside
 *     `fn` (the reconciler does this).
 *   - `signal` (optional) is checked before each item is pulled, so an
 *     abort stops new work without cancelling in-flight calls — the
 *     indexer's #217 semantics. Callers that never abort simply omit it.
 *   - A rejection from `fn` propagates and rejects the whole pool,
 *     matching the previous inline behavior at both call sites.
 */
export async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<{ readonly results: ReadonlyArray<R>; readonly aborted: boolean }> {
  const results: R[] = [];
  let aborted = false;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) {
        aborted = true;
        return;
      }
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      const item = items[i];
      // noUncheckedIndexedAccess: unreachable given the bound check above,
      // but the type system can't know the array is dense.
      if (item === undefined) return;
      results.push(await fn(item, i));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return { results, aborted };
}
