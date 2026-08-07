# Code quality and architecture review — 2026-08-06

Full-repo structural review at a principal-engineer bar: duplication,
nesting, god functions, typing discipline, encapsulation, missing
abstractions, and modern-language idioms. Follows the audit-first
convention: this inventory lands before any fix PRs, and fix PRs
reference finding IDs from this document.

Method: four parallel per-workspace reviews (core, web client, HTTP/MCP
layer, CLI + eval), cross-checked against the repo's own analyzers
(`find_duplicates` over the loctx index) and repo-wide grep metrics.
House rules calibrated every finding: two copies of a pattern is a
watch, the third caller is the trigger; premature abstraction loses to
duplication; components serving one route stay local.

## Snapshot verdict

The architecture is sound and the typing discipline is genuinely
strong: maximally strict base tsconfig, 4 `: any` occurrences in
~28k lines of source, zero empty catch blocks, zero `enum`, branded
IDs and discriminated unions in the load-bearing places. SQL lives in
`.sql` files, heavy deps load lazily, and comment density around
invariants (with issue numbers) is well above normal.

The debt clusters into four repo-wide themes, not scattered one-offs:

1. **Hand-enumerated lists that should be descriptor tables.**
   Analyzer gating (CORE-1), config merge (CORE-4), migration ladder
   (CORE-2), doctor checks (CORE-3), metric keys (CLI-5). Same shape
   everywhere: a list of similar things spelled out per-case, growing
   linearly and drifting silently. CORE-1 has already cost a real bug
   (semgrep backfill silently inactive).
2. **Two transports, one domain, no shared spec.** `apps/mcp` and
   `apps/web/server` independently implement the same operations,
   coupled only by comments claiming they match. Path confinement
   (SRV-1), the reconcile write guard (SRV-2), input validation
   (SRV-5), and caveat text (SRV-9) each exist on one side or diverge.
3. **Helpers built, then bypassed.** `writeConfigPatch` vs `model.ts`
   (CLI-2), `spansOverlap` vs three inlined copies (CLI-4),
   `withDaemonClient` vs six inline lock checks (CLI-1), `DataTable` /
   `IconButton` / `QueryForm` promoted but not adopted at the call
   sites that motivated them (WEB-1, WEB-8, WEB-4). The abstraction
   exists; the remaining callers just need routing through it.
4. **Copy-pasted stateful patterns past the third caller.** URL-query
   state machine in three routes (WEB-2), busy/message runner in four
   pages (WEB-6), warning banner in four components (WEB-7), indexer
   test scaffold in four unit tests (TEST-1).

## Severity index

| ID | Severity | Effort | One-liner |
|---|---|---|---|
| CORE-1 | high | M | Analyzer activation policy duplicated in container.ts; already drifted (semgrep backfill dead) |
| CORE-2 | high | M | StateStore.migrate() ten-block copy-paste ladder + inline SQL bypassing state.sql |
| CORE-3 | high | M | runDoctorChecks ~350 lines, 14 concerns, double-opens StateStore/WorkspaceDiscovery |
| CORE-4 | high | M | mergeAnalyzers 175 lines of mechanical picker calls; semgrep/astGrep shape written twice |
| CORE-5 | high | S | Lexical-vs-vector field coalesce written three times in searcher.ts |
| SRV-1 | high | M | MCP tools skip workspace-root confinement the HTTP API enforces; doc claims otherwise |
| SRV-2 | high | S | MCP refresh_workspace omits the reconcile-in-flight guard HTTP has (LanceDB race #207) |
| SRV-3 | high | M | No Hono onError; JSON-parse + error boilerplate 8×, sanitizeError wired into 2 of ~30 handlers |
| SRV-4 | high | S | Workspace-confinement block copy-pasted 8× across 5 route files |
| WEB-1 | high | M | projects.tsx hand-rolls the two tables DataTable was extracted for; header/cell drift bug |
| WEB-2 | high | M | URL-driven query state machine copy-pasted into three routes, already drifted |
| WEB-3 | high | L | AnalyzersPage 434-line god component; one global busy slot disables the whole page |
| WEB-4 | high | M | project-detail's three scoped panels re-implement fetch state; 2 of 3 bypass QueryForm |
| CLI-1 | high | M | Daemon-or-local branch copy-pasted across six commands |
| CLI-2 | high | S | model.ts hand-rolls YAML write, destroying user comments; writeConfigPatch exists for this |
| CLI-3 | high | M | Eval subcommands repeat the corpus-setup preamble/teardown three times |
| CLI-4 | high | S | Span-overlap matching inlined in three places despite spansOverlap being the documented rule |
| CLI-5 | high | S | MetricSummary keys hand-enumerated four times in averageMetrics |
| CORE-6 | medium | M | WorkspaceSearcher.search mixes fetch, fusion, four scoring signals, enrichment (~120 lines) |
| CORE-7 | medium | S | Import-extraction helper trio byte-identical across chunking/code.ts and chunking/analyzer.ts |
| CORE-8 | medium | S | Three identical external-binary detectors (lizard/semgrep/ast-grep) |
| CORE-9 | medium | S | Bounded worker pool written twice (indexer.ts, reconciler.ts); both must change for #488-#491 |
| CORE-10 | medium | S | SearchResult widens branded IDs to string, forcing casts back at three sites |
| CORE-11 | medium | S | Analyzer tool-probe cache is module-global mutable state; untestable, shared across runtimes |
| CORE-12 | medium | S | Ignored-directories policy exists in three inconsistent copies |
| SRV-5 | medium | M | Two validation dialects for the same request fields; HTTP rejects, MCP clamps |
| SRV-6 | medium | M | /api/projects list and detail duplicate row construction + reconcile snapshot (~35 lines) |
| SRV-7 | medium | S | SSE cleanup never fires via cancel(); double cast hides the wrong signature |
| SRV-8 | medium | S | Config-schema plucking implemented identically in web server and MCP registry |
| SRV-9 | medium | S | find_literal coverage caveat duplicated across transports, already drifted |
| SRV-10 | medium | M | /api/search hand-maps 50 lines, drops indexHealth, skips value accounting (MCP has both) |
| SRV-11 | medium | M | /api/rebuild ~110-line handler mixing parsing, admission control, background orchestration |
| WEB-5 | medium | S | ScopedFindLiteral references a datalist only its sibling tab renders (silently broken) |
| WEB-6 | medium | S | useOpRunner exists; models.tsx and analyzers.tsx re-implement it 8× total |
| WEB-7 | medium | S | Warning-banner block written out in four result components |
| WEB-8 | medium | S | IconButton adopted by one route, not the four its docstring names |
| WEB-9 | medium | M | Route table declared four times (NAV, ROUTE_LABELS, admin-tabs, search-tabs) |
| WEB-10 | medium | M | Analyzer config read through magic dot-path strings + unchecked casts |
| WEB-11 | medium | S | Find-literal grouping/rendering duplicated between route and project-detail; drifted |
| CLI-6 | medium | M | search/rebuild handlers mix validation, transport, domain, formatting (~100 lines each) |
| CLI-7 | medium | M | Three exit conventions; magic exit 2; process.exit inside try skips finally cleanup |
| CLI-8 | medium | M | find-usages renders its table twice (daemon vs local) with type-defeating casts |
| CLI-9 | medium | S | perQueryRanked typed Map<string, any[]> via Array.prototype.slice; brands dropped |
| CLI-10 | medium | S | (err as Error).message in 13 catch blocks; errorMessage(err) helper needed |
| CLI-11 | medium | M | Run JSONs as-cast at the read boundary; every other eval input is validated |
| CLI-12 | medium | S | ndcgAtK four-deep argmax loop; scoreRun manual bucketing predates Map.groupBy |
| SRV-12 | low | S | Module-level mutable activation guards in projects.tsx route |
| WEB-12 | low | S | DataTable role="button" on tr drops table semantics for assistive tech |
| TEST-1 | medium | S | Indexer beforeEach scaffold copy-pasted across 4 core unit tests (found via find_duplicates) |

## Findings detail

### packages/core

**CORE-1 — Analyzer activation policy implemented twice, already drifted.**
`container.ts:156-291` (`enqueueFileAnalyzers`) and `:302-343`
(`backfillSpecs`) each spell out "is this analyzer live?" per analyzer.
They disagree today: the shipped default (`ruleDirs: []`,
`registryConfig: "p/default"`) makes semgrep run during indexing while
backfill treats it as inactive and never touches already-indexed files.
No `container.test.ts` exists to catch it. Fix: one
`ANALYZERS: Record<AnalyzerName, {version, isActive(config), needsTool,
buildTask}>` table read by both paths.

**CORE-2 — Migration ladder.** `storage/state.ts:262-403` repeats the
`if (current < N) { exec(QUERIES["schema_vN"]) }` block ten times, and
the `current < 3` branch hand-writes `CREATE TABLE symbol_refs` SQL
inline, bypassing the otherwise-strict `sql/state.sql` convention. Fix:
declarative `MIGRATIONS` array + one loop; move the v3 SQL into a named
section.

**CORE-3 — runDoctorChecks god function.** `doctor.ts:38-389`: fourteen
checks appending to one shared array through nested try/catch, opening
`StateStore` twice and constructing `WorkspaceDiscovery` twice per
call. Fix: `(ctx: DoctorContext) => DoctorCheck[]` check functions,
context built once, `flatMap` over an exported check list.

**CORE-4 — mergeAnalyzers.** `config.ts:708-883`: every leaf spells out
camelCase track key, snake_case YAML key, and default, though each is
derivable from the others; semgrep and astGrep share
`RulePackAnalyzerConfig` but get two written-out copies. Fix:
`mergeSection` driven by per-section descriptors; one
`RULE_PACK_FIELDS` shared by both rule-pack analyzers.

**CORE-5 — Branch-field coalesce ×3.** `retrieval/searcher.ts:277-278`,
`295-298`, `910-925` each re-derive
`l?.relPath ?? String(v?.metadata["rel_path"] ?? "")` etc., two of them
in the same function. Fix: one `mergeBranchFields(v, l)` helper.

**CORE-6 — search() altitude.** `searcher.ts:234-352` covers scope
resolution, two fetches, fusion, four scoring signals mutating entries
in place, slicing, coverage expansion, enrichment. The ranking policy
is the eval-tunable part and the least testable. Fix: extract a pure
`scoreEntry(entry, ctx)` so signals test against the eval harness
without a full `search()`.

**CORE-7 — Chunking helper trio duplicated.** `chunking/code.ts:520-535,
602-611` vs `chunking/analyzer.ts:408-425, 437-446`:
`importModuleText`/`importTargetText`, `stripImportQuotes`/`stripQuotes`,
`dedupeStrings`/`dedupe` are byte-identical pairs feeding the same
`symbol_refs` table; drift is a correctness risk. Fix: share from
`chunking/analyzer.ts` as `extractAnalyzer` already is.

**CORE-8 — Binary detectors ×3.** `analyzers/lizard.ts:48-58`,
`semgrep.ts:38-51`, `ast-grep.ts:90-97` differ only in timeout. Fix:
`detectCommand(command, timeoutMs)` in `rule-pack.ts`; keep named
one-line wrappers.

**CORE-9 — Worker pool ×2.** `indexing/indexer.ts:128-150` and
`indexing/reconciler.ts:185-204` repeat the cursor/worker/`Promise.all`
shape; both must change identically when #488-#491 raises concurrency.
Fix: `mapWithConcurrency(items, concurrency, fn, signal?)`.

**CORE-10 — Brand laundering.** `SearchResult.projectId` is `string`
(`searcher.ts:100`) though it always holds a `ProjectId`, forcing
`as ProjectId` casts back at `:382`, `:423`, `:442`; `state.ts` casts
brands on at 18 row-mapping sites. Fix: type the field as `ProjectId`;
centralize row→brand conversion in the existing row mappers. Also
delete the dead `chunkId === undefined` guard at `searcher.ts:427`.

**CORE-11 — Module-global tool-probe cache.**
`container.ts:114-141`: `toolAvailability`/`toolProbing` are process
singletons shared across runtimes, unresettable in tests (likely why
container.ts has none). Fix: instance owned by the runtime.

**CORE-12 — Ignored-dirs policy ×3.** `filtering-defaults.ts:21-60`,
`discovery.ts:67-80`, `watcher/service.ts:85-95` hold three
inconsistent copies (`.tox`, `.pnpm`, `.turbo` coverage differs). Fix:
export the canonical name list; derive set and glob forms.

Lower-severity core notes: inline SQL at `state.ts:611-621, 962-975`;
`definitions.ts:334-343` glob-matcher cache keyed by array identity
(never hits after hot-reload, unbounded); `searcher.ts:409` async
without await; `searcher.ts:650` and `vectors.ts:347` byte-identical
SQL quoters.

### HTTP/MCP layer

**SRV-1 — MCP path confinement gap.** `resolveUnderWorkspaceRoots` is
called 8× in the HTTP server, 0× in `apps/mcp`; `registry.ts` doc
comments claim out-of-root paths are rejected, but `search`,
`find_usages`, `find_literal`, `find_duplicates`, and `refresh`
(`registry.ts:480, 527, 566, 611-613`) pass `path` straight through,
and refresh will index it. Fix: shared confine-or-throw helper in core,
called at the top of each MCP handler; or document unconfined MCP
access as deliberate and delete the false comment.

**SRV-2 — Reconcile guard on one transport.** `ops.ts:52-66` refuses
concurrent index passes (LanceDB race #207) with a 409; MCP
`tools.refresh` (`registry.ts:603-630`) just indexes. The guard exists
in four places with four message strings. Fix:
`assertNotReconciling(runtime, opName)` in core, called from all five
sites.

**SRV-3 — No error middleware.** No `app.onError` in
`server/index.ts`; the JSON-parse guard repeats 8× in 3 incompatible
response shapes; `sanitizeError` protects 2 of ~30 handlers. Fix:
`app.onError` returning the sanitized shape + a `jsonBody(c)` helper
throwing a typed BadRequest.

**SRV-4 — Confinement block ×8.** Same three lines in `search.ts`,
`find-usages.ts`, `find-literal.ts`, `projects.ts` ×2, `ops.ts` ×3.
Fix: one `confinedPath(c, config, raw)` helper; this is also the
mechanism that prevents SRV-1 recurring.

**SRV-5 — Two validation dialects.** HTTP `parseBoundedInt` 400s on
out-of-range limit; MCP clamps silently (`request-validation.ts:48-76`
vs `registry.ts:366-390`), with a comment asking them to match. Fix:
per-operation input specs in core; transports only map errors to wire.

**SRV-6 — projects.ts row duplication.** List and detail handlers
duplicate the reconcile snapshot (18 lines) and `ProjectsRow`
construction (~35 lines); `reconciling` computed twice in the detail
handler. Fix: lift `buildRow` + snapshot fetch to module scope.

**SRV-7 — SSE cleanup dead path.** `events.ts:48-52` stashes
`_cleanup` on the controller via `as unknown as`, then reads it in
`cancel(controller)`; `cancel` receives the cancellation reason, not
the controller, so cleanup only happens when a heartbeat ping throws
up to 15s later. Fix: capture `cleanup` in the closure; drop both
casts.

**SRV-8 — Config plucking ×2.** `config.ts:115-136` and
`registry.ts:643-662, 745-752` walk `CONFIG_SCHEMA` identically in two
packages. Fix: `effectiveSettings(config)` exported from core next to
`CONFIG_SCHEMA`.

**SRV-9 — Caveat text drift.** The ~400-char find_literal blind-spot
note is inlined in both transports and already differs. Fix: export
the constant once.

**SRV-10 — /api/search drift.** MCP search returns `indexHealth` and
records usage value; HTTP search does neither, and
`shared/contracts.ts` re-declares the hit shape structurally. Fix:
derive `SearchHit` from the core type; decide deliberately on
indexHealth + value accounting for HTTP.

**SRV-11 — rebuild handler altitude.** `ops.ts:193-301`: parsing,
two-reason admission control, crash markers, detached async work, and
status computation in one function, with an O(n²) re-scan. Fix:
`planRebuild(...)` + `startRebuild(...)`.

**SRV-12 — Module-level activation guards.** `projects.ts:36, 45`
should live in the `mountProjects` closure alongside `shared`.

Also noted: `definitions.ts:136-158` five-level labeled loop wants a
helper; `POST /api/definitions/schema` fetches a user URL with no
timeout or size cap. Coverage gap: 4 of 15 route modules have unit
tests, and the untested set includes the destructive ops
(rebuild/reset/restart, activate/deactivate).

### apps/web client

**WEB-1 — projects.tsx tables.** Both tables (`:386-459`, `:711-751`)
open-code markup `DataTable` owns, including a byte-identical
empty-state cell; the string header array and conditional cells have
already drifted (orphan rows can render one fewer cell than headers).
Fix: convert both to `DataTable` with `Column<T>[]`.

**WEB-2 — URL-query state machine ×3.** `search.tsx:21-80`,
`find-literal.tsx:25-68`, `find-usages.tsx:17-53` each implement
params→state→submit→URL-mirror→auto-fire with a `lastFired` ref;
find-usages already uses a different loop-avoidance mechanism. Fix:
`lib/use-url-query.ts` with a params↔request codec; states collapse to
one discriminated union.

**WEB-3 — AnalyzersPage.** 434 lines, two fetches, six states, eight
mutation handlers, one global `busy` string that disables the entire
page during any single save. Fix: four card components + a
`useConfigWriter()` hook.

**WEB-4 — Scoped panels.** `project-detail.tsx` panels at `:316-408`,
`:527-568`, `:570-636` share an identical state prologue; two
hand-roll the form `QueryForm` owns while the middle one uses it. Fix:
shared query hook + extend `QueryFormField` with a `type` union
(text/checkbox/number, optional datalist).

**WEB-5 — Cross-tab datalist.** `project-detail.tsx:623` references
`#scoped-subtree-suggestions`, rendered only inside the mutually
exclusive ScopedSearch tab (`:380-384`), so suggestions silently
vanish on the find-literal tab. Fix: hoist the datalist above the tab
switch or make it a component.

**WEB-6 — useOpRunner bypassed.** `models.tsx:44-56` inlines the
hook's exact body; `analyzers.tsx` does it six times; error banners
differ per page as a result. Fix: adopt `useOpRunner(reload)`.

**WEB-7 — Warning banner ×4.** Identical `.pullquote` + inline warn
colors in four result components; `borderLeftColor` inline styles
appear 15× in five color variants. Fix: `<Banner tone>` component +
CSS modifier classes.

**WEB-8 — IconButton adoption stalled.** Its docstring names four
routes; only `projects.tsx` imports it. `/admin` hand-rolls eight
buttons, `/models` two, `/analyzers` four. Fix: mechanical conversion.

**WEB-9 — Route table ×4.** `app.tsx` NAV + ROUTE_LABELS,
`admin-tabs.tsx`, `search-tabs.tsx`, plus `<Route>` literals. Fix: one
`lib/routes.ts` with `{path, label, icon, group}`; derive the rest.

**WEB-10 — Untyped config accessors.** `analyzers.tsx:48-56, 251-255`:
magic dot-path strings (~20 inline in JSX), `v as string[]` without
element checks, `as string` re-casts after a guard. Fix: typed
`Record<ToolName, …>` keys + verified list reads.

**WEB-11 — Find-literal renderer ×2.** `project-detail.tsx:638-681` vs
`find-literal.tsx:194-232`, ~35 shared lines, already drifted on
grouping key and kind tag. Fix: `components/literal-results.tsx`.

**WEB-12 — DataTable row role.** `role="button"` on `<tr>` drops
row/cell semantics on five clickable tables. Fix in one file: drop the
role, put the affordance on the first cell's real button as
`search.tsx` does.

Prior-audit status (2026-05-17): modals hold (two sanctioned portals);
`useSnippetSelection` done; `SurfaceCard` done-as-scoped;
`useInFlightSet` correctly still deferred. **Stalled:** `DataTable`
(projects.tsx), `IconButton` (admin/models/analyzers), `QueryForm`
(4 of 6 call sites), CSS class migration (not started; 29 inline
`fontSize`, analyzers.tsx alone has 26 `style={{` blocks). Also:
client components/hooks have zero unit tests; delete the dead
`void compressPath` pin in `project-detail.tsx:753-757`.

### apps/cli + packages/eval

**CLI-1 — Daemon-or-local ×6.** `readActiveDaemon` at 11 sites,
`daemonClient` at 10; six commands repeat the lock-check /
early-return / local-fallback shape with inconsistent fallback policy.
Fix: `withDaemonOrLocal({viaDaemon, viaLocal, localRuntime})` in
`lib/daemon-io.ts`.

**CLI-2 — model.ts config write.** `model.ts:9-29` parse/stringifies
the YAML, stripping every comment `loctx config init` wrote, skipping
`validatePatch` and the atomic tmp+rename; core's `writeConfigPatch`
exists precisely for this. Also `tools.ts:142` ignores
`writeConfigPatch`'s result and reports success unconditionally. Fix:
call `writeConfigPatch` and check `result.ok` at both sites.

**CLI-3 — Eval corpus preamble ×3.** `cmd/index.ts`, `cmd/run.ts`,
`cmd/validate.ts` repeat ~16 lines of corpus setup + try/finally
teardown. Fix: `withCorpusRuntime(options, fn)` owning the lifecycle.

**CLI-4 — Span overlap ×3+1.** `qrels.ts` documents `spansOverlap` as
the shared matching rule; only `judgeRanked` uses it. `metrics.ts:68,
117` and `validate.ts:125` inline the predicate (one with a
contradicting comment). A rule change would apply to Hit/MRR but not
nDCG/Recall/validate. Fix: `qrelMatchesDoc(qrel, doc)` exported and
used everywhere.

**CLI-5 — Metric keys ×4.** `averageMetrics` (`metrics.ts:162-204`)
spells all seven keys in the zero object, accumulator, reducer body,
and divide; `report.ts` already has `METRIC_KEYS` but keeps it
private. Fix: move `METRIC_KEYS` to `types.ts`, derive
`MetricSummary`, fold with `Object.fromEntries`.

**CLI-6 — Handler altitude.** `search.ts:41-142` and
`project.ts:186-280` mix validation, transport, domain, formatting;
the search one re-lists all 11 result fields to widen readonly arrays.
Fix: extract `runSearch`/`runRebuild`; define `SearchResultRow` via
`Pick<>` over the core type.

**CLI-7 — Exit conventions.** `process.exit(n)` (36 sites),
`process.exitCode = n` (8), plain return; exit 2 used for "conflict"
in two files with no shared constant; three exits inside `try` in
`search.ts` skip `runtime.close()` in `finally`. Fix:
`EXIT = {ok, error, conflict} as const` + `fail(msg, code): never` in
`lib/context.ts`; in-try exits become `process.exitCode + return`.

**CLI-8 — find-usages render ×2.** Daemon path (`search.ts:194-220`)
rebuilds grouping the local path (`:255-269`) gets from
`findSymbolUsages`, with `as Array<…>` casts to defeat readonly, then
both print the same format, already drifted. Fix: normalize via
`Map.groupBy` + one `printUsages(groups, {absolute})`.

**CLI-9 — any[] into scoreRun.** `cmd/run.ts:56-62`:
`ReturnType<typeof Array.prototype.slice>` is `any[]`, so the scoring
entry point's input is unchecked and `QueryId` brands are dropped.
Fix: `Map<QueryId, ReadonlyArray<RankedDoc>>`.

**CLI-10 — (err as Error).message ×13.** Non-Error throws print
`failed: undefined` in exactly the diagnostic paths. The right idiom
already exists at `search.ts:89`. Fix: `errorMessage(err: unknown)`
helper, both packages.

**CLI-11 — Run JSON trusted at boundary.** `report.ts:27` /
`compare.ts:23-25` `as`-cast `JSON.parse` while qrels/TOML get
line-numbered validation; `renderCompare` compensates with `?? 0`.
Fix: `validateRunJson` following the `validateQrel` strategy; drop the
fallbacks.

**CLI-12 — nDCG nesting.** `metrics.ts:105-131` five levels deep with
a manual argmax; `scoreRun:239-248` hand-buckets what `Map.groupBy`
expresses. Fix: `bestUnconsumedMatch` helper + `Map.groupBy`.

Also noted: `start.ts` scheduler shape duplicated twice (extract
`makeRescheduler()` before a third periodic task); nofile-hint
prefixing duplicated; wizard/model network-consent sequence at two
copies (extract on the third); dead `void watchers;` unreachable block
at `start.ts:257-260`; brand casts `p.id as string` at three sites;
`scoreRun:228` silently defaults unknown query type to "concept".

### Tests

**TEST-1 — Indexer fixture ×4** (found by loctx `find_duplicates` over
its own index). The ~25-line `beforeEach` scaffold (tmp project +
`.git` marker + `StateStore` + `FakeEmbeddingProvider` +
`createVectorStore` + `ProjectIndexer`) repeats in
`indexer-concurrency.test.ts`, `reevaluate_filter.test.ts`,
`claude-dir-findability.test.ts`, `reconciler.test.ts`. Fix: a
`makeIndexerFixture(prefix)` helper in `tests/helpers/` next to the
existing `tmp.ts`. The other duplicate cluster the scan surfaced
(cli scenarios vs playwright.config) is heuristic noise from import
boilerplate; no action.

Coverage gaps worth closing while refactoring: `container.ts` (none),
`config-schema.ts` (none), web server destructive ops
(`ops.ts` rebuild/reset/restart, `projects.ts` activate/deactivate),
all web client components/hooks.

## Metrics baseline (2026-08-06)

- `: any` / `as any` in source: 4
- `@ts-ignore` + `@ts-expect-error`: 6
- Empty catch blocks: 0
- `as unknown as`: 56 total, 8 in production source
  (vectors.ts ×2, embeddings/local.ts ×2, analyzers/definitions.ts ×2,
  server/api/events.ts ×2 — the last pair is SRV-7)
- Base tsconfig: strict + noUncheckedIndexedAccess +
  exactOptionalPropertyTypes + verbatimModuleSyntax (full house
  contract)

## Proposed PR batches

Small, behavior-preserving, independently reviewable; each references
finding IDs.

1. **Correctness + safety (ship first).** SRV-1, SRV-2, SRV-7, CLI-2,
   CLI-4, CLI-9, WEB-5. Real bugs or silent data/metric loss, all S/M.
2. **Transport unification.** SRV-3, SRV-4, SRV-5, SRV-8, SRV-9,
   SRV-10. One input-spec + confinement layer in core; onError
   middleware.
3. **Descriptor tables in core.** CORE-1 (+ container test), CORE-2,
   CORE-3, CORE-4.
4. **Small core extractions.** CORE-5, CORE-7, CORE-8, CORE-9,
   CORE-10, CORE-11, CORE-12.
5. **Web: finish the stalled promotions.** WEB-1, WEB-6, WEB-8,
   WEB-11, WEB-12, then WEB-2/WEB-4 (query hook), then WEB-3, WEB-7,
   WEB-9, WEB-10.
6. **CLI/eval structure.** CLI-1, CLI-3, CLI-5, CLI-7, CLI-10, CLI-12,
   then CLI-6, CLI-8, CLI-11.
7. **Test fixtures.** TEST-1 + coverage gaps listed above.
