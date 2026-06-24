# @loctx/eval

Offline retrieval-quality eval harness for `loctx`. Measures `WorkspaceSearcher` output against a versioned, frozen gold set, emits TREC-format run files, and renders a Markdown report.

This package only measures. It does not modify retrieval behaviour.

## Why

Shipping a reranker, a PageRank repo map, or any other ranking-quality change without a measurement baseline is guessing. The harness is the gating substrate for those PRs.

See `~/Workspaces/Notes/loctx/2026-05-23/eval-harness-plan.md` for the design memo.

## Quick start

```bash
# from the monorepo root
pnpm install
pnpm build

# run the v1 gold set end-to-end (index corpus → query → score → write run files)
pnpm eval run v1

# render markdown report for the latest run
pnpm eval report packages/eval/runs

# compare two runs
pnpm eval compare packages/eval/runs/<a>.json packages/eval/runs/<b>.json
```

`pnpm eval run v1` writes `<runId>.trec` + `<runId>.json` under `packages/eval/runs/`. The directory is gitignored — runs are reproducible from the pinned corpus + the `loctxSha` stamped in the run JSON.

## Layout

```
packages/eval/
  src/
    cli.ts                 # commander entrypoint
    cmd/
      index.ts             # `eval index <set>`  — snapshot + index only
      run.ts               # `eval run <set>`    — full pipeline + run files
      report.ts            # `eval report <run>` — render markdown
      compare.ts           # `eval compare a b`  — delta table
    corpus.ts              # git-worktree-add snapshot + sandboxed runtime
    qrels.ts               # JSONL loader + span-overlap matcher
    metrics.ts             # Hit@k, MRR@10, nDCG@10, Recall@k
    runner.ts              # search loop
    trec.ts                # TREC writer
    report.ts              # markdown rendering
    toml.ts                # corpus.toml parser (scalars only)
    types.ts
  golden/
    v1/
      corpus.toml          # pinned loctx sha
      qrels.jsonl          # 48 queries
      README.md            # provenance + audit guidance
  test/                    # vitest
```

## Adding queries

**Don't edit `golden/v1/`** — bump to `v2/` instead and copy the corpus pin forward (or update it to a fresher sha). PR notes should explain why the bump.

Schema: see `src/qrels.ts`. Required fields are `query_id`, `query`, `query_type` (`literal | symbol | concept | mixed | prose`), `rel_path`, `start_line`, `end_line`, `relevance` (`0 | 1 | 2`), and `provenance`. Multiple rows with the same `query_id` mark multiple relevant spans.

## Design decisions (locked, see plan)

- **Corpus = pinned git sha.** Materialised via `git worktree add --detach` (local source) or `git clone` + `checkout --detach` (URL fallback).
- **Qrels keyed on `(rel_path, start_line, end_line)`.** Matching is span-overlap, not exact docid equality, so a re-chunk of the same content doesn't move metrics.
- **Library import, not MCP boundary.** The runner calls `WorkspaceSearcher` directly through `@loctx/core` — faster than spawning a daemon and `searcher.ts` is the unit under test.
- **TypeScript metrics + TREC alongside.** In-process Hit/MRR/nDCG/Recall; TREC files emitted for external `pytrec_eval` cross-checks.
- **v1 uses the fake embedder.** Deterministic across runs (covers the "embedder nondeterminism" risk). Switching to ONNX embeddings is a follow-up flag.

## Determinism

Both the chunk-boundary set and the run output are bit-exact across two `eval run v1` invocations on the same corpus sha. The run JSON records `chunkBoundaryHash` so a future regression where chunking goes non-deterministic surfaces immediately.

If two `pnpm eval run v1` invocations on the same machine ever produce different TREC files, hard-fail the change that introduced it before merging.

## Future work (out of scope here)

- Cache the indexed corpus by `(corpus_sha, chunking_config_hash, embedder_version)` so CI doesn't re-index from scratch.
- ONNX-backed embedder option (`fake` is the default for reproducibility; production runs will want the real model).
- LLM-assisted relevance pre-labelling for v2 of the gold set, behind a human-review pass.
- Optional `--via mcp` flag to drive the MCP HTTP boundary instead of the library.
- CoIR / CodeRAG-Bench loaders.
