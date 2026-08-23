-- rebuild
-- 006_project_activity — isolated rebuild of activity_events.
--
-- Event ownership moves to Project; the local-binding reference becomes
-- nullable (GitHub-origin events have no local checkout). Legacy repo-scoped
-- fingerprints are rewritten deterministically to project scope:
--   "{repoId}:{rest}" -> "p{projectId}:{repoId}:{rest}"
-- The transform is injective (repoId -> projectId is 1:1 from 004), so the
-- UNIQUE constraint survives; any collision fails the whole migration.
--
-- Safety properties enforced here:
-- - LEFT JOIN + NOT NULL project_id: an unmapped binding FAILS the insert
--   loudly instead of silently dropping the event.
-- - Historical id, type, summary, timestamps, source, and metadata_json are
--   copied byte-for-byte.

CREATE TABLE activity_events_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  local_repository_id INTEGER REFERENCES local_repositories(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'scan',
  fingerprint TEXT NOT NULL UNIQUE,
  metadata_json TEXT
);

INSERT INTO activity_events_v2
  (id, project_id, local_repository_id, event_type, summary, occurred_at,
   source, fingerprint, metadata_json)
SELECT e.id,
       lr.project_id,
       e.local_repository_id,
       e.event_type,
       e.summary,
       e.occurred_at,
       e.source,
       'p' || lr.project_id || ':' || e.fingerprint,
       e.metadata_json
FROM activity_events e
LEFT JOIN local_repositories lr ON lr.id = e.local_repository_id;

DROP TABLE activity_events;
ALTER TABLE activity_events_v2 RENAME TO activity_events;

-- verify-count: activity_events

CREATE INDEX IF NOT EXISTS idx_activity_repo_occurred
  ON activity_events (local_repository_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_occurred
  ON activity_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_project_occurred
  ON activity_events (project_id, occurred_at DESC);
