-- Apply as the migration/database owner after migrations.
-- Provision a separate LOGIN with an external secret and membership in this role.
-- Do not grant this group to ceda_runtime or any applicant-facing connection.
CREATE ROLE ceda_assignment_manager NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO ceda_assignment_manager;

GRANT SELECT ON users,sessions,applications,submission_versions,programme_versions,programme_grants,
 officer_assignments,conflict_disclosures TO ceda_assignment_manager;
GRANT UPDATE(id) ON users,sessions,programme_grants TO ceda_assignment_manager;
GRANT INSERT ON officer_assignments,conflict_disclosures TO ceda_assignment_manager;
GRANT UPDATE(status,revoked_at,revoked_by_id,revocation_reason,revocation_request_id)
 ON officer_assignments TO ceda_assignment_manager;
GRANT UPDATE(status,resolved_at,resolved_by_id,resolution,resolution_request_id)
 ON conflict_disclosures TO ceda_assignment_manager;

REVOKE ALL ON officer_assignments,conflict_disclosures FROM PUBLIC;
REVOKE ALL ON _prisma_migrations FROM ceda_assignment_manager;
