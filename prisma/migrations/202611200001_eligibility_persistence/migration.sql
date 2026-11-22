-- DropIndex
DROP INDEX "audit_events_application_id_revision_key";

-- CreateTable
CREATE TABLE "eligibility_rule_versions" (
    "id" UUID NOT NULL,
    "programme_id" UUID NOT NULL,
    "programme_version_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "digest" CHAR(64) NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eligibility_rule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eligibility_checks" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "programme_id" UUID NOT NULL,
    "programme_version_id" UUID NOT NULL,
    "submission_version_id" UUID NOT NULL,
    "rule_version_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "operation_key" VARCHAR(128) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "overall_status" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eligibility_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eligibility_findings" (
    "id" UUID NOT NULL,
    "check_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "submission_version_id" UUID NOT NULL,
    "requirement_id" VARCHAR(100) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "unknown_reason" VARCHAR(32),
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eligibility_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "officer_assignments" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "submission_version_id" UUID NOT NULL,
    "programme_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "valid_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "officer_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conflict_disclosures" (
    "id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "disclosed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution" VARCHAR(500),

    CONSTRAINT "conflict_disclosures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "officer_reviews" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "submission_version_id" UUID NOT NULL,
    "check_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "outcome" VARCHAR(24) NOT NULL,
    "rationale" VARCHAR(4000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "officer_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_state" (
    "application_id" UUID NOT NULL,
    "submission_version_id" UUID NOT NULL,
    "state" VARCHAR(32) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workflow_state_pkey" PRIMARY KEY ("application_id")
);

-- CreateTable
CREATE TABLE "workflow_events" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "submission_version_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "previous_state" VARCHAR(32) NOT NULL,
    "next_state" VARCHAR(32) NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "reason" VARCHAR(2000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "eligibility_rule_versions_programme_id_version_key" ON "eligibility_rule_versions"("programme_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "eligibility_rule_versions_id_programme_id_programme_version_key" ON "eligibility_rule_versions"("id", "programme_id", "programme_version_id");

-- CreateIndex
CREATE INDEX "eligibility_checks_submission_version_id_created_at_idx" ON "eligibility_checks"("submission_version_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "eligibility_checks_requested_by_id_application_id_operation_key" ON "eligibility_checks"("requested_by_id", "application_id", "operation_key");

-- CreateIndex
CREATE UNIQUE INDEX "eligibility_checks_id_application_id_submission_version_id_key" ON "eligibility_checks"("id", "application_id", "submission_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "eligibility_findings_check_id_requirement_id_key" ON "eligibility_findings"("check_id", "requirement_id");

-- CreateIndex
CREATE INDEX "officer_assignments_actor_id_programme_id_status_expires_at_idx" ON "officer_assignments"("actor_id", "programme_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "officer_assignments_submission_version_id_actor_id_idx" ON "officer_assignments"("submission_version_id", "actor_id");

-- CreateIndex
CREATE INDEX "conflict_disclosures_assignment_id_status_idx" ON "conflict_disclosures"("assignment_id", "status");

-- CreateIndex
CREATE INDEX "officer_reviews_submission_version_id_created_at_idx" ON "officer_reviews"("submission_version_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_events_application_id_revision_key" ON "workflow_events"("application_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_application_id_revision_request_id_action_key" ON "audit_events"("application_id", "revision", "request_id", "action");

-- AddForeignKey
ALTER TABLE "eligibility_rule_versions" ADD CONSTRAINT "eligibility_rule_versions_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_rule_versions" ADD CONSTRAINT "eligibility_rule_versions_programme_version_id_programme_i_fkey" FOREIGN KEY ("programme_version_id", "programme_id") REFERENCES "programme_versions"("id", "programme_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_submission_version_id_application_id_fkey" FOREIGN KEY ("submission_version_id", "application_id") REFERENCES "submission_versions"("id", "application_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_rule_version_id_programme_id_programme__fkey" FOREIGN KEY ("rule_version_id", "programme_id", "programme_version_id") REFERENCES "eligibility_rule_versions"("id", "programme_id", "programme_version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_checks" ADD CONSTRAINT "eligibility_checks_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_findings" ADD CONSTRAINT "eligibility_findings_check_id_application_id_submission_ve_fkey" FOREIGN KEY ("check_id", "application_id", "submission_version_id") REFERENCES "eligibility_checks"("id", "application_id", "submission_version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "officer_assignments" ADD CONSTRAINT "officer_assignments_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "officer_assignments" ADD CONSTRAINT "officer_assignments_submission_version_id_application_id_fkey" FOREIGN KEY ("submission_version_id", "application_id") REFERENCES "submission_versions"("id", "application_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "officer_assignments" ADD CONSTRAINT "officer_assignments_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "officer_assignments" ADD CONSTRAINT "officer_assignments_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflict_disclosures" ADD CONSTRAINT "conflict_disclosures_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "officer_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "officer_reviews" ADD CONSTRAINT "officer_reviews_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "officer_reviews" ADD CONSTRAINT "officer_reviews_submission_version_id_application_id_fkey" FOREIGN KEY ("submission_version_id", "application_id") REFERENCES "submission_versions"("id", "application_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "officer_reviews" ADD CONSTRAINT "officer_reviews_check_id_application_id_submission_version_fkey" FOREIGN KEY ("check_id", "application_id", "submission_version_id") REFERENCES "eligibility_checks"("id", "application_id", "submission_version_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "officer_reviews" ADD CONSTRAINT "officer_reviews_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "officer_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "officer_reviews" ADD CONSTRAINT "officer_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_state" ADD CONSTRAINT "workflow_state_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_state" ADD CONSTRAINT "workflow_state_submission_version_id_fkey" FOREIGN KEY ("submission_version_id") REFERENCES "submission_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_submission_version_id_fkey" FOREIGN KEY ("submission_version_id") REFERENCES "submission_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE eligibility_rule_versions ADD CONSTRAINT eligibility_rule_version_valid CHECK (version > 0 AND schema_version = 1 AND digest ~ '^[a-f0-9]{64}$');
ALTER TABLE eligibility_checks ADD CONSTRAINT eligibility_check_result_valid CHECK (overall_status IN ('MET','NOT_MET','UNKNOWN') AND operation_key <> '' AND request_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE eligibility_findings ADD CONSTRAINT eligibility_finding_result_valid CHECK (status IN ('MET','NOT_MET','UNKNOWN') AND (status <> 'UNKNOWN' OR unknown_reason IS NOT NULL));
ALTER TABLE workflow_state ADD CONSTRAINT workflow_revision_valid CHECK (revision >= 0);
CREATE TRIGGER immutable_eligibility_rule BEFORE UPDATE OR DELETE ON eligibility_rule_versions FOR EACH ROW EXECUTE FUNCTION reject_domain_mutation();
CREATE TRIGGER immutable_eligibility_check BEFORE UPDATE OR DELETE ON eligibility_checks FOR EACH ROW EXECUTE FUNCTION reject_domain_mutation();
CREATE TRIGGER immutable_eligibility_finding BEFORE UPDATE OR DELETE ON eligibility_findings FOR EACH ROW EXECUTE FUNCTION reject_domain_mutation();
CREATE TRIGGER immutable_workflow_event BEFORE UPDATE OR DELETE ON workflow_events FOR EACH ROW EXECUTE FUNCTION reject_domain_mutation();
