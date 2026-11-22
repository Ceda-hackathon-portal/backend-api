BEGIN;
-- CreateTable
CREATE TABLE "programmes" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,

    CONSTRAINT "programmes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programme_versions" (
    "id" UUID NOT NULL,
    "programme_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL,
    "opens_at" TIMESTAMPTZ(3) NOT NULL,
    "closes_at" TIMESTAMPTZ(3) NOT NULL,
    "config" JSONB NOT NULL,

    CONSTRAINT "programme_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programme_grants" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "programme_id" UUID NOT NULL,
    "permission" VARCHAR(100) NOT NULL,
    "granted_by_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),

    CONSTRAINT "programme_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "programme_id" UUID NOT NULL,
    "programme_version_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "stage" VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
    "draft" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_versions" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "programme_version_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "reference" VARCHAR(64) NOT NULL,
    "fields" JSONB NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "command_receipts" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "operation" VARCHAR(64) NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "submission_version_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "command_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "revision" INTEGER NOT NULL,
    "request_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "audit_event_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "kind" VARCHAR(100) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "programmes_code_key" ON "programmes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "programme_versions_programme_id_version_key" ON "programme_versions"("programme_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "programme_versions_id_programme_id_key" ON "programme_versions"("id", "programme_id");

-- CreateIndex
CREATE INDEX "programme_grants_user_id_programme_id_permission_idx" ON "programme_grants"("user_id", "programme_id", "permission");

-- CreateIndex
CREATE INDEX "programme_grants_programme_id_idx" ON "programme_grants"("programme_id");

-- CreateIndex
CREATE INDEX "programme_grants_granted_by_id_idx" ON "programme_grants"("granted_by_id");

-- CreateIndex
CREATE INDEX "applications_owner_id_updated_at_idx" ON "applications"("owner_id", "updated_at");

-- CreateIndex
CREATE INDEX "applications_programme_version_id_programme_id_idx" ON "applications"("programme_version_id", "programme_id");

-- CreateIndex
CREATE UNIQUE INDEX "applications_id_programme_version_id_key" ON "applications"("id", "programme_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_versions_reference_key" ON "submission_versions"("reference");

-- CreateIndex
CREATE INDEX "submission_versions_application_id_programme_version_id_idx" ON "submission_versions"("application_id", "programme_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_versions_application_id_version_key" ON "submission_versions"("application_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "submission_versions_id_application_id_key" ON "submission_versions"("id", "application_id");

-- CreateIndex
CREATE INDEX "command_receipts_submission_version_id_application_id_idx" ON "command_receipts"("submission_version_id", "application_id");

-- CreateIndex
CREATE UNIQUE INDEX "command_receipts_actor_id_application_id_operation_key_key" ON "command_receipts"("actor_id", "application_id", "operation", "key");

-- CreateIndex
CREATE INDEX "audit_events_actor_id_created_at_idx" ON "audit_events"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_request_id_idx" ON "audit_events"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_events_application_id_revision_key" ON "audit_events"("application_id", "revision");

-- CreateIndex
CREATE INDEX "outbox_events_delivered_at_available_at_idx" ON "outbox_events"("delivered_at", "available_at");

-- CreateIndex
CREATE INDEX "outbox_events_recipient_id_idx" ON "outbox_events"("recipient_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_audit_event_id_recipient_id_kind_key" ON "outbox_events"("audit_event_id", "recipient_id", "kind");

-- AddForeignKey
ALTER TABLE "programme_versions" ADD CONSTRAINT "programme_versions_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "programme_grants" ADD CONSTRAINT "programme_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "programme_grants" ADD CONSTRAINT "programme_grants_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "programme_grants" ADD CONSTRAINT "programme_grants_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_programme_version_id_programme_id_fkey" FOREIGN KEY ("programme_version_id", "programme_id") REFERENCES "programme_versions"("id", "programme_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "submission_versions" ADD CONSTRAINT "submission_versions_application_id_programme_version_id_fkey" FOREIGN KEY ("application_id", "programme_version_id") REFERENCES "applications"("id", "programme_version_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_submission_version_id_application_id_fkey" FOREIGN KEY ("submission_version_id", "application_id") REFERENCES "submission_versions"("id", "application_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_audit_event_id_fkey" FOREIGN KEY ("audit_event_id") REFERENCES "audit_events"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Intake stage is separate from B-owned workflow state.
ALTER TABLE programme_versions ADD CHECK (version > 0 AND opens_at < closes_at);
ALTER TABLE applications ADD CHECK (revision >= 0 AND stage IN ('DRAFT','SUBMITTED'));
ALTER TABLE submission_versions ADD CHECK (version = 1 AND revision > 0);
CREATE UNIQUE INDEX initial_submission_only ON submission_versions(application_id);
ALTER TABLE outbox_events ADD CHECK (attempts >= 0);
ALTER TABLE audit_events ADD CHECK (revision >= 0);
CREATE UNIQUE INDEX active_programme_grant ON programme_grants(user_id,programme_id,permission) WHERE revoked_at IS NULL;

CREATE FUNCTION reject_domain_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable domain record'; END;
$$;
CREATE TRIGGER immutable_programme BEFORE UPDATE OR DELETE ON programme_versions FOR EACH ROW EXECUTE FUNCTION reject_domain_mutation();
CREATE TRIGGER immutable_submission BEFORE UPDATE OR DELETE ON submission_versions FOR EACH ROW EXECUTE FUNCTION reject_domain_mutation();
CREATE TRIGGER immutable_receipt BEFORE UPDATE OR DELETE ON command_receipts FOR EACH ROW EXECUTE FUNCTION reject_domain_mutation();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_domain_mutation();

CREATE FUNCTION protect_application_intake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR NEW.programme_id <> OLD.programme_id
 OR NEW.programme_version_id <> OLD.programme_version_id OR NEW.created_at <> OLD.created_at
 OR OLD.stage <> 'DRAFT' OR NEW.revision <> OLD.revision + 1 THEN
  RAISE EXCEPTION 'Invalid intake update';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER protect_application BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION protect_application_intake();

CREATE FUNCTION check_application_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE app applications; event_id uuid; snapshot submission_versions;
BEGIN
 SELECT * INTO app FROM applications WHERE id=NEW.id;
 SELECT id INTO event_id FROM audit_events WHERE application_id=app.id AND revision=app.revision AND actor_id=app.owner_id;
 IF event_id IS NULL OR NOT EXISTS(SELECT 1 FROM outbox_events WHERE audit_event_id=event_id AND recipient_id=app.owner_id) THEN
  RAISE EXCEPTION 'Missing atomic application events';
 END IF;
 IF app.stage='SUBMITTED' THEN
  SELECT * INTO snapshot FROM submission_versions WHERE application_id=app.id;
  IF snapshot.id IS NULL OR snapshot.revision<>app.revision OR snapshot.fields<>app.draft
   OR NOT EXISTS(SELECT 1 FROM command_receipts WHERE submission_version_id=snapshot.id AND application_id=app.id AND actor_id=app.owner_id AND operation='submit') THEN
   RAISE EXCEPTION 'Incomplete submission';
  END IF;
 ELSIF EXISTS(SELECT 1 FROM submission_versions WHERE application_id=app.id) THEN
  RAISE EXCEPTION 'Draft cannot have submission';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER application_commit AFTER INSERT OR UPDATE ON applications
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_application_commit();

CREATE FUNCTION check_snapshot_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM applications WHERE id=NEW.application_id AND stage='SUBMITTED' AND revision=NEW.revision) THEN
  RAISE EXCEPTION 'Snapshot requires submitted application';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER snapshot_commit AFTER INSERT ON submission_versions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_snapshot_commit();


CREATE FUNCTION protect_outbox_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Outbox history cannot be deleted'; END IF;
 IF NEW.id<>OLD.id OR NEW.audit_event_id<>OLD.audit_event_id OR NEW.recipient_id<>OLD.recipient_id
 OR NEW.kind<>OLD.kind OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'Immutable outbox identity'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER protect_outbox BEFORE UPDATE OR DELETE ON outbox_events FOR EACH ROW EXECUTE FUNCTION protect_outbox_identity();
CREATE FUNCTION check_audit_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM applications WHERE id=NEW.application_id AND owner_id=NEW.actor_id AND revision>=NEW.revision)
 OR NOT EXISTS(SELECT 1 FROM outbox_events WHERE audit_event_id=NEW.id AND recipient_id=NEW.actor_id) THEN
  RAISE EXCEPTION 'Audit requires application actor and outbox';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER audit_commit AFTER INSERT ON audit_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_audit_commit();
CREATE FUNCTION check_receipt_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.operation<>'submit' OR NEW.request_hash !~ '^[a-f0-9]{64}$'
 OR NOT EXISTS(SELECT 1 FROM applications WHERE id=NEW.application_id AND owner_id=NEW.actor_id AND stage='SUBMITTED') THEN
  RAISE EXCEPTION 'Invalid submission receipt';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER receipt_commit AFTER INSERT ON command_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_receipt_commit();
ALTER TABLE programme_grants ADD CHECK (expires_at IS NULL OR expires_at>granted_at);
ALTER TABLE programme_grants ADD CHECK (revoked_at IS NULL OR revoked_at>=granted_at);
COMMIT;