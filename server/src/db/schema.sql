CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  canonical_path TEXT NOT NULL UNIQUE,
  scan_depth INTEGER NOT NULL DEFAULT 3,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_scanned_at TEXT
);

CREATE TABLE IF NOT EXISTS local_repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NULL REFERENCES project_sources(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  local_path TEXT NOT NULL,
  canonical_path TEXT NOT NULL UNIQUE,
  discovery_type TEXT NOT NULL CHECK (discovery_type IN ('scanned', 'manual')),
  created_at TEXT NOT NULL,
  last_scanned_at TEXT
);

CREATE TABLE IF NOT EXISTS github_repositories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  visibility TEXT,
  default_branch TEXT,
  html_url TEXT,
  last_pushed_at TEXT,
  last_refreshed_at TEXT,
  UNIQUE (owner, name)
);

CREATE TABLE IF NOT EXISTS repository_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_repository_id INTEGER NOT NULL REFERENCES local_repositories(id) ON DELETE CASCADE,
  branch TEXT,
  head_commit_sha TEXT,
  is_dirty INTEGER NOT NULL,
  modified_count INTEGER NOT NULL,
  staged_count INTEGER NOT NULL,
  untracked_count INTEGER NOT NULL,
  upstream_ref TEXT,
  ahead_count INTEGER,
  behind_count INTEGER,
  captured_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_repo_captured
  ON repository_snapshots (local_repository_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS git_remotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_repository_id INTEGER NOT NULL REFERENCES local_repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  host TEXT,
  owner TEXT,
  repository_name TEXT,
  github_repository_id INTEGER NULL REFERENCES github_repositories(id) ON DELETE SET NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  UNIQUE (local_repository_id, name)
);

CREATE TABLE IF NOT EXISTS commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_repository_id INTEGER NOT NULL REFERENCES local_repositories(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  subject TEXT NOT NULL,
  author_name TEXT,
  committed_at TEXT,
  first_seen_at TEXT NOT NULL,
  UNIQUE (local_repository_id, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_commits_repo_committed
  ON commits (local_repository_id, committed_at DESC);

CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  local_repository_id INTEGER NOT NULL REFERENCES local_repositories(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'scan',
  fingerprint TEXT NOT NULL UNIQUE,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_repo_occurred
  ON activity_events (local_repository_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_occurred
  ON activity_events (occurred_at DESC);
