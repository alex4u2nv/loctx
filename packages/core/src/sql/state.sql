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
SELECT id, name, root, last_indexed_at FROM projects ORDER BY root;

-- :name mark_project_indexed
UPDATE projects SET last_indexed_at = ? WHERE id = ?;

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
INSERT INTO chunks (chunk_id, file_id, start_line, end_line, kind, symbols)
VALUES (?, ?, ?, ?, ?, ?);

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
