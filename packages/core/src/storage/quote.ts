/**
 * Quote a string as an ANSI-SQL single-quoted literal, escaping embedded
 * quotes by doubling. Used for LanceDB DataFusion predicates (both the
 * vector store's delete filters and the searcher's WHERE pushdown) —
 * better-sqlite3 statements bind parameters instead and never need this.
 * Was duplicated byte-for-byte in vectors.ts and searcher.ts (audit
 * 2026-08-06, lower-severity core notes).
 */
export function quoteSql(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
