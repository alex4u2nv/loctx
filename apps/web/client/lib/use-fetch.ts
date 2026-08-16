/**
 * Tiny data-fetching hook. Refetches when `key` changes; exposes
 * `reload` for explicit refresh after mutations. No cache — the
 * surface is small enough that swr/react-query would be overkill.
 * Concurrent-request dedupe lives in `api.ts` (`getJson`, #456), so
 * two components mounting the same endpoint share one request.
 */

import { useCallback, useEffect, useState } from "react";

export interface UseFetchState<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  reload(): void;
}

export function useFetch<T>(
  fetcher: () => Promise<T>,
  key: ReadonlyArray<unknown> = [],
): UseFetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: caller provides key array
  useEffect(() => {
    let live = true;
    setLoading(true);
    fetcher()
      .then((d) => {
        if (live) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [tick, ...key]);

  return { data, error, loading, reload };
}
