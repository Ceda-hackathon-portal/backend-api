-- Additive audit metadata and programme binding for assignment-backed officer reads.
-- Existing assignments without issuer metadata remain stored but fail closed in the scope provider.
ALTER TABLE "applications"
  ADD CONSTRAINT "applications_id_programme_id_key" UNIQUE ("id", "programme_id");

ALTER TABLE "officer_assignments"
  ADD COLUMN "issued_by_id" UUID,
  ADD COLUMN "issued_request_id" UUID,
  ADD COLUMN "request_hash" CHAR(64),
  ADD COLUMN "revoked_by_id" UUID,
  ADD COLUMN "revocation_reason" VARCHAR(1000),
  ADD COLUMN "revocation_request_id" UUID;

ALTER TABLE "conflict_disclosures"
  ADD COLUMN "disclosed_by_id" UUID,
  ADD COLUMN "disclosed_request_id" UUID,
  ADD COLUMN "resolved_by_id" UUID,
  ADD COLUMN "resolution_request_id" UUID;

ALTER TABLE "officer_assignments"
  ADD CONSTRAINT "officer_assignments_application_programme_fkey"
    FOREIGN KEY ("application_id", "programme_id")
    REFERENCES "applications"("id", "programme_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "officer_assignments_issued_by_id_fkey"
    FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "officer_assignments_revoked_by_id_fkey"
    FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "conflict_disclosures"
  ADD CONSTRAINT "conflict_disclosures_disclosed_by_id_fkey"
    FOREIGN KEY ("disclosed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "conflict_disclosures_resolved_by_id_fkey"
    FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "officer_assignments_live_scope_idx"
  ON "officer_assignments"("actor_id", "application_id", "submission_version_id", "programme_id", "status");
CREATE UNIQUE INDEX "officer_assignments_issued_request_id_key"
  ON "officer_assignments"("issued_request_id");
CREATE UNIQUE INDEX "officer_assignments_revocation_request_id_key"
  ON "officer_assignments"("revocation_request_id");
CREATE UNIQUE INDEX "conflict_disclosures_disclosed_request_id_key"
  ON "conflict_disclosures"("disclosed_request_id");
CREATE UNIQUE INDEX "conflict_disclosures_resolution_request_id_key"
  ON "conflict_disclosures"("resolution_request_id");

CREATE FUNCTION "lock_officer_assignment_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'pg_catalog, public'
AS $$
DECLARE
  scope_key TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    scope_key := 'officer-assignment-scope:' || NEW.actor_id::text || ':' || NEW.application_id::text || ':' || NEW.submission_version_id::text || ':' || NEW.programme_id::text;
    PERFORM pg_advisory_xact_lock(hashtextextended(scope_key, 0));
    RETURN NEW;
  END IF;

  scope_key := 'officer-assignment-scope:' || OLD.actor_id::text || ':' || OLD.application_id::text || ':' || OLD.submission_version_id::text || ':' || OLD.programme_id::text;
  PERFORM pg_advisory_xact_lock(hashtextextended(scope_key, 0));
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Officer assignments are append-only; revoke instead of deleting';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.application_id IS DISTINCT FROM NEW.application_id
    OR OLD.submission_version_id IS DISTINCT FROM NEW.submission_version_id
    OR OLD.programme_id IS DISTINCT FROM NEW.programme_id
    OR OLD.actor_id IS DISTINCT FROM NEW.actor_id
    OR OLD.issued_by_id IS DISTINCT FROM NEW.issued_by_id
    OR OLD.issued_request_id IS DISTINCT FROM NEW.issued_request_id
    OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
    OR OLD.valid_from IS DISTINCT FROM NEW.valid_from
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Officer assignment binding is immutable';
  END IF;

  IF OLD.status IS DISTINCT FROM 'ACTIVE' OR NEW.status IS DISTINCT FROM 'REVOKED'
    OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
    OR NEW.revoked_by_id IS NULL OR NEW.revocation_request_id IS NULL
    OR NEW.revocation_reason IS NULL OR length(trim(NEW.revocation_reason)) = 0 THEN
    RAISE EXCEPTION 'Officer assignments may only be revoked once with an audit identity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "officer_assignment_scope_lock"
  BEFORE INSERT OR UPDATE OR DELETE ON "officer_assignments"
  FOR EACH ROW EXECUTE FUNCTION "lock_officer_assignment_scope"();

-- Serialize conflict disclosure changes against the reader's shared transaction lock.
-- This makes INSERT/UPDATE/DELETE of disclosures participate in authorization ordering.
CREATE FUNCTION "lock_officer_conflict_scope"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'pg_catalog, public'
AS $$
DECLARE
  first_assignment UUID;
  second_assignment UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('officer-conflict:' || NEW.assignment_id::text, 0));
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('officer-conflict:' || OLD.assignment_id::text, 0));
    RETURN OLD;
  END IF;

  IF OLD.assignment_id = NEW.assignment_id THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('officer-conflict:' || NEW.assignment_id::text, 0));
  ELSE
    first_assignment := LEAST(OLD.assignment_id, NEW.assignment_id);
    second_assignment := GREATEST(OLD.assignment_id, NEW.assignment_id);
    PERFORM pg_advisory_xact_lock(hashtextextended('officer-conflict:' || first_assignment::text, 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('officer-conflict:' || second_assignment::text, 0));
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "officer_conflict_scope_lock"
  BEFORE INSERT OR UPDATE OR DELETE ON "conflict_disclosures"
  FOR EACH ROW EXECUTE FUNCTION "lock_officer_conflict_scope"();
