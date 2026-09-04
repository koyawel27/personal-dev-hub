-- 008_primary_local_binding (V1.2 M1)
--
-- Owner-locked decisions D1/D2/D5:
-- - local_repositories gains an explicit display-primary flag
--   (is_primary). The user-selectable primary is a PRESENTATION concern:
--   it changes what the UI shows as the project's primary local copy.
-- - It must NOT touch historical activity fingerprints. The internal
--   fingerprint anchor remains the deterministic MIN(local_repositories.id)
--   per project (see fingerprintAnchorLocalBindingId in ProjectService),
--   so changing the display primary can never re-key a logical event.
-- - Per D5 this migration owns the change for BOTH V1.1 upgrades and
--   fresh databases (schema.sql intentionally stays the old/base shape);
--   no duplicate-column guard exists and none is wanted.
--
-- Backfill: exactly one primary per project that has local bindings,
-- primary = MIN(id) — this reproduces the V1.1 effective-primary rule
-- (ORDER BY id ASC LIMIT 1) byte-for-byte.
--
-- The partial unique index enforces the invariant at the schema level:
-- at most one is_primary=1 row per project_id (rows with NULL project_id —
-- pre-004 legacy shapes — are unconstrained).
--
-- Anything short of a supported starting shape (column already present but
-- migration not recorded, index already present) fails LOUDLY here rather
-- than silently accepting a malformed schema.

ALTER TABLE local_repositories ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0
  CHECK (is_primary IN (0,1));

-- One explicit primary per project: the lowest existing binding id.
-- Subquery is scoped per row so the index build sees a consistent state.
UPDATE local_repositories
SET is_primary = 1
WHERE id = (
  SELECT MIN(lr2.id) FROM local_repositories lr2
  WHERE lr2.project_id = local_repositories.project_id
)
AND project_id IS NOT NULL;

CREATE UNIQUE INDEX idx_local_repo_project_primary
ON local_repositories(project_id)
WHERE project_id IS NOT NULL
  AND is_primary = 1;

-- verify-count: local_repositories