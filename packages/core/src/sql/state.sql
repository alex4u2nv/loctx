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
-- joined so the caller can present rel_path without a second round-trip.
SELECT s.symbol, s.project_id, s.file_id, s.chunk_id, s.line, s.kind,
       f.rel_path AS rel_path,
       c.start_line AS chunk_start, c.end_line AS chunk_end
FROM symbol_refs s
INNER JOIN files f ON s.file_id = f.file_id
INNER JOIN chunks c ON s.chunk_id = c.chunk_id
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
