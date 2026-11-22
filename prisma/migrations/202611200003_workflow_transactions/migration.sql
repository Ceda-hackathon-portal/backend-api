BEGIN;
-- Never invent a historical check binding or command receipt for existing workflow rows.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM workflow_state) OR EXISTS (SELECT 1 FROM workflow_events) THEN
  RAISE EXCEPTION 'Existing workflow rows require approved eligibility and receipt history reconciliation';
 END IF;
END $$;
-- DropForeignKey
ALTER TABLE "workflow_state" DROP CONSTRAINT "workflow_state_submission_version_id_fkey";

-- DropForeignKey
ALTER TABLE "workflow_events" DROP CONSTRAINT "workflow_events_submission_version_id_fkey";

-- AlterTable
ALTER TABLE "workflow_state" ADD COLUMN     "eligibility_check_id" UUID NOT NULL;
ALTER TABLE "workflow_state" ALTER COLUMN "revision" SET DEFAULT 1;

-- AlterTable
ALTER TABLE "workflow_events" ADD COLUMN     "eligibility_check_id" UUID NOT NULL;

-- CreateTable
CREATE TABLE "workflow_command_receipts" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "change" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_command_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_audits" (
    "event_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_audits_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "workflow_outbox" (
    "event_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(3),

    CONSTRAINT "workflow_outbox_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workflow_command_receipts_event_id_key" ON "workflow_command_receipts"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_command_receipts_application_id_actor_id_key_key" ON "workflow_command_receipts"("application_id", "actor_id", "key");

-- CreateIndex
CREATE INDEX "workflow_audits_request_id_idx" ON "workflow_audits"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_events_id_application_id_actor_id_key" ON "workflow_events"("id", "application_id", "actor_id");

-- AddForeignKey
ALTER TABLE "workflow_state" ADD CONSTRAINT "workflow_state_submission_version_id_application_id_fkey" FOREIGN KEY ("submission_version_id", "application_id") REFERENCES "submission_versions"("id", "application_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_state" ADD CONSTRAINT "workflow_state_eligibility_check_id_application_id_submiss_fkey" FOREIGN KEY ("eligibility_check_id", "application_id", "submission_version_id") REFERENCES "eligibility_checks"("id", "application_id", "submission_version_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_submission_version_id_application_id_fkey" FOREIGN KEY ("submission_version_id", "application_id") REFERENCES "submission_versions"("id", "application_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_eligibility_check_id_application_id_submis_fkey" FOREIGN KEY ("eligibility_check_id", "application_id", "submission_version_id") REFERENCES "eligibility_checks"("id", "application_id", "submission_version_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_command_receipts" ADD CONSTRAINT "workflow_command_receipts_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_command_receipts" ADD CONSTRAINT "workflow_command_receipts_event_id_application_id_actor_id_fkey" FOREIGN KEY ("event_id", "application_id", "actor_id") REFERENCES "workflow_events"("id", "application_id", "actor_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_audits" ADD CONSTRAINT "workflow_audits_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "workflow_events"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "workflow_outbox" ADD CONSTRAINT "workflow_outbox_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "workflow_audits"("event_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE workflow_events ADD CONSTRAINT workflow_event_revision_positive CHECK (revision > 0);
ALTER TABLE workflow_command_receipts ADD CONSTRAINT workflow_receipt_valid CHECK (length(key) BETWEEN 1 AND 128 AND key ~ '^[A-Za-z0-9_-]+$' AND jsonb_typeof(change)='object');
CREATE TRIGGER immutable_workflow_receipt BEFORE UPDATE OR DELETE ON workflow_command_receipts FOR EACH ROW EXECUTE FUNCTION reject_domain_mutation();
CREATE TRIGGER immutable_workflow_audit BEFORE UPDATE OR DELETE ON workflow_audits FOR EACH ROW EXECUTE FUNCTION reject_domain_mutation();
CREATE TRIGGER immutable_workflow_outbox BEFORE UPDATE OF event_id, created_at OR DELETE ON workflow_outbox FOR EACH ROW EXECUTE FUNCTION reject_domain_mutation();
CREATE FUNCTION guard_workflow_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Workflow state cannot be deleted'; END IF;
 IF TG_OP='INSERT' AND NEW.revision<>1 THEN RAISE EXCEPTION 'Initial workflow transition must have revision one'; END IF;
 IF TG_OP='UPDATE' AND (NEW.application_id IS DISTINCT FROM OLD.application_id OR NEW.submission_version_id IS DISTINCT FROM OLD.submission_version_id OR NEW.eligibility_check_id IS DISTINCT FROM OLD.eligibility_check_id OR NEW.revision<>OLD.revision+1) THEN
  RAISE EXCEPTION 'Workflow binding is immutable and revisions must be consecutive';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_state_guard BEFORE INSERT OR UPDATE OR DELETE ON workflow_state FOR EACH ROW EXECUTE FUNCTION guard_workflow_state();

-- Deferred cross-table validation, evaluated only after the complete transaction.
CREATE FUNCTION check_workflow_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE app uuid; s workflow_state%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME IN ('workflow_state','workflow_events','workflow_command_receipts') THEN app:=NEW.application_id;
 ELSE SELECT application_id INTO app FROM workflow_events WHERE id=NEW.event_id; END IF;
 SELECT * INTO s FROM workflow_state WHERE application_id=app;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing workflow state'; END IF;
 IF NOT EXISTS (
  SELECT 1 FROM eligibility_checks c JOIN applications a ON a.id=c.application_id
  JOIN submission_versions v ON v.id=c.submission_version_id AND v.application_id=a.id
  WHERE c.id=s.eligibility_check_id AND a.id=app AND v.id=s.submission_version_id
   AND c.programme_id=a.programme_id AND c.programme_version_id=a.programme_version_id AND v.programme_version_id=a.programme_version_id
 ) THEN RAISE EXCEPTION 'Invalid workflow eligibility binding'; END IF;
 IF (SELECT count(*) FROM workflow_events WHERE application_id=app)<>s.revision
 OR NOT EXISTS (SELECT 1 FROM workflow_events WHERE application_id=app AND revision=s.revision AND next_state=s.state)
 THEN RAISE EXCEPTION 'Workflow state and history disagree'; END IF;
 IF EXISTS (
  SELECT 1 FROM workflow_events e
  LEFT JOIN workflow_command_receipts r ON r.event_id=e.id
  LEFT JOIN workflow_audits a ON a.event_id=e.id
  LEFT JOIN workflow_outbox o ON o.event_id=e.id
  WHERE e.application_id=app AND (
   e.submission_version_id<>s.submission_version_id OR e.eligibility_check_id<>s.eligibility_check_id
   OR r.id IS NULL OR a.event_id IS NULL OR o.event_id IS NULL
   OR (e.revision=1 AND e.previous_state<>'SUBMITTED')
   OR (e.revision>1 AND NOT EXISTS (SELECT 1 FROM workflow_events p WHERE p.application_id=app AND p.revision=e.revision-1 AND p.next_state=e.previous_state))
   OR (r.change->'after'->>'applicationId') IS DISTINCT FROM e.application_id::text
   OR (r.change->'after'->>'submissionVersionId') IS DISTINCT FROM e.submission_version_id::text
   OR (r.change->'after'->>'revision') IS DISTINCT FROM e.revision::text
   OR (r.change->'after'->>'state') IS DISTINCT FROM e.next_state
   OR (r.change->'before'->>'state') IS DISTINCT FROM e.previous_state
   OR (r.change->'before'->>'revision') IS DISTINCT FROM (e.revision-1)::text
   OR (r.change->'audit'->>'actorId') IS DISTINCT FROM e.actor_id::text
  )
 ) THEN RAISE EXCEPTION 'Missing or inconsistent atomic workflow records'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER workflow_state_commit AFTER INSERT OR UPDATE ON workflow_state DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_workflow_commit();
CREATE CONSTRAINT TRIGGER workflow_event_commit AFTER INSERT ON workflow_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_workflow_commit();
CREATE CONSTRAINT TRIGGER workflow_receipt_commit AFTER INSERT ON workflow_command_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_workflow_commit();
CREATE CONSTRAINT TRIGGER workflow_audit_commit AFTER INSERT ON workflow_audits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_workflow_commit();
CREATE CONSTRAINT TRIGGER workflow_outbox_commit AFTER INSERT ON workflow_outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_workflow_commit();
REVOKE ALL ON workflow_state,workflow_events,workflow_command_receipts,workflow_audits,workflow_outbox FROM PUBLIC;
COMMIT;
