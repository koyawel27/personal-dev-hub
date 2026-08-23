CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  project_status TEXT CHECK (project_status IS NULL OR
    project_status IN ('Active','Paused','Finished','Archived','Experiment')),
  project_type TEXT CHECK (project_type IS NULL OR
    project_type IN ('Personal','School','OJT','Client','Experiment','Other')),
  project_note TEXT,
  include_in_portfolio INTEGER NOT NULL DEFAULT 0,
  portfolio_order INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Deterministic 1:1 backfill: insertion order preserves local_repositories
-- id order, so the mapping below is stable and testable.
INSERT INTO projects (name, project_status, project_type, project_note,
                      include_in_portfolio, portfolio_order, created_at, updated_at)
SELECT name, project_status, project_type, project_note,
       include_in_portfolio, portfolio_order, created_at, created_at
FROM local_repositories ORDER BY id;

ALTER TABLE local_repositories ADD COLUMN project_id INTEGER REFERENCES projects(id);

UPDATE local_repositories
SET project_id = (
  SELECT p.id FROM projects p
  WHERE p.name = local_repositories.name
    AND p.created_at = local_repositories.created_at
    AND ((p.project_note IS local_repositories.project_note))
);

-- Deliberate design rule (owner-approved): NO uniqueness constraint on
-- project_id here — multiple local bindings per Project must remain
-- structurally possible.
