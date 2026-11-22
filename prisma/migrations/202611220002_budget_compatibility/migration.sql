ALTER TABLE applications
  ALTER COLUMN budget SET DEFAULT '{"items":[],"fundingRequested":"","notApplicable":false}'::jsonb;

ALTER TABLE submission_versions
  ALTER COLUMN budget SET DEFAULT '{"items":[],"fundingRequested":"","notApplicable":false}'::jsonb;
