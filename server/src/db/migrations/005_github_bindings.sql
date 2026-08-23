-- 005_github_bindings
-- Promote the github_repositories enrichment cache into first-class project
-- bindings: project linkage, picker metadata, normalized identity, and the
-- GitHub commit store. Existing enrichment data is preserved verbatim.

ALTER TABLE github_repositories ADD COLUMN project_id INTEGER REFERENCES projects(id);
ALTER TABLE github_repositories ADD COLUMN tracked_at TEXT;
ALTER TABLE github_repositories ADD COLUMN archived INTEGER;
ALTER TABLE github_repositories ADD COLUMN fork INTEGER;
ALTER TABLE github_repositories ADD COLUMN description TEXT;
ALTER TABLE github_repositories ADD COLUMN language TEXT;

-- Normalized identity (host is constant github.com; identity = owner/name,
-- compared case-insensitively). Deterministic backfill of existing rows.
ALTER TABLE github_repositories ADD COLUMN owner_norm TEXT;
ALTER TABLE github_repositories ADD COLUMN name_norm TEXT;
UPDATE github_repositories SET owner_norm = lower(owner), name_norm = lower(name);

-- Identity uniqueness: a case-variant duplicate in legacy cache data makes
-- this migration FAIL LOUDLY rather than silently merging (per plan).
CREATE UNIQUE INDEX idx_gh_repo_norm ON github_repositories(owner_norm, name_norm);

-- At most one GitHub binding per project (partial: untracked cache rows have
-- project_id NULL and may share identities freely at the binding level).
CREATE UNIQUE INDEX idx_gh_repo_project ON github_repositories(project_id)
  WHERE project_id IS NOT NULL;

-- GitHub-observed commits for tracked bindings (GitHub-only projects have no
-- local commits rows). Dedup enforced by UNIQUE(github_repository_id, sha).
CREATE TABLE IF NOT EXISTS github_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  github_repository_id INTEGER NOT NULL REFERENCES github_repositories(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  subject TEXT,
  author_name TEXT,
  committed_at TEXT,
  fetched_at TEXT NOT NULL,
  UNIQUE (github_repository_id, commit_sha)
);
CREATE INDEX IF NOT EXISTS idx_github_commits_day ON github_commits (committed_at);
