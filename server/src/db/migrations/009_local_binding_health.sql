-- 009_local_binding_health (V1.2 M2)
--
-- Cached local-binding health (M2-D):
-- - local_repositories gains last_health_state / last_health_checked_at so
--   the database can persist the outcome of the last EXPLICIT inspection:
--   "this tracked path existed and was checked, and it was (or was not) a
--   Git worktree at that moment."
-- - Only cached Git-verdict states are persisted: 'OK' and 'NOT_A_GIT_REPO'.
--   PATH_MISSING and UNSCANNED are DERIVED at read time (live filesystem
--   existence check / absent cache) and must never be stored.
-- - 'OK' means "OK as of the last explicit scan/refresh" — never a claim of
--   live verification during page rendering.
-- - The last valid historical snapshot is unrelated to health: a failed
--   later check writes health only and never deletes or fakes snapshots.
--
-- Per the M1 migration architecture, schema.sql stays the historical/base
-- shape; this migration owns the change for BOTH V1.1/V1.2-M1 upgrade
-- databases and fresh databases (applied through the normal ordered
-- runner; no duplicate-column guard, unsupported shapes fail loudly).
--
-- Backfill: a binding whose last_scanned_at is set was successfully
-- inspected at that moment (every successful inspect/persist implies a Git
-- worktree), so it backfills to OK with checked_at = last_scanned_at.
-- Bindings never successfully scanned remain NULL/NULL (UNSCANNED at read
-- time).

ALTER TABLE local_repositories ADD COLUMN last_health_state TEXT NULL
  CHECK (
    last_health_state IS NULL
    OR last_health_state IN ('OK', 'NOT_A_GIT_REPO')
  );

ALTER TABLE local_repositories ADD COLUMN last_health_checked_at TEXT NULL;

UPDATE local_repositories
SET last_health_state = 'OK',
    last_health_checked_at = last_scanned_at
WHERE last_scanned_at IS NOT NULL;
