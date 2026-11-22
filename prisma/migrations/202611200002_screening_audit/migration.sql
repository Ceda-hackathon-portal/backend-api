BEGIN;
LOCK TABLE eligibility_checks, audit_events IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM eligibility_checks) THEN
  RAISE EXCEPTION 'Existing screenings require verified historical audit mapping';
 END IF;
END $$;
CREATE UNIQUE INDEX audit_events_application_id_revision_key ON audit_events(application_id,revision);
DROP INDEX audit_events_application_id_revision_request_id_action_key;
CREATE TABLE eligibility_audits (
 check_id uuid PRIMARY KEY REFERENCES eligibility_checks(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 recorded_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_eligibility_audit BEFORE UPDATE OR DELETE ON eligibility_audits FOR EACH ROW EXECUTE FUNCTION reject_domain_mutation();
CREATE TABLE eligibility_outbox (
 check_id uuid PRIMARY KEY REFERENCES eligibility_audits(check_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 created_at timestamptz(3) NOT NULL DEFAULT now(), delivered_at timestamptz(3)
);
COMMIT;
