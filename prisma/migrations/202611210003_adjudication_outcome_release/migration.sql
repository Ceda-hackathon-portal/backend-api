BEGIN;

CREATE TABLE "adjudication_decisions" (
  "id" UUID NOT NULL,
  "application_id" UUID NOT NULL,
  "submission_version_id" UUID NOT NULL,
  "programme_id" UUID NOT NULL,
  "adjudicator_id" UUID NOT NULL,
  "outcome" VARCHAR(32) NOT NULL,
  "reason" VARCHAR(4000) NOT NULL,
  "workflow_revision" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "released_at" TIMESTAMPTZ(3),
  CONSTRAINT "adjudication_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "adjudication_decisions_outcome_check" CHECK ("outcome" IN ('APPROVED','REJECTED','REVISION_REQUESTED')),
  CONSTRAINT "adjudication_decisions_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "adjudication_decisions_revision_check" CHECK ("workflow_revision" > 0),
  CONSTRAINT "adjudication_decisions_application_programme_fkey" FOREIGN KEY ("application_id","programme_id") REFERENCES "applications"("id","programme_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "adjudication_decisions_submission_fkey" FOREIGN KEY ("submission_version_id","application_id") REFERENCES "submission_versions"("id","application_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "adjudication_decisions_adjudicator_fkey" FOREIGN KEY ("adjudicator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "adjudication_decisions_application_id_key" ON "adjudication_decisions"("application_id");
CREATE UNIQUE INDEX "adjudication_decisions_id_application_submission_key" ON "adjudication_decisions"("id","application_id","submission_version_id");
CREATE UNIQUE INDEX "adjudication_decisions_application_programme_key" ON "adjudication_decisions"("application_id","programme_id");
CREATE UNIQUE INDEX "adjudication_decisions_submission_application_key" ON "adjudication_decisions"("submission_version_id","application_id");
CREATE INDEX "adjudication_decisions_programme_outcome_created_idx" ON "adjudication_decisions"("programme_id","outcome","created_at");

CREATE TABLE "decision_audits" (
  "id" UUID NOT NULL,
  "decision_id" UUID NOT NULL,
  "application_id" UUID NOT NULL,
  "submission_version_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "workflow_revision" INTEGER NOT NULL,
  "request_id" UUID NOT NULL,
  "action" VARCHAR(32) NOT NULL,
  "reason" VARCHAR(4000) NOT NULL,
  "outcome" VARCHAR(32) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "decision_audits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "decision_audits_action_check" CHECK ("action" IN ('DECISION_RECORDED','DECISION_RELEASED')),
  CONSTRAINT "decision_audits_revision_check" CHECK ("workflow_revision" > 0),
  CONSTRAINT "decision_audits_decision_fkey" FOREIGN KEY ("decision_id","application_id","submission_version_id") REFERENCES "adjudication_decisions"("id","application_id","submission_version_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "decision_audits_application_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "decision_audits_submission_fkey" FOREIGN KEY ("submission_version_id","application_id") REFERENCES "submission_versions"("id","application_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "decision_audits_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "decision_audits_request_id_key" ON "decision_audits"("request_id");
CREATE UNIQUE INDEX "decision_audits_id_application_actor_key" ON "decision_audits"("id","application_id","actor_id");
CREATE UNIQUE INDEX "decision_audits_decision_action_key" ON "decision_audits"("decision_id","action");
CREATE INDEX "decision_audits_application_created_idx" ON "decision_audits"("application_id","created_at");

CREATE TABLE "decision_outbox" (
  "audit_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "decision_outbox_pkey" PRIMARY KEY ("audit_id"),
  CONSTRAINT "decision_outbox_audit_fkey" FOREIGN KEY ("audit_id") REFERENCES "decision_audits"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE "decision_command_receipts" (
  "id" UUID NOT NULL,
  "application_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "key" VARCHAR(128) NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "audit_id" UUID NOT NULL,
  "result" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "decision_command_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "decision_command_receipts_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "decision_command_receipts_audit_fkey" FOREIGN KEY ("audit_id","application_id","actor_id") REFERENCES "decision_audits"("id","application_id","actor_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "decision_command_receipts_application_actor_key" ON "decision_command_receipts"("application_id","actor_id","key");
CREATE UNIQUE INDEX "decision_command_receipts_audit_binding_key" ON "decision_command_receipts"("audit_id","application_id","actor_id");

CREATE TABLE "outcome_releases" (
  "id" UUID NOT NULL,
  "decision_id" UUID NOT NULL,
  "application_id" UUID NOT NULL,
  "submission_version_id" UUID NOT NULL,
  "programme_id" UUID NOT NULL,
  "publisher_id" UUID NOT NULL,
  "outcome" VARCHAR(32) NOT NULL,
  "applicant_message" VARCHAR(4000) NOT NULL,
  "release_reason" VARCHAR(4000) NOT NULL,
  "release_audit_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outcome_releases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outcome_releases_outcome_check" CHECK ("outcome" IN ('APPROVED','REJECTED','REVISION_REQUESTED')),
  CONSTRAINT "outcome_releases_message_check" CHECK (length(btrim("applicant_message")) > 0),
  CONSTRAINT "outcome_releases_reason_check" CHECK (length(btrim("release_reason")) > 0),
  CONSTRAINT "outcome_releases_decision_fkey" FOREIGN KEY ("decision_id","application_id","submission_version_id") REFERENCES "adjudication_decisions"("id","application_id","submission_version_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "outcome_releases_application_programme_fkey" FOREIGN KEY ("application_id","programme_id") REFERENCES "applications"("id","programme_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "outcome_releases_submission_fkey" FOREIGN KEY ("submission_version_id","application_id") REFERENCES "submission_versions"("id","application_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "outcome_releases_publisher_fkey" FOREIGN KEY ("publisher_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "outcome_releases_audit_binding_fkey" FOREIGN KEY ("release_audit_id","application_id","publisher_id") REFERENCES "decision_audits"("id","application_id","actor_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "outcome_releases_decision_id_key" ON "outcome_releases"("decision_id");
CREATE UNIQUE INDEX "outcome_releases_id_publisher_key" ON "outcome_releases"("id","publisher_id");
CREATE UNIQUE INDEX "outcome_releases_decision_binding_key" ON "outcome_releases"("decision_id","application_id","submission_version_id");
CREATE UNIQUE INDEX "outcome_releases_application_programme_key" ON "outcome_releases"("application_id","programme_id");
CREATE UNIQUE INDEX "outcome_releases_submission_application_key" ON "outcome_releases"("submission_version_id","application_id");
CREATE UNIQUE INDEX "outcome_releases_audit_binding_key" ON "outcome_releases"("release_audit_id","application_id","publisher_id");
CREATE INDEX "outcome_releases_application_version_idx" ON "outcome_releases"("application_id","submission_version_id");

CREATE TABLE "outcome_release_receipts" (
  "id" UUID NOT NULL,
  "release_id" UUID NOT NULL,
  "publisher_id" UUID NOT NULL,
  "key" VARCHAR(128) NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outcome_release_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outcome_release_receipts_release_fkey" FOREIGN KEY ("release_id","publisher_id") REFERENCES "outcome_releases"("id","publisher_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "outcome_release_receipts_publisher_fkey" FOREIGN KEY ("publisher_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "outcome_release_receipts_release_publisher_key" ON "outcome_release_receipts"("release_id","publisher_id","key");
CREATE UNIQUE INDEX "outcome_release_receipts_release_binding_key" ON "outcome_release_receipts"("release_id","publisher_id");

CREATE FUNCTION "guard_adjudication_decision"() RETURNS trigger LANGUAGE plpgsql SET search_path='pg_catalog,public' AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Adjudication decisions are immutable'; END IF;
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.application_id IS DISTINCT FROM NEW.application_id
    OR OLD.submission_version_id IS DISTINCT FROM NEW.submission_version_id OR OLD.programme_id IS DISTINCT FROM NEW.programme_id
    OR OLD.adjudicator_id IS DISTINCT FROM NEW.adjudicator_id OR OLD.outcome IS DISTINCT FROM NEW.outcome
    OR OLD.reason IS DISTINCT FROM NEW.reason OR OLD.workflow_revision IS DISTINCT FROM NEW.workflow_revision
    OR OLD.created_at IS DISTINCT FROM NEW.created_at OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.outcome_releases r WHERE r.decision_id=OLD.id AND r.application_id=OLD.application_id AND r.submission_version_id=OLD.submission_version_id) THEN
    RAISE EXCEPTION 'Only a matching atomic outcome release may update release timestamp';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "adjudication_decisions_immutable" BEFORE UPDATE OR DELETE ON "adjudication_decisions" FOR EACH ROW EXECUTE FUNCTION "guard_adjudication_decision"();

CREATE FUNCTION "guard_decision_append_only"() RETURNS trigger LANGUAGE plpgsql SET search_path='pg_catalog,public' AS $$
BEGIN RAISE EXCEPTION 'Decision history and receipts are append-only'; END $$;
CREATE TRIGGER "decision_audits_append_only" BEFORE UPDATE OR DELETE ON "decision_audits" FOR EACH ROW EXECUTE FUNCTION "guard_decision_append_only"();
CREATE TRIGGER "decision_receipts_append_only" BEFORE UPDATE OR DELETE ON "decision_command_receipts" FOR EACH ROW EXECUTE FUNCTION "guard_decision_append_only"();
CREATE TRIGGER "outcome_releases_append_only" BEFORE UPDATE OR DELETE ON "outcome_releases" FOR EACH ROW EXECUTE FUNCTION "guard_decision_append_only"();
CREATE TRIGGER "outcome_release_receipts_append_only" BEFORE UPDATE OR DELETE ON "outcome_release_receipts" FOR EACH ROW EXECUTE FUNCTION "guard_decision_append_only"();
CREATE TRIGGER "decision_outbox_no_delete" BEFORE DELETE ON "decision_outbox" FOR EACH ROW EXECUTE FUNCTION "guard_decision_append_only"();

CREATE FUNCTION "validate_outcome_release"() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog,public' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.adjudication_decisions d WHERE d.id=NEW.decision_id AND d.application_id=NEW.application_id
    AND d.submission_version_id=NEW.submission_version_id AND d.programme_id=NEW.programme_id AND d.outcome=NEW.outcome AND d.released_at IS NULL) THEN
    RAISE EXCEPTION 'Outcome release must match one unreleased exact-version decision';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.decision_audits a WHERE a.id=NEW.release_audit_id AND a.decision_id=NEW.decision_id
    AND a.application_id=NEW.application_id AND a.submission_version_id=NEW.submission_version_id
    AND a.actor_id=NEW.publisher_id AND a.action='DECISION_RELEASED' AND a.outcome=NEW.outcome
    AND a.reason=NEW.release_reason) THEN
    RAISE EXCEPTION 'Outcome release requires its matching durable publisher audit';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "outcome_release_matches_decision" BEFORE INSERT ON "outcome_releases" FOR EACH ROW EXECUTE FUNCTION "validate_outcome_release"();

REVOKE ALL ON adjudication_decisions,decision_audits,decision_outbox,decision_command_receipts,outcome_releases,outcome_release_receipts FROM PUBLIC;

COMMIT;
