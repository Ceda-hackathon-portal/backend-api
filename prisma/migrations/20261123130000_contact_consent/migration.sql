-- Keep subscription consent separate from the declaration for processing a submission.
ALTER TABLE alert_preferences ADD COLUMN contact_consent_version varchar(32), ADD COLUMN contact_consent_at timestamptz;
