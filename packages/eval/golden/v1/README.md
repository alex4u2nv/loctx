# golden/v1 — autonomous-build seed gold set

## Status

**Machine-generated seed set, not human-audited.** Built on 2026-05-23;
every row carries `"provenance": "autonomous-v1"`.

This set is good enough to:

- exercise the eval pipeline end-to-end,
- catch grossly broken retrieval (Hit@10 drop from ~0.9 to ~0.1),
- diff two `loctx` builds against the same corpus,

and **not** good enough to:

- gate a reranker or PageRank repo-map decision,
- claim publishable benchmark numbers,
- prove a small (sub-2-point) metric improvement.

Treat the headline numbers from v1 as directional. Before any
behaviour-changing PR uses this set as a regression bar, a human
should walk every row and reclassify, demote, or drop the noisy
ones — call that pass v2 and bump the directory.

## Corpus

Pinned to `loctx` sha `0648fcf1d59ac51a0b5d62b26820c0f60f97bfde`
(main HEAD at v1 creation time). The harness materialises this sha
into a temp dir via `git worktree add` (local clone) or `git clone`
(URL fallback). See `corpus.toml`.

If the v1 numbers ever stop reproducing on a clean checkout, the
first thing to check is whether someone moved this sha — it should
stay frozen for the life of v1.

## Query distribution

48 queries across four buckets:

| bucket | count |
| --- | --- |
| symbol  | 10 (q001–q010) |
| literal | 10 (q011–q020) |
| concept | 10 (q021–q030) |
| mixed   |  8 (q031–q038) |
| prose   | 10 (q039–q048) |

Some queries (q011, q017, q024, q027, q031, q032, q037) have multiple
qrel rows — one canonical span graded `2` and one or more partial
spans graded `1`. nDCG uses these graded grades; Hit/MRR/Recall
binarize at `>= 1`.

## How rows were built

1. Pick a real anchor in the loctx codebase at the pinned sha — an
   export, a literal pattern, a docs section.
2. Author the query in agent-style natural language ("how does the
   watcher detect file changes") not docstring-style.
3. Mark the canonical span by inspection of the source at that sha.
4. For multi-span queries, mark secondary spans at relevance 1.

Anything that scored mostly through luck — a long span that
overlapped half the file — got tightened or dropped before commit.

## Known biases (to fix in v2)

- **Author-curse**: the rows were authored from reading the same
  codebase the queries point at, which inflates Hit@k because the
  query wording maps cleanly onto the canonical chunk's text.
- **Symbol bias**: ten symbol queries against exact identifier names
  is the easy mode for hybrid search. Real agent queries are
  fuzzier.
- **No negatives**: the set is all positive grades. We don't
  currently penalise retrieving the right relPath for the wrong
  reason; that needs `relevance: 0` rows added in v2.
- **Concept queries lean on prose docstrings**: most concept rows
  point at code spans whose comments paraphrase the query. Concept
  retrieval against undocumented code is the harder case and
  underrepresented here.

## Pointers

- Schema is documented in `packages/eval/src/qrels.ts`.
- Adding/changing rows in this directory bumps v1 — a behavioural
  change. New gold-set version → `golden/v2/`, never edit-in-place.
- Span-overlap matching means a row's `start_line`/`end_line`
  bracket the canonical chunk loosely; the harness counts any
  retrieved chunk whose `[startLine, endLine]` shares one line
  with the qrel span.
