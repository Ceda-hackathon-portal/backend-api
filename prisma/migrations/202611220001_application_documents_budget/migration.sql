ALTER TABLE applications ADD COLUMN budget jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE submission_versions ADD COLUMN budget jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE application_documents (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  submission_version_id uuid REFERENCES submission_versions(id) ON DELETE RESTRICT,
  category varchar(64) NOT NULL,
  original_name varchar(200) NOT NULL,
  content_type varchar(100) NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  expires_at date,
  storage_key uuid NOT NULL UNIQUE,
  uploaded_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX application_documents_application_uploaded_idx ON application_documents(application_id, uploaded_at);
CREATE INDEX application_documents_submission_idx ON application_documents(submission_version_id);
