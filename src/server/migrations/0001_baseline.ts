import type { DB } from '../db.js'
import type { Migration } from '../migrations.js'

/** DESIGN §6 数据模型 + §8 认证存储（FTS5 为独立表，chunk_id 不索引） */
const SQL = `
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','indexing','ready','failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_documents_status ON documents(status);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL,
  page INTEGER,
  heading_path TEXT,
  token_count INTEGER NOT NULL,
  UNIQUE (document_id, ord)
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id UNINDEXED, text);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '新会话',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  citations TEXT,
  model TEXT,
  usage TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_messages_session ON messages(session_id, id);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('cron','manual')),
  spec TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running','success','failed')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  output TEXT,
  error TEXT
);
CREATE INDEX idx_runs_job ON runs(job_id, id);

CREATE TABLE usage_records (
  id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('chat','background','embed','vision')),
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_est REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_usage_created ON usage_records(created_at);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE user_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE app_sessions (
  token TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

export const baseline: Migration = {
  name: '0001_baseline',
  up: (db: DB) => {
    db.exec(SQL)
  },
}
