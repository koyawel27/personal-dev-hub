ALTER TABLE local_repositories ADD COLUMN project_status TEXT
  CHECK (project_status IS NULL OR project_status IN ('Active','Paused','Finished','Archived','Experiment'));

ALTER TABLE local_repositories ADD COLUMN project_type TEXT
  CHECK (project_type IS NULL OR project_type IN ('Personal','School','OJT','Client','Experiment','Other'));

ALTER TABLE local_repositories ADD COLUMN project_note TEXT;

ALTER TABLE local_repositories ADD COLUMN include_in_portfolio INTEGER NOT NULL DEFAULT 0;

ALTER TABLE local_repositories ADD COLUMN portfolio_order INTEGER;

-- Spec section 8.1 names the commit activity event "commit_observed".
UPDATE activity_events SET event_type = 'commit_observed' WHERE event_type = 'commit';
