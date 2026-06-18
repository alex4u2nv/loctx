-- loctx state-DB queries.
--
-- Sections are loaded by ``loctx.sql.load_queries`` and addressed by the name
-- in the ``-- :name <ident>`` marker. Bodies may span multiple statements;
-- ``schema_v1`` is run with ``executescript``, single-statement queries with
-- ``execute``.

-- :name schema_v1
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root TEXT NOT NULL,
    last_indexed_at TEXT
);

CREATE TABLE IF NOT EXISTS files (
    file_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime REAL NOT NULL,
    content_sha TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    embedding_identity TEXT NOT NULL,
    error TEXT,
    UNIQUE(project_id, rel_path)
);

CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);

CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    kind TEXT NOT NULL,
    symbols TEXT
);

CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);

CREATE TABLE IF NOT EXISTS collections (
    name TEXT PRIMARY KEY,
    identity TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

-- :name schema_v2
-- BM25 / FTS5 lexical index over chunks. Coexists with the LanceDB vector
-- store; together they back hybrid retrieval (vector + lexical + RRF).
--
-- Columns:
--   chunk_id, file_id, project_id, rel_path  — stored but not indexed
--                                              (UNINDEXED keeps them out of
--                                              the term dictionary; we use
--                                              them for filtering + join).
--   document                                  — chunk body, BM25-ranked.
--   symbols                                   — function/class names or
--                                              markdown heading path; lets
--                                              symbol queries land at the top.
--
-- Tokenizer: porter for English stemming, unicode61 for Unicode normalization.
-- Reasonable default for the mixed code+prose corpus loctx targets.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED,
    file_id UNINDEXED,
    project_id UNINDEXED,
    rel_path UNINDEXED,
    document,
    symbols,
    tokenize = 'porter unicode61'
);

-- :name schema_v3
-- Analyzer metadata + symbol cross-reference graph (#58).
--
-- chunks gains two columns:
--   metadata_json  — JSON-encoded AnalyzerMetadata (imports/calls/depth
--                    /etc.). NULL for chunks indexed before v3.
--   symbol_def     — primary symbol the chunk defines (function/class
--                    name). Indexed for fast symbol-lookup queries.
--
-- symbol_refs is the cross-reference graph that #96 populates: every
-- definition + call site discoverable per (project, symbol, kind).
ALTER TABLE chunks ADD COLUMN metadata_json TEXT;
ALTER TABLE chunks ADD COLUMN symbol_def TEXT;
CREATE INDEX IF NOT EXISTS idx_chunks_symbol_def ON chunks(symbol_def);

CREATE TABLE IF NOT EXISTS symbol_refs (
    symbol TEXT NOT NULL,
    project_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    line INTEGER NOT NULL,
    kind TEXT NOT NULL  -- 'def' | 'call' | 'import' | 'reference'
);
CREATE INDEX IF NOT EXISTS idx_symbol_refs_lookup
    ON symbol_refs(project_id, symbol, kind);
CREATE INDEX IF NOT EXISTS idx_symbol_refs_chunk ON symbol_refs(chunk_id);

-- :name schema_v4
-- Reconciliation tracking (#14). One column on `projects`; null until
-- the first reconciliation pass writes a timestamp. Surfaced in
-- `loctx doctor` and the MCP `workspace_status` payload.
ALTER TABLE projects ADD COLUMN last_reconciled_at TEXT;

-- :name schema_v5
-- Background analyzer enrichments (#61, #62, #64, #65). One row per
-- (file, analyzer) — analyzers store their findings against the file
-- they ran on, keyed by content_sha so stale entries are easy to
-- detect during reconciliation.
CREATE TABLE IF NOT EXISTS file_enrichments (
    file_id TEXT NOT NULL,
    analyzer TEXT NOT NULL,
    analyzer_version INTEGER NOT NULL,
    content_sha TEXT NOT NULL,
    status TEXT NOT NULL,           -- 'complete' | 'failed' | 'skipped'
    payload_json TEXT,
    error TEXT,
    enqueued_at TEXT,
    completed_at TEXT,
    PRIMARY KEY (file_id, analyzer)
);
CREATE INDEX IF NOT EXISTS idx_file_enrichments_analyzer
    ON file_enrichments(analyzer);

-- :name schema_v6
-- Project activation. Discovery still walks workspace_roots and finds
-- every project marker, but the indexer / watcher / reconciler only
-- operate on rows where active=1. New projects default to inactive;
-- existing rows migrate to active=1 to preserve behaviour for users
-- who already had their workspace indexed.
ALTER TABLE projects ADD COLUMN active INTEGER NOT NULL DEFAULT 0;
UPDATE projects SET active = 1;

-- :name schema_v7
-- Rebuild intent persistence. /api/rebuild and `loctx rebuild` set this
-- column to the kickoff ISO timestamp. The startup reconciler reorders
-- its queue so pending-rebuild projects go first, and pre-populates the
-- in-memory RebuildTracker so the UI immediately shows "resuming
-- rebuild…". Cleared by the indexer on a successful pass.
ALTER TABLE projects ADD COLUMN rebuild_pending_at TEXT;

-- :name schema_v8
-- MCP request log (#380-era). One row per `tools/call` an agent issues,
-- captured in the shared registry dispatch so both the stdio binary and
-- the web /mcp transport feed the same table. Powers the admin "logs"
-- page for quality-tuning tool descriptions against real agent traffic.
--
--   tool            — wire tool name (search_workspace, find_usages, ...).
--   arguments_json  — the full request arguments the agent sent.
--   response_json   — the full result payload returned (NULL on error).
--   error           — error message when the call failed (NULL on success).
--   ok              — 1 success / 0 error, so the UI can filter without
--                     re-parsing the payload.
--   elapsed_ms      — wall-clock handler time.
--
-- Bounded by `mcp.log_max_rows` (default 200): each insert trims the
-- table back to the newest N rows by `id` (see trim_mcp_requests).
CREATE TABLE IF NOT EXISTS mcp_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requested_at TEXT NOT NULL,
    tool TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    response_json TEXT,
    error TEXT,
    ok INTEGER NOT NULL,
    elapsed_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_requests_at ON mcp_requests(requested_at);

-- :name pragma_enable_foreign_keys
PRAGMA foreign_keys = ON;

-- :name pragma_journal_wal
PRAGMA journal_mode = WAL;

-- :name pragma_get_user_version
PRAGMA user_version;

-- :name upsert_project
INSERT INTO projects (id, name, root)
VALUES (?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    root = excluded.root;

-- :name get_project
SELECT id, name, root FROM projects WHERE id = ?;

-- :name list_projects
SELECT id, name, root, last_indexed_at, last_reconciled_at, active FROM projects ORDER BY root;

-- :name set_project_active
UPDATE projects SET active = ? WHERE id = ?;

-- :name upsert_project_active
INSERT INTO projects (id, name, root, active)
VALUES (?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    root = excluded.root,
    active = excluded.active;

-- :name mark_project_indexed
UPDATE projects SET last_indexed_at = ? WHERE id = ?;

-- :name mark_project_reconciled
UPDATE projects SET last_reconciled_at = ? WHERE id = ?;

-- :name mark_project_rebuild_pending
UPDATE projects SET rebuild_pending_at = ? WHERE id = ?;

-- :name clear_project_rebuild_pending
UPDATE projects SET rebuild_pending_at = NULL WHERE id = ?;

-- :name list_projects_with_rebuild_pending
SELECT id, name, root, rebuild_pending_at FROM projects
WHERE rebuild_pending_at IS NOT NULL
ORDER BY rebuild_pending_at;

-- :name upsert_file
INSERT INTO files (
    file_id, project_id, rel_path, size, mtime, content_sha,
    indexed_at, embedding_identity, error
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(file_id) DO UPDATE SET
    size = excluded.size,
    mtime = excluded.mtime,
    content_sha = excluded.content_sha,
    indexed_at = excluded.indexed_at,
    embedding_identity = excluded.embedding_identity,
    error = excluded.error;

-- :name get_file
SELECT file_id, project_id, rel_path, size, mtime, content_sha,
       indexed_at, embedding_identity, error
FROM files
WHERE project_id = ? AND rel_path = ?;

-- :name list_files
SELECT file_id, project_id, rel_path, size, mtime, content_sha,
       indexed_at, embedding_identity, error
FROM files
WHERE project_id = ?
ORDER BY rel_path;

-- :name list_files_missing_enrichment
-- Files in a project that have no up-to-date `complete` enrichment for a
-- given analyzer+version (matched on the file's current content_sha).
-- Drives the analyzer backfill when a feature is enabled after indexing:
-- only the gaps are re-run, and only that analyzer — embeddings untouched.
-- Params: project_id, analyzer, analyzer_version.
SELECT f.file_id, f.rel_path, f.content_sha
FROM files f
WHERE f.project_id = ?
  AND NOT EXISTS (
    SELECT 1 FROM file_enrichments e
    WHERE e.file_id = f.file_id
      AND e.analyzer = ?
      AND e.analyzer_version = ?
      AND e.content_sha = f.content_sha
      AND e.status = 'complete'
  )
ORDER BY f.rel_path;

-- :name delete_file
DELETE FROM files WHERE project_id = ? AND rel_path = ?;

-- :name delete_chunks_for_file
DELETE FROM chunks WHERE file_id = ?;

-- :name insert_chunk
INSERT OR IGNORE INTO chunks (
    chunk_id, file_id, start_line, end_line, kind, symbols,
    metadata_json, symbol_def
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?);

-- :name list_chunks
SELECT chunk_id, file_id, start_line, end_line, kind, symbols
FROM chunks
WHERE file_id = ?
ORDER BY start_line;

-- :name insert_chunk_fts
INSERT INTO chunks_fts (chunk_id, file_id, project_id, rel_path, document, symbols)
VALUES (?, ?, ?, ?, ?, ?);

-- :name delete_chunks_fts_for_file
DELETE FROM chunks_fts WHERE file_id = ?;

-- :name delete_chunks_fts_for_project
DELETE FROM chunks_fts WHERE project_id = ?;

-- :name probe_fts5_match
-- Benign FTS5 MATCH used by `loctx doctor` to confirm SQLite was built
-- with FTS5 support AND the chunks_fts virtual table is queryable. The
-- token "_loctx_probe_" is unlikely to appear in real content; returns
-- 0 rows on a healthy index regardless of size, and throws if the
-- FTS5 module is missing or the table is corrupt.
SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH '_loctx_probe_' LIMIT 1;

-- :name probe_fts5_count
SELECT count(*) AS n FROM chunks_fts;

-- :name delete_chunks_for_project
DELETE FROM chunks WHERE file_id IN (SELECT file_id FROM files WHERE project_id = ?);

-- :name delete_files_for_project
DELETE FROM files WHERE project_id = ?;

-- :name delete_project
DELETE FROM projects WHERE id = ?;

-- :name upsert_file_enrichment
INSERT INTO file_enrichments (
    file_id, analyzer, analyzer_version, content_sha, status,
    payload_json, error, enqueued_at, completed_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(file_id, analyzer) DO UPDATE SET
    analyzer_version = excluded.analyzer_version,
    content_sha = excluded.content_sha,
    status = excluded.status,
    payload_json = excluded.payload_json,
    error = excluded.error,
    enqueued_at = excluded.enqueued_at,
    completed_at = excluded.completed_at;

-- :name get_file_enrichment
SELECT analyzer, analyzer_version, content_sha, status, payload_json, error,
       enqueued_at, completed_at
FROM file_enrichments
WHERE file_id = ? AND analyzer = ?;

-- :name list_file_enrichments_by_analyzer
SELECT file_id, analyzer_version, content_sha, status, payload_json, error,
       enqueued_at, completed_at
FROM file_enrichments
WHERE analyzer = ?
ORDER BY file_id;

-- :name delete_file_enrichments_for_file
DELETE FROM file_enrichments WHERE file_id = ?;

-- :name insert_symbol_ref
INSERT INTO symbol_refs (symbol, project_id, file_id, chunk_id, line, kind)
VALUES (?, ?, ?, ?, ?, ?);

-- :name delete_symbol_refs_for_file
DELETE FROM symbol_refs WHERE file_id = ?;

-- :name delete_symbol_refs_for_project
DELETE FROM symbol_refs WHERE project_id = ?;

-- :name find_symbol_in_project
-- Definitions + references (calls/imports/reference) for a single symbol
-- in a single project. Caller splits into defs + refs by `kind`. Files
-- joined for rel_path; chunks for line range; chunks_fts for the chunk
-- body (the chunks base table doesn't hold content — it lives in the
-- FTS5 virtual table) so the UI can show a snippet modal in one
-- round-trip.
SELECT s.symbol, s.project_id, s.file_id, s.chunk_id, s.line, s.kind,
       f.rel_path AS rel_path,
       c.start_line AS chunk_start, c.end_line AS chunk_end,
       cf.document AS document
FROM symbol_refs s
INNER JOIN files f ON s.file_id = f.file_id
INNER JOIN chunks c ON s.chunk_id = c.chunk_id
INNER JOIN chunks_fts cf ON cf.chunk_id = s.chunk_id
WHERE s.project_id = ? AND s.symbol = ?
ORDER BY s.kind, f.rel_path, s.line;

-- :name search_lexical_all
SELECT chunks_fts.chunk_id, chunks_fts.file_id, chunks_fts.project_id, chunks_fts.rel_path,
       chunks_fts.document, chunks_fts.symbols,
       c.start_line, c.end_line, c.kind,
       bm25(chunks_fts) AS rank
FROM chunks_fts
INNER JOIN chunks AS c ON chunks_fts.chunk_id = c.chunk_id
WHERE chunks_fts MATCH ?
ORDER BY bm25(chunks_fts)
LIMIT ?;

-- :name search_lexical_project
SELECT chunks_fts.chunk_id, chunks_fts.file_id, chunks_fts.project_id, chunks_fts.rel_path,
       chunks_fts.document, chunks_fts.symbols,
       c.start_line, c.end_line, c.kind,
       bm25(chunks_fts) AS rank
FROM chunks_fts
INNER JOIN chunks AS c ON chunks_fts.chunk_id = c.chunk_id
WHERE chunks_fts MATCH ?
  AND chunks_fts.project_id = ?
ORDER BY bm25(chunks_fts)
LIMIT ?;

-- :name search_lexical_subtree
SELECT chunks_fts.chunk_id, chunks_fts.file_id, chunks_fts.project_id, chunks_fts.rel_path,
       chunks_fts.document, chunks_fts.symbols,
       c.start_line, c.end_line, c.kind,
       bm25(chunks_fts) AS rank
FROM chunks_fts
INNER JOIN chunks AS c ON chunks_fts.chunk_id = c.chunk_id
WHERE chunks_fts MATCH ?
  AND chunks_fts.project_id = ?
  AND chunks_fts.rel_path LIKE ?
ORDER BY bm25(chunks_fts)
LIMIT ?;

-- :name get_collection_identity
SELECT identity FROM collections WHERE name = ?;

-- :name insert_collection
INSERT INTO collections (name, identity, created_at) VALUES (?, ?, ?);

-- :name count_chunks_by_project
-- Aggregate chunk counts per project. Used by the admin projects table.
SELECT files.project_id AS project_id,
       COUNT(chunks.chunk_id) AS n
FROM chunks
INNER JOIN files ON chunks.file_id = files.file_id
GROUP BY files.project_id;

-- :name list_indexed_files_with_chunks
-- One row per successfully-indexed file with its chunk count and
-- indexed_at timestamp. Used by /api/projects/:id stats (byExtension,
-- topFiles, recentFiles).
SELECT files.rel_path AS rel_path,
       files.indexed_at AS indexed_at,
       COUNT(chunks.chunk_id) AS chunks
FROM files
LEFT JOIN chunks ON chunks.file_id = files.file_id
WHERE files.project_id = ?
  AND files.error IS NULL
GROUP BY files.file_id;

-- :name list_failing_files
-- Files whose last index attempt errored. Used by /api/projects/:id
-- "files that failed to index" panel.
SELECT rel_path, error
FROM files
WHERE project_id = ?
  AND error IS NOT NULL
ORDER BY rel_path;

-- :name find_literal_matches
-- Substring scan over indexed chunk text (chunks_fts.document). Used by
-- find_literal — the audit-shape tool that complements ranked
-- search_workspace. The escape character is '\' so callers that want
-- to match a literal %, _, or \ can pre-escape them. ORDER BY keeps
-- consumers' line-merge logic simple.
--
-- Constraint: this scans the FTS5 text, which holds the canonical
-- chunk body. Lines outside any chunk (chunker gaps — see #360) are
-- not searched. Callers needing total file coverage should
-- supplement with a direct fs scan.
SELECT chunks_fts.chunk_id     AS chunk_id,
       chunks_fts.file_id      AS file_id,
       chunks_fts.project_id   AS project_id,
       chunks_fts.rel_path     AS rel_path,
       chunks_fts.document     AS document,
       chunks.start_line       AS start_line,
       chunks.end_line         AS end_line,
       chunks.kind             AS kind,
       projects.name           AS project_name
FROM chunks_fts
INNER JOIN chunks   ON chunks.chunk_id   = chunks_fts.chunk_id
INNER JOIN files    ON files.file_id     = chunks_fts.file_id
INNER JOIN projects ON projects.id       = chunks_fts.project_id
WHERE chunks_fts.document LIKE ? ESCAPE '\'
  AND files.error IS NULL
ORDER BY chunks_fts.rel_path, chunks.start_line;

-- :name count_files_indexed_since
-- Number of file rows in a project whose `indexed_at` is at or after
-- `since`. Used by /api/projects to derive live rebuild progress
-- from committed work when the in-memory RebuildTracker isn't being
-- driven (e.g. when the boot reconciler resumes a rebuild_pending
-- project — the reconciler lives in @loctx/core and doesn't know
-- about the tracker which lives in apps/web).
SELECT COUNT(*) AS n
FROM files
WHERE project_id = ?
  AND indexed_at IS NOT NULL
  AND indexed_at >= ?;

-- :name insert_mcp_request
INSERT INTO mcp_requests (requested_at, tool, arguments_json, response_json, error, ok, elapsed_ms)
VALUES (?, ?, ?, ?, ?, ?, ?);

-- :name trim_mcp_requests
-- Keep only the newest `?` rows (highest ids). Run after every insert so
-- the table never grows past `mcp.log_max_rows`. Cheap: the subquery
-- scans an already-tiny table ordered by the integer primary key.
DELETE FROM mcp_requests
WHERE id NOT IN (
    SELECT id FROM mcp_requests ORDER BY id DESC LIMIT ?
);

-- :name list_mcp_requests
SELECT id, requested_at, tool, arguments_json, response_json, error, ok, elapsed_ms
FROM mcp_requests
ORDER BY id DESC
LIMIT ?;

-- :name count_mcp_requests
SELECT COUNT(*) AS n FROM mcp_requests;

-- :name delete_all_mcp_requests
DELETE FROM mcp_requests;
