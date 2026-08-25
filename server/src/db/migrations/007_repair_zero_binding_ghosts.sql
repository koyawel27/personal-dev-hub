-- 007_repair_zero_binding_ghosts
--
-- Reconciles pre-fix zero-binding Projects left behind by the old local
-- removal path (it deleted only the binding row and never evaluated the
-- owning Project). Purely structural: NO project names or ids are
-- hardcoded anywhere.
--
-- Classification mirrors the accepted Q1 lifecycle exactly:
--   zero bindings + no meaningful state  -> orphan; project deleted
--   zero bindings + meaningful state     -> retained deliberately; only
--       its masquerading label is corrected by deriveSourceState(), which
--       now reports these as "NO SOURCE" instead of "GITHUB ONLY"
--
-- Ordering constraint: activity_events.project_id is a bare FK (no cascade,
-- per migration 006), so routine-only bookkeeping events of orphan
-- candidates are removed BEFORE the projects themselves — mirroring
-- deleteProjectCascade(). Projects holding non-routine events fail the
-- step-2 predicate and are retained untouched.
--
-- Idempotent: on any database where no zero-binding empty project exists,
-- both statements are no-ops. Safe to re-run after a crash mid-repair.
--
-- Meaningful-state predicate is equivalent to
-- ProjectService.projectHasMeaningfulState(): user metadata, real commit
-- history (local or GitHub), or any non-routine activity event. The
-- local-commit subquery cannot fire for these rows (zero local bindings
-- remain) but is kept for byte-equivalence with the service rule.
-- repository_discovered / github_repo_tracked / github_repo_untracked /
-- github_binding_updated are routine system bookkeeping (owner decision).

-- Step 1: strip routine-only bookkeeping from orphan candidates so the
-- bare project_id FK does not block their deletion.
DELETE FROM activity_events
WHERE event_type IN (
      'repository_discovered', 'github_repo_tracked',
      'github_repo_untracked', 'github_binding_updated'
    )
AND project_id IN (
  SELECT p.id FROM projects p
  WHERE NOT EXISTS (SELECT 1 FROM local_repositories lr WHERE lr.project_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM github_repositories g WHERE g.project_id = p.id)
    AND p.project_status IS NULL
    AND p.project_type IS NULL
    AND p.project_note IS NULL
    AND p.include_in_portfolio = 0
    AND NOT EXISTS (
      SELECT 1 FROM github_commits gc WHERE gc.project_id = p.id
    )
);

-- Step 2: delete the now-provably-empty orphan projects.
DELETE FROM projects
WHERE NOT EXISTS (
  SELECT 1 FROM local_repositories lr WHERE lr.project_id = projects.id
)
AND NOT EXISTS (
  SELECT 1 FROM github_repositories g WHERE g.project_id = projects.id
)
AND project_status IS NULL
AND project_type IS NULL
AND project_note IS NULL
AND include_in_portfolio = 0
AND NOT EXISTS (
  SELECT 1 FROM commits c
  JOIN local_repositories lr2 ON lr2.id = c.local_repository_id
  WHERE lr2.project_id = projects.id
)
AND NOT EXISTS (
  SELECT 1 FROM github_commits gc WHERE gc.project_id = projects.id
)
AND NOT EXISTS (
  SELECT 1 FROM activity_events e
  WHERE e.project_id = projects.id
    AND e.event_type NOT IN (
      'repository_discovered', 'github_repo_tracked',
      'github_repo_untracked', 'github_binding_updated'
    )
);
