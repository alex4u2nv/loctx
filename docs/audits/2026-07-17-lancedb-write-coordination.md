# LanceDB write-coordination design (#447)

Date: 2026-07-17. Status: design accepted; implementation split into
follow-up issues (linked at the end).

## Why this exists

Three separate performance improvements are all blocked on one root
cause:

1. **Indexing throughput.** `ProjectIndexer.indexProject` and
   `Reconciler.reconcileAll` default to `concurrency: 1`
   (`indexer.ts:128`, `reconciler.ts:185`). Indexing is effectively
   single-threaded through the embedder and the vector writer.
2. **The ANN index trigger (#210).** `VectorStore.ensureVectorIndex`
   exists but is never called — the reconciler comment (`reconciler.ts:212`)
   notes that touching the table mid-boot via `countRows()` reads a stale
   fragment left by an unflushed write. So large corpora never get an
   IVF/HNSW index and stay on flat scan.
3. **Prune-pass deletes.** `reevaluateFilter` and the reconciler's
   pre-prune await `deleteFile` one file at a time — correct, but slow on
   large prune sets, and not worth parallelizing until the write path is
   coordinated.

The shared blocker is the LanceDB **fragment race** (#204/#207): LanceDB
is append-only, every `mergeInsert`/`delete` writes a new fragment + a
new table version, and concurrent or interleaved writes can leave a
reader (or a follow-up write) pointed at a stale fragment.

## What coordination exists today

- **Per-fileId mutex** (`indexer.ts:70`, `PerKeyMutex`). `persist()`
  embeds documents *outside* any lock (the compute-heavy step), then
  runs `deleteFileChunks` + `upsertChunks` inside
  `fileWriteMutex.runExclusive(fileId, …)`. This serializes two persists
  **of the same file**, nothing more.
- **Per-store write mutex** (`vectors.ts:171`, `AsyncMutex`). Every
  `upsertChunks` / `deleteFileChunks` / `deleteProjectChunks` /
  `compact` runs through one global chain, so individual write *calls*
  are serialized across the whole store.

## Why that's not enough

The two gaps that force `concurrency: 1`:

1. **The per-file delete+upsert pair is not atomic across files.** The
   store mutex serializes each *call*, but for two concurrent files A and
   B it permits the interleaving `A.delete → B.delete → A.upsert →
   B.upsert`. Each call succeeds, yet the fragment lineage LanceDB
   commits across that interleaving is the race window observed in the
   Playwright fixture (#204). The per-fileId mutex doesn't help because A
   and B have different fileIds.
2. **Reads that touch fragments aren't ordered against writes.**
   `countRows()` and `createIndex()` (inside `ensureVectorIndex`) run
   outside the write chain, so mid-index they can observe a fragment an
   in-flight write hasn't committed (#210).

## Options considered

**A. Single global writer queue for all vector mutations.** Funnel every
delete/upsert across all files and projects through one serialized
channel, and make each file's delete+upsert one unit on that channel.
Correct, but as written it also serializes embedding if the queue owns
the whole persist — throwing away the parallelism we're trying to buy.

**B. Concurrent embed, serialized + atomic-per-file write.** Keep
embedding parallel (it already runs outside the lock and is the
bottleneck), and change only the *write* half: make the per-file
delete+upsert a single atomic unit on the store's existing write mutex,
and route fragment-touching reads (`countRows`, `createIndex`) through
the same mutex. Recovers almost all of the throughput (N files embed in
parallel; their writes queue safely) without depending on a LanceDB
version bump.

**C. Lean on LanceDB transactions / newer commit semantics.**
`@lancedb/lancedb@0.27` exposes richer commit/transaction primitives
than the version this code was written against. Potentially the cleanest
long-term answer, but it's a larger surface-area change and couples the
fix to LanceDB API evolution. Worth a spike, not the first move.

## Decision

Adopt **Option B**. Concretely:

1. Add an atomic `replaceFileChunks(projectId, relPath, chunks)` to
   `VectorStore` that performs the delete + `mergeInsert` inside **one**
   `writeMutex.runExclusive`, so no other file's write can interleave
   between a file's own delete and upsert. `persist()` calls this instead
   of the separate `deleteFileChunks` + `upsertChunks`.
2. Route `count()` and `ensureVectorIndex()` through `writeMutex` so they
   observe a consistent post-write state. This closes the #210 read gap.
3. Only then raise the indexer/reconciler `concurrency` default above 1.
   Embedding parallelizes; writes stay serialized and atomic-per-file.
4. Add a batched `deleteFiles(projectId, relPaths[])` (one
   `runExclusive`) for the prune passes.

The fragment race is addressed head-on by (1): the unit LanceDB commits
is now always a complete per-file delete+upsert, never a cross-file
interleaving. (2) removes the stale-read window that disabled the ANN
trigger.

## Risk + validation

- The Playwright e2e fixture is the known reproducer for the fragment
  race (#204); it must stay green with `concurrency > 1`.
- Add a core integration test that indexes N files concurrently and
  asserts the vector row count and search results match a sequential
  run (no lost/duplicated fragments).
- Re-run the eval harness — ranking must be unchanged; this is a
  write-path change, not a retrieval change.

## Follow-up implementation issues

Filed against this design, each referencing #447:

- **#488** — Atomic `replaceFileChunks` + mutex-routed reads (the
  coordination core). Everything below depends on it.
- **#489** — Re-enable the ANN index trigger (#210) once reads are ordered.
- **#490** — Raise indexing/reconcile concurrency default above 1.
- **#491** — Batch prune-pass deletes.
