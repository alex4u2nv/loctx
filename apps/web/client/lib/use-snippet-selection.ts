/**
 * Tiny hook collapsing the "click a row, open a modal with the row's
 * snippet, close on demand" pattern. Used by every result list that
 * pairs with `<SnippetModal>` (#255 entry 3).
 *
 * Returns:
 *   - `selected`: the currently-open row, or null.
 *   - `open(row)`: set the selected row. Pair with `<DataTable
 *      onRowClick={open}>` so click + Enter/Space both work via the
 *      DataTable's keyboard handling.
 *   - `close()`: dismiss the modal. Pair with `<SnippetModal
 *      onClose={close}>`.
 *
 * Keeps the surface narrow on purpose — it's literally a typed
 * useState. The value of pulling it out is in *not* having a different
 * variable name for `[open, setOpen]` in each call site.
 */

import { useCallback, useState } from "react";

export interface SnippetSelection<T> {
  readonly selected: T | null;
  readonly open: (row: T) => void;
  readonly close: () => void;
}

export function useSnippetSelection<T>(): SnippetSelection<T> {
  const [selected, setSelected] = useState<T | null>(null);
  const open = useCallback((row: T) => setSelected(row), []);
  const close = useCallback(() => setSelected(null), []);
  return { selected, open, close };
}
