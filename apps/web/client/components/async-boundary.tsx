/**
 * Shared loading / error / no-data chrome for `useFetch`-backed views.
 *
 * Every route used to inline the same three-state block; `AsyncBoundary`
 * owns that chrome so the markup lives in one place (CLAUDE.md — the
 * "extract before the third caller" rule). Routes keep their own handlers
 * and data rendering; this component only renders the pre-data states.
 *
 * `AsyncLoading` / `AsyncError` / `AsyncNoData` are exported for the routes
 * whose layout renders these states in bespoke positions and so can't use
 * the render-prop wrapper: `logs` shows its error banner above the controls
 * card, `project-detail`'s error carries a back-link, and the manual-state
 * search routes (`search`, `find-usages`, `find-literal`) only surface the
 * error `<p>`. `AsyncBoundary` composes the same three pieces so the literal
 * markup exists in exactly one place.
 */

import type { ReactNode } from "react";
import type { UseFetchState } from "../lib/use-fetch";
import { Banner } from "./banner";

export function AsyncLoading(): ReactNode {
  return <p className="pullquote">Loading…</p>;
}

export function AsyncError({
  error,
  children,
}: {
  error: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <Banner tone="bad">
      {error}
      {children}
    </Banner>
  );
}

export function AsyncNoData(): ReactNode {
  return <p className="pullquote">No data.</p>;
}

export function AsyncBoundary<T>({
  state,
  children,
}: {
  state: UseFetchState<T>;
  children: (data: T) => ReactNode;
}): ReactNode {
  if (state.loading && state.data === null) return <AsyncLoading />;
  if (state.error !== null) return <AsyncError error={state.error} />;
  if (state.data === null) return <AsyncNoData />;
  return children(state.data);
}
