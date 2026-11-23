-- Run as migration/database owner after migrations. Provision LOGIN separately with a secret manager.
-- ceda_runtime is a NOLOGIN permission group. Never grant schema ownership or membership in migration roles.
CREATE ROLE ceda_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ceda_runtime;
GRANT SELECT ON users,identities,sessions,auth_attempts,programmes,programme_versions,programme_grants,
 applications,submission_versions,command_receipts,audit_events,outbox_events TO ceda_runtime;
GRANT INSERT ON users,identities,sessions,auth_attempts,applications,submission_versions,command_receipts,audit_events,outbox_events TO ceda_runtime;
GRANT SELECT, INSERT ON application_documents TO ceda_runtime;
GRANT UPDATE(submission_version_id) ON application_documents TO ceda_runtime;
GRANT SELECT ON eligibility_rule_versions TO ceda_runtime;
GRANT SELECT, INSERT ON eligibility_checks, eligibility_findings TO ceda_runtime;
GRANT INSERT ON eligibility_audits, eligibility_outbox TO ceda_runtime;
GRANT SELECT ON eligibility_audits, eligibility_outbox TO ceda_runtime;
GRANT SELECT, INSERT ON workflow_state,workflow_events,workflow_command_receipts,workflow_audits,workflow_outbox TO ceda_runtime;
GRANT UPDATE(state,revision,updated_at) ON workflow_state TO ceda_runtime;
-- Evaluator writes are confined to the version-bound draft aggregate. Triggers
-- reject score changes after finalization; audit and receipts remain append-only.
GRANT SELECT, INSERT ON evaluations TO ceda_runtime;
GRANT UPDATE(revision,state,comment,recommendation,total,updated_at,finalized_at) ON evaluations TO ceda_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON evaluation_scores TO ceda_runtime;
GRANT SELECT, INSERT ON evaluation_audits,evaluation_outbox,evaluation_command_receipts TO ceda_runtime;
-- Decisions and releases are atomic with workflow history and are append-only.
GRANT SELECT, INSERT ON adjudication_decisions TO ceda_runtime;
GRANT UPDATE(released_at) ON adjudication_decisions TO ceda_runtime;
GRANT INSERT ON decision_audits,decision_outbox TO ceda_runtime;
GRANT SELECT, INSERT ON decision_command_receipts,outcome_releases,outcome_release_receipts TO ceda_runtime;
-- Officer scope is read-only at the application runtime boundary. Assignment issuance,
-- conflict resolution and revocation use a separately controlled provisioning path.
GRANT SELECT ON officer_assignments, conflict_disclosures TO ceda_runtime;
-- An officer's eligibility confirmation is append-only and written only after the assignment scope check.
GRANT SELECT, INSERT ON officer_reviews TO ceda_runtime;
GRANT UPDATE ON identities,sessions TO ceda_runtime;
GRANT UPDATE(id) ON users,programme_grants TO ceda_runtime;
GRANT UPDATE(draft,budget,revision,stage,updated_at) ON applications TO ceda_runtime;
GRANT UPDATE(attempts,available_at,delivered_at) ON outbox_events TO ceda_runtime;
GRANT DELETE ON auth_attempts TO ceda_runtime;
REVOKE ALL ON users,identities,sessions,auth_attempts,programmes,programme_versions,programme_grants,
 applications,submission_versions,application_documents,command_receipts,audit_events,outbox_events,evaluations,evaluation_scores,
 evaluation_audits,evaluation_outbox,evaluation_command_receipts,adjudication_decisions,decision_audits,
 decision_outbox,decision_command_receipts,outcome_releases,outcome_release_receipts,_prisma_migrations FROM PUBLIC;
REVOKE ALL ON _prisma_migrations FROM ceda_runtime;
-- UUIDs use application-generated values; no sequences are needed.
-- Revoke CREATE on the database from PUBLIC separately if an existing deployment grants it.
-- Restrict all owner credentials and review PUBLIC/role memberships in the target environment.

DO $$
BEGIN
 EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC',current_database());
END;
$$;

-- Apply as migration owner, after runtime-role.sql. No access to authentication secrets or DDL.
GRANT SELECT,INSERT,UPDATE ON support_conversations,support_reads,support_agents,support_calls,alert_preferences,service_notifications,privacy_requests TO ceda_runtime;
GRANT SELECT,INSERT ON support_messages,service_audits TO ceda_runtime;
GRANT SELECT,INSERT,DELETE ON support_signals TO ceda_runtime;
GRANT USAGE,SELECT ON SEQUENCE support_signals_sequence_seq TO ceda_runtime;
GRANT SELECT ON decision_audits TO ceda_runtime;
