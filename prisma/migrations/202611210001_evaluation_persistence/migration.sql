BEGIN;

-- Evaluator persistence is bound to the existing exact-version assignment.
-- The assignment composite key makes actor/application/version mismatch impossible.
ALTER TABLE "officer_assignments"
  ADD CONSTRAINT "officer_assignments_id_actor_application_version_key"
  UNIQUE ("id", "actor_id", "application_id", "submission_version_id");

CREATE TABLE "evaluations" (
  "id" UUID NOT NULL,
  "assignment_id" UUID NOT NULL,
  "application_id" UUID NOT NULL,
  "submission_version_id" UUID NOT NULL,
  "evaluator_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "state" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  "comment" VARCHAR(4000) NOT NULL DEFAULT '',
  "recommendation" VARCHAR(24),
  "total" DOUBLE PRECISION,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "finalized_at" TIMESTAMPTZ(3),
  CONSTRAINT "evaluations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evaluations_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "evaluations_state_check" CHECK ("state" IN ('DRAFT','FINALIZED')),
  CONSTRAINT "evaluations_finalization_check" CHECK (("state"='DRAFT' AND "finalized_at" IS NULL) OR ("state"='FINALIZED' AND "finalized_at" IS NOT NULL)),
  CONSTRAINT "evaluations_total_finite_check" CHECK ("total" IS NULL OR "total" NOT IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)),
  CONSTRAINT "evaluations_assignment_binding_fkey" FOREIGN KEY ("assignment_id","evaluator_id","application_id","submission_version_id")
    REFERENCES "officer_assignments"("id","actor_id","application_id","submission_version_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "evaluations_application_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "evaluations_submission_fkey" FOREIGN KEY ("submission_version_id","application_id") REFERENCES "submission_versions"("id","application_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "evaluations_evaluator_fkey" FOREIGN KEY ("evaluator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "evaluations_assignment_id_key" ON "evaluations"("assignment_id");
CREATE UNIQUE INDEX "evaluations_id_assignment_id_evaluator_id_key" ON "evaluations"("id","assignment_id","evaluator_id");
CREATE UNIQUE INDEX "evaluations_id_application_id_submission_version_id_evaluator_id_key" ON "evaluations"("id","application_id","submission_version_id","evaluator_id");
CREATE INDEX "evaluations_application_version_state_idx" ON "evaluations"("application_id","submission_version_id","state");

CREATE TABLE "evaluation_scores" (
  "id" UUID NOT NULL,
  "evaluation_id" UUID NOT NULL,
  "criterion_id" VARCHAR(100) NOT NULL,
  "value" DOUBLE PRECISION NOT NULL,
  "evidence" VARCHAR(4000) NOT NULL,
  CONSTRAINT "evaluation_scores_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evaluation_scores_value_finite_check" CHECK ("value" NOT IN ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)),
  CONSTRAINT "evaluation_scores_evaluation_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "evaluations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "evaluation_scores_evaluation_criterion_key" ON "evaluation_scores"("evaluation_id","criterion_id");

CREATE TABLE "evaluation_audits" (
  "id" UUID NOT NULL,
  "evaluation_id" UUID NOT NULL,
  "application_id" UUID NOT NULL,
  "submission_version_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "request_id" UUID NOT NULL,
  "action" VARCHAR(32) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evaluation_audits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evaluation_audits_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "evaluation_audits_action_check" CHECK ("action" IN ('EVALUATION_SAVED','EVALUATION_FINALIZED')),
  CONSTRAINT "evaluation_audits_evaluation_fkey" FOREIGN KEY ("evaluation_id","application_id","submission_version_id","actor_id") REFERENCES "evaluations"("id","application_id","submission_version_id","evaluator_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "evaluation_audits_application_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "evaluation_audits_submission_fkey" FOREIGN KEY ("submission_version_id","application_id") REFERENCES "submission_versions"("id","application_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "evaluation_audits_evaluation_revision_key" ON "evaluation_audits"("evaluation_id","revision");
CREATE UNIQUE INDEX "evaluation_audits_request_id_key" ON "evaluation_audits"("request_id");
CREATE INDEX "evaluation_audits_application_created_idx" ON "evaluation_audits"("application_id","created_at");

CREATE TABLE "evaluation_outbox" (
  "audit_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "delivered_at" TIMESTAMPTZ(3),
  CONSTRAINT "evaluation_outbox_pkey" PRIMARY KEY ("audit_id"),
  CONSTRAINT "evaluation_outbox_audit_fkey" FOREIGN KEY ("audit_id") REFERENCES "evaluation_audits"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE "evaluation_command_receipts" (
  "id" UUID NOT NULL,
  "assignment_id" UUID NOT NULL,
  "evaluator_id" UUID NOT NULL,
  "evaluation_id" UUID NOT NULL,
  "key" VARCHAR(128) NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "result" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evaluation_command_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evaluation_command_receipts_evaluation_fkey" FOREIGN KEY ("evaluation_id","assignment_id","evaluator_id") REFERENCES "evaluations"("id","assignment_id","evaluator_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "evaluation_command_receipts_assignment_actor_key" ON "evaluation_command_receipts"("assignment_id","evaluator_id","key");

CREATE FUNCTION "guard_evaluation_update"() RETURNS trigger LANGUAGE plpgsql SET search_path='pg_catalog,public' AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Evaluations are append-only; finalized evaluations cannot be deleted'; END IF;
  IF OLD.state='FINALIZED' THEN RAISE EXCEPTION 'Finalized evaluations are immutable'; END IF;
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.assignment_id IS DISTINCT FROM NEW.assignment_id
    OR OLD.application_id IS DISTINCT FROM NEW.application_id OR OLD.submission_version_id IS DISTINCT FROM NEW.submission_version_id
    OR OLD.evaluator_id IS DISTINCT FROM NEW.evaluator_id OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Evaluation assignment and version binding are immutable';
  END IF;
  IF NEW.revision NOT IN (OLD.revision, OLD.revision+1) OR (NEW.revision=OLD.revision AND NEW.state<>'FINALIZED') THEN
    RAISE EXCEPTION 'Evaluation revisions must advance once or finalize atomically';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "evaluations_immutable_binding" BEFORE UPDATE OR DELETE ON "evaluations" FOR EACH ROW EXECUTE FUNCTION "guard_evaluation_update"();

CREATE FUNCTION "guard_evaluation_score_write"() RETURNS trigger LANGUAGE plpgsql SET search_path='pg_catalog,public' AS $$
DECLARE evaluation_state TEXT; target_id UUID;
BEGIN
  target_id := CASE WHEN TG_OP='DELETE' THEN OLD.evaluation_id ELSE NEW.evaluation_id END;
  SELECT state INTO evaluation_state FROM public.evaluations WHERE id=target_id FOR UPDATE;
  IF evaluation_state IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'Scores may only be written to a draft evaluation'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "evaluation_scores_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "evaluation_scores" FOR EACH ROW EXECUTE FUNCTION "guard_evaluation_score_write"();

CREATE FUNCTION "guard_evaluation_append_only"() RETURNS trigger LANGUAGE plpgsql SET search_path='pg_catalog,public' AS $$
BEGIN RAISE EXCEPTION 'Evaluation audit and command receipts are append-only'; END $$;
CREATE TRIGGER "evaluation_audits_append_only" BEFORE UPDATE OR DELETE ON "evaluation_audits" FOR EACH ROW EXECUTE FUNCTION "guard_evaluation_append_only"();
CREATE TRIGGER "evaluation_receipts_append_only" BEFORE UPDATE OR DELETE ON "evaluation_command_receipts" FOR EACH ROW EXECUTE FUNCTION "guard_evaluation_append_only"();
CREATE TRIGGER "evaluation_outbox_immutable" BEFORE DELETE ON "evaluation_outbox" FOR EACH ROW EXECUTE FUNCTION "guard_evaluation_append_only"();

COMMIT;
