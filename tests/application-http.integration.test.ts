import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Client } from 'pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Router } from 'express';
import { pino } from 'pino';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { authRoutes } from '../src/modules/auth/routes.js';
import { PrismaSessionStore } from '../src/modules/auth/store.js';
import { applicationRoutes } from '../src/modules/applications/routes.js';
import { hash, token } from '../src/modules/auth/crypto.js';
import { PrismaEligibilityScreeningService, persistEligibilityRuleVersion } from '../src/modules/eligibility/persistence.js';
import { PrismaApplicationRepository } from '../src/modules/applications/repository.js';
import { OFFICER_SUBMISSION_PERMISSION, PrismaOfficerSubmissionReader } from '../src/modules/applications/officer-submission-reader.js';
import { PrismaOfficerReviewScope } from '../src/modules/applications/prisma-officer-review-scope.js';
test('restricted login supports persistent HTTP application lifecycle and denies DDL/immutable writes', { timeout: 60000 }, async () => {
    assert.match(process.env.DISPOSABLE_DATABASE_RUN ?? '', /^[a-f0-9-]{36}$/);
    const url = process.env.DATABASE_URL!;
    assert.equal(new URL(url).hostname, '127.0.0.1');
    const runtimeRoot = resolve('.runtime');
    const documentRoot = resolve(runtimeRoot, 'application-http-' + randomUUID());
    assert.ok(documentRoot.startsWith(runtimeRoot + sep));
    const previousDocumentRoot = process.env.APPLICATION_STORAGE_DIR;
    process.env.APPLICATION_STORAGE_DIR = documentRoot;
    const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, options: '-c timezone=UTC', max: 4 }) });
    const admin = new Client({ connectionString: url });
    await admin.connect();
    let runtime: PrismaClient | undefined;
    let login: Client | undefined;
    let server: Server | undefined;
    try {
        await admin.query(readFileSync('ops/runtime-role.sql', 'utf8'));
        const password = randomBytes(24).toString('hex');
        await admin.query("CREATE ROLE ceda_app_test LOGIN PASSWORD '" + password + "' IN ROLE ceda_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
        const runtimeUrl = new URL(url);
        runtimeUrl.username = 'ceda_app_test';
        runtimeUrl.password = password;
        if (process.env.DISPOSABLE_POSTGRES_SERVICE !== 'true') {
            const hba = (await admin.query('SHOW hba_file')).rows[0].hba_file as string;
            assert.ok(resolve(hba).startsWith(resolve('.runtime') + sep));
            writeFileSync(hba, 'host all ceda_app_test 127.0.0.1/32 scram-sha-256' + '\n' + readFileSync(hba, 'utf8'));
            await admin.query('SELECT pg_reload_conf()');
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        const wrongUrl = new URL(runtimeUrl);
        wrongUrl.password = 'incorrect-fixture-password';
        const wrongLogin = new Client({ connectionString: wrongUrl.href });
        try {
            await assert.rejects(wrongLogin.connect(), { code: '28P01' });
        }
        finally {
            await wrongLogin.end();
        }
        login = new Client({ connectionString: runtimeUrl.href });
        await login.connect();
        assert.equal((await login.query('SELECT session_user')).rows[0].session_user, 'ceda_app_test');
        const role = (await login.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
        assert.ok(Object.values(role).every(value => value === false));
        assert.equal((await login.query("SELECT pg_has_role(current_user,datdba,'MEMBER') AS owner FROM pg_database WHERE datname=current_database()")).rows[0].owner, false);
        assert.equal((await login.query("SELECT pg_has_role(current_user,nspowner,'MEMBER') AS owner FROM pg_namespace WHERE nspname='public'")).rows[0].owner, false);
        for (const sql of [
            'ALTER TABLE applications DISABLE TRIGGER ALL', 'ALTER TABLE applications ADD COLUMN forbidden text',
            'DROP TABLE applications', 'TRUNCATE applications CASCADE', 'TRUNCATE submission_versions CASCADE',
            'TRUNCATE audit_events CASCADE', 'TRUNCATE command_receipts CASCADE',
            "SET session_replication_role='replica'", 'CREATE TABLE public.forbidden(id int)', 'CREATE TEMP TABLE forbidden_temp(id int)', 'SET ROLE fixture',
            "INSERT INTO _prisma_migrations(id,checksum,logs,migration_name) VALUES ('x','x','x','x')",
        ])
            await assert.rejects(login.query(sql), { code: '42501' });
        assert.equal((await login.query("SELECT pg_has_role(current_user,(SELECT tableowner FROM pg_tables WHERE tablename='applications'),'MEMBER') AS owner")).rows[0].owner, false);
        assert.equal((await login.query("SELECT has_table_privilege(current_user,'_prisma_migrations','SELECT') AS allowed")).rows[0].allowed, false);
        runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl.href, options: '-c timezone=UTC', max: 8 }) });
        let store = new PrismaSessionStore(runtime);
        const raw = token(), otherRaw = token();
        const identity = { issuer: 'https://fixture.example', subject: randomUUID(), email: randomUUID() + '@example.test', name: 'Fictional applicant' };
        await store.create(identity, hash(raw), null, 1800, 28800);
        await store.create({ ...identity, subject: randomUUID(), email: randomUUID() + '@example.test' }, hash(otherRaw), null, 1800, 28800);
        const session = await store.find(hash(raw), 1800);
        assert.ok(session);
        const programme = await owner.programme.create({ data: { code: randomUUID(), name: 'Fictional intake' } });
        const version = await owner.programmeVersion.create({ data: { programmeId: programme.id, version: 1, publishedAt: new Date(Date.now() - 10000), opensAt: new Date(Date.now() - 10000), closesAt: new Date(Date.now() + 600000), config: { themes: ['digital'] } } });
        const authConfig = { mode: 'cognito' as const, issuer: identity.issuer, clientId: 'fixture', apiOrigin: 'https://api.example.test', frontendOrigin: 'https://frontend.example.test', key: randomBytes(32).toString('hex'), secure: true, idleSeconds: 1800, absoluteSeconds: 28800 };
        const launch = async () => {
            const auth = authRoutes(authConfig, store, { async begin() { throw new Error('unused'); }, async complete() { throw new Error('unused'); } });
            const router = Router();
            router.use('/auth', auth.router);
            router.use('/applications', applicationRoutes(runtime!, auth.verifier, auth.requireCsrf));
            server = createServer(createApp(loadConfig({ ...process.env, DATABASE_URL: runtimeUrl.href, ALLOWED_ORIGINS: authConfig.frontendOrigin }), { database: { async check() { }, async close() { } }, logger: pino({ level: 'silent' }), apiRouter: router }));
            await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
            return 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api/v1';
        };
        let base = await launch();
        const cookie = '__Host-ceda_session=' + raw;
        const csrfResponse = await fetch(base + '/auth/csrf', { headers: { Cookie: cookie } });
        const csrf = (await csrfResponse.json()).data.csrfToken as string;
        const request = async (path: string, method = 'GET', body?: unknown, overrides: Record<string, string> = {}) => {
            const headers = { Cookie: cookie, Origin: authConfig.frontendOrigin, 'X-CSRF-Token': csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...overrides };
            return fetch(base + path, { method, headers, signal: AbortSignal.timeout(5000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        };
        const uploadProposal = (applicationId: string, expectedRevision: number) => {
            const query = new URLSearchParams({ name: 'fictional-proposal.pdf', category: 'technical-proposal', expectedRevision: String(expectedRevision) });
            return fetch(base + '/applications/' + applicationId + '/documents?' + query, {
                method: 'POST', headers: { Cookie: cookie, Origin: authConfig.frontendOrigin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' },
                body: Buffer.from('%PDF-1.7\nFictional local test proposal\n'), signal: AbortSignal.timeout(5000),
            });
        };
        const input = { programmeId: programme.id, programmeVersionId: version.id };
        assert.equal((await fetch(base + '/applications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 401);
        assert.equal((await fetch(base + '/applications')).status, 401);
        assert.equal((await request('/applications', 'POST', input, { 'X-CSRF-Token': 'invalid' })).status, 403);
        assert.equal((await request('/applications', 'POST', { ...input, ownerId: session.userId })).status, 422);
        assert.equal((await request('/applications', 'POST', { ...input, programmeId: randomUUID() })).status, 404);
        const created = await request('/applications', 'POST', input);
        assert.equal(created.status, 201);
        const app = (await created.json()).data;
        assert.equal(app.ownerId, session.userId);
        const initialList = await request('/applications');
        assert.equal(initialList.status, 200);
        assert.deepEqual((await initialList.json()).data.map((item: { id: string }) => item.id), [app.id]);
        const otherList = await request('/applications', 'GET', undefined, { Cookie: '__Host-ceda_session=' + otherRaw });
        assert.equal(otherList.status, 200);
        assert.deepEqual((await otherList.json()).data, []);
        const requestId = created.headers.get('x-request-id');
        const audit = await owner.auditEvent.findFirstOrThrow({ where: { applicationId: app.id } });
        assert.equal(audit.requestId, requestId);
        assert.equal(audit.actorId, session.userId);
        assert.equal((await request('/applications/' + app.id, 'GET', undefined, { Cookie: '__Host-ceda_session=' + otherRaw })).status, 404);
        assert.equal((await request('/applications/' + randomUUID(), 'GET', undefined, { Cookie: '__Host-ceda_session=' + otherRaw })).status, 404);
        assert.equal((await request('/applications/' + app.id + '/submit', 'POST', { expectedRevision: 0 }, { 'Idempotency-Key': 'invalid-draft' })).status, 422);
        const fields = { title: 'Idea', theme: 'digital', problem: 'Problem', solution: 'Solution', impact: 'Impact', team: 'Team' };
        const budget = { items: [{ description: 'Fictional development cost', amount: '100.00' }], fundingRequested: '50.00', notApplicable: false };
        assert.equal((await request('/applications/' + app.id, 'PATCH', { expectedRevision: 0, fields, budget })).status, 200);
        assert.equal((await request('/applications/' + app.id, 'PATCH', { expectedRevision: 0, fields })).status, 409);
        const uploaded = await uploadProposal(app.id, 1);
        assert.equal(uploaded.status, 201);
        const uploadedDocument = (await uploaded.json()).data;
        assert.equal(uploadedDocument.revision, 2);
        assert.equal((await uploadProposal(app.id, 1)).status, 409);
        const restoredDraft = await request('/applications');
        assert.equal(restoredDraft.status, 200);
        const listedDraft = (await restoredDraft.json()).data[0];
        assert.equal(listedDraft.id, app.id);
        assert.equal(listedDraft.ownerId, session.userId);
        assert.equal(listedDraft.revision, 2);
        assert.deepEqual(listedDraft.fields, fields);
        assert.deepEqual(listedDraft.budget, budget);
        assert.deepEqual(listedDraft.documents.map((document: { id: string }) => document.id), [uploadedDocument.id]);
        assert.equal((await request('/applications/' + app.id + '/documents/' + uploadedDocument.id, 'GET', undefined, { Cookie: '__Host-ceda_session=' + otherRaw })).status, 404);
        const path = '/applications/' + app.id + '/submit';
        const results = await Promise.all([request(path, 'POST', { expectedRevision: 2 }, { 'Idempotency-Key': 'same' }), request(path, 'POST', { expectedRevision: 2 }, { 'Idempotency-Key': 'same' })]);
        assert.ok(results.every(r => r.status === 200));
        const first = (await results[0]!.json()).data;
        assert.deepEqual(first.budget, budget);
        assert.deepEqual(first.documents.map((document: { id: string }) => document.id), [uploadedDocument.id]);
        const download = await request('/applications/' + app.id + '/documents/' + uploadedDocument.id, 'GET');
        assert.equal(download.status, 200);
        assert.equal(Buffer.from(await download.arrayBuffer()).toString(), '%PDF-1.7\nFictional local test proposal\n');
        assert.equal((await request('/officer/submissions/' + first.id)).status, 404);
        assert.equal((await fetch(base + '/officer/submissions/' + first.id)).status, 404);
        assert.deepEqual((await results[1]!.json()).data, first);
        const restoredSubmission = (await request('/applications/' + app.id)).json();
        const submittedApplication = (await restoredSubmission).data;
        assert.equal(submittedApplication.stage, 'SUBMITTED');
        assert.equal(submittedApplication.revision, 3);
        assert.equal(submittedApplication.latestSubmission.id, first.id);
        assert.deepEqual(submittedApplication.latestSubmission.fields, fields);
        assert.deepEqual(submittedApplication.latestSubmission.budget, budget);
        const submittedList = await request('/applications');
        assert.equal((await submittedList.json()).data[0].latestSubmission.id, first.id);
        assert.equal((await request(path, 'POST', { expectedRevision: 1 }, { 'Idempotency-Key': 'same' })).status, 409);
        const rollbackResponse = await request('/applications', 'POST', input);
        assert.equal(rollbackResponse.status, 201);
        const rollback = (await rollbackResponse.json()).data;
        assert.equal((await request('/applications/' + rollback.id, 'PATCH', { expectedRevision: 0, fields, budget })).status, 200);
        assert.equal((await (await uploadProposal(rollback.id, 1)).json()).data.revision, 2);
        for (const table of ['audit_events', 'outbox_events']) {
            const condition = table === 'audit_events'
                ? "NEW.application_id='" + rollback.id + "'::uuid AND NEW.action='application.submitted'"
                : "EXISTS(SELECT 1 FROM audit_events WHERE id=NEW.audit_event_id AND application_id='" + rollback.id + "'::uuid AND action='application.submitted')";
            await owner.$executeRawUnsafe("CREATE FUNCTION http_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF " + condition + " THEN RAISE EXCEPTION 'HTTP fixture failure'; END IF; RETURN NEW; END $$");
            await owner.$executeRawUnsafe('CREATE TRIGGER http_fault BEFORE INSERT ON ' + table + ' FOR EACH ROW EXECUTE FUNCTION http_fault()');
            assert.equal((await request('/applications/' + rollback.id + '/submit', 'POST', { expectedRevision: 2 }, { 'Idempotency-Key': 'rollback' })).status, 500);
            assert.equal((await owner.application.findUniqueOrThrow({ where: { id: rollback.id } })).stage, 'DRAFT');
            assert.equal(await owner.submissionVersion.count({ where: { applicationId: rollback.id } }), 0);
            assert.equal(await owner.commandReceipt.count({ where: { applicationId: rollback.id } }), 0);
            await owner.$executeRawUnsafe('DROP TRIGGER http_fault ON ' + table);
            await owner.$executeRawUnsafe('DROP FUNCTION http_fault()');
        }
        await assert.rejects(login.query('UPDATE submission_versions SET fields=fields WHERE id=$1', [first.id]), { code: '42501' });
        await assert.rejects(login.query('DELETE FROM audit_events WHERE application_id=$1', [app.id]), { code: '42501' });
        await assert.rejects(login.query('UPDATE programme_versions SET config=config'), { code: '42501' });
        await assert.rejects(login.query('UPDATE programme_grants SET permission=$1', ['forbidden']), { code: '42501' });
        await new Promise<void>(resolve => server!.close(() => resolve()));
        server = undefined;
        await runtime.$disconnect();
        runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl.href, options: '-c timezone=UTC', max: 8 }) });
        store = new PrismaSessionStore(runtime);
        // Recreate the HTTP app and DB pool while retaining only PostgreSQL state.
        base = await launch();
        const restored = await request('/applications/' + app.id + '/submissions/' + first.id);
        assert.equal(restored.status, 200);
        assert.deepEqual((await restored.json()).data, first);
        const principal = { userId: session.userId, sessionId: session.id, authnLevel: 'oidc' };
        const restricted = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl.href, options: '-c timezone=UTC -c role=ceda_runtime' }) });
        try {
            assert.deepEqual(await restricted.$queryRaw`SELECT current_user::text AS role, session_user::text AS login`, [{ role: 'ceda_runtime', login: 'ceda_app_test' }]);
            const ruleVersionId = randomUUID();
            await persistEligibilityRuleVersion(owner, { id: ruleVersionId, programmeId: programme.id, programmeVersionId: version.id, version: 1, publishedAt: version.publishedAt,
                snapshot: { schemaVersion: 1, ruleVersion: ruleVersionId, requirements: [{ id: 'fixture', rule: { kind: 'attestation' } }] } });
            const screening = new PrismaEligibilityScreeningService(restricted, { async load() { return [{ id: 'fixture-evidence', requirementId: 'fixture', value: true }]; } });
            const command = { applicationId: app.id, submissionVersionId: first.id, ruleVersionId, idempotencyKey: 'restricted' };
            const screened = await screening.screen(principal, command);
            assert.equal(screened.status, 'MET');
            assert.equal((await screening.screen(principal, command)).checkId, screened.checkId);
            assert.ok(await owner.eligibilityOutbox.findUnique({ where: { checkId: screened.checkId } }));
            await assert.rejects(screening.screen({ ...principal, sessionId: randomUUID() }, { ...command, idempotencyKey: 'denied' }), { status: 401 });
            assert.equal(await owner.eligibilityCheck.count({ where: { applicationId: app.id } }), 1);
            const officer = await owner.authUser.create({ data: { name: 'Restricted officer fixture', email: randomUUID() + '@example.test' } });
            const officerSession = await owner.authSession.create({ data: { userId: officer.id, tokenHash: randomBytes(32).toString('hex'), idleExpiresAt: new Date(Date.now() + 600000), absoluteExpiresAt: new Date(Date.now() + 1200000) } });
            await owner.programmeGrant.create({ data: { userId: officer.id, programmeId: programme.id, permission: OFFICER_SUBMISSION_PERMISSION, grantedById: session.userId } });
            const assignment = await owner.officerAssignment.create({ data: {
                applicationId: app.id, submissionVersionId: first.id, programmeId: programme.id, actorId: officer.id,
                issuedById: session.userId, issuedRequestId: randomUUID(), validFrom: new Date(Date.now() - 60000),
            } });
            await owner.conflictDisclosure.create({ data: {
                assignmentId: assignment.id, status: 'NO_CONFLICT', disclosedById: officer.id, disclosedRequestId: randomUUID(),
                resolvedAt: new Date(), resolvedById: session.userId, resolutionRequestId: randomUUID(),
            } });
            const officerReader = new PrismaOfficerSubmissionReader(restricted, new PrismaOfficerReviewScope());
            const officerResult = await officerReader.readForOfficer({ principal: { userId: officer.id, sessionId: officerSession.id, authnLevel: 'oidc' }, requestId: randomUUID() }, first.id);
            assert.equal(officerResult.submissionVersionId, first.id);
            await assert.rejects(login.query('INSERT INTO audit_events(id,actor_id,application_id,revision,action,request_id) VALUES ($1,$2,$3,0,$4,$5)', [randomUUID(),session.userId,app.id,'application.created',randomUUID()]), { code: '23505', constraint: 'audit_events_application_id_revision_key' });
            for (const sql of ['DELETE FROM eligibility_checks','TRUNCATE eligibility_outbox','ALTER TABLE eligibility_findings ADD COLUMN forbidden int','UPDATE eligibility_rule_versions SET snapshot=snapshot']) {
                await assert.rejects(login.query(sql), { code: '42501' });
            }
            const assignmentCounts = await restricted.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM officer_assignments`;
            const conflictCounts = await restricted.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM conflict_disclosures`;
            assert.equal(assignmentCounts[0]?.count, 1);
            assert.equal(conflictCounts[0]?.count, 1);
            await assert.rejects(login.query('UPDATE officer_assignments SET status=$1', ['REVOKED']), { code: '42501' });
            await assert.rejects(login.query('DELETE FROM conflict_disclosures'), { code: '42501' });
        } finally { await restricted.$disconnect(); }
        const repository = new PrismaApplicationRepository(runtime, principal, randomUUID());
        const permission = () => repository.transaction(async (tx) => { await tx.requireSession(principal); await tx.requireProgrammePermission(programme.id, 'programme.manage'); });
        await assert.rejects(permission(), { status: 403 });
        await owner.programmeGrant.create({ data: { userId: session.userId, programmeId: programme.id, permission: 'programme.manage', grantedById: session.userId } });
        await permission();
        await owner.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
        assert.equal((await request('/applications/' + app.id)).status, 401);
        const otherSession = await owner.authSession.findUniqueOrThrow({ where: { tokenHash: hash(otherRaw) } });
        await owner.authSession.update({ where: { id: otherSession.id }, data: { idleExpiresAt: new Date(0) } });
        assert.equal((await request('/applications/' + app.id, 'GET', undefined, { Cookie: '__Host-ceda_session=' + otherRaw })).status, 401);
        const renewed = token();
        await store.create(identity, hash(renewed), null, 1800, 28800);
        await owner.authUser.update({ where: { id: session.userId }, data: { status: 'SUSPENDED' } });
        assert.equal((await request('/applications/' + app.id, 'GET', undefined, { Cookie: '__Host-ceda_session=' + renewed })).status, 401);
    }
    finally {
        if (server) {
            server.closeAllConnections();
            await new Promise<void>(resolve => server!.close(() => resolve()));
        }
        await runtime?.$disconnect();
        await login?.end();
        await owner.$disconnect();
        await admin.end();
        rmSync(documentRoot, { recursive: true, force: true });
        if (previousDocumentRoot === undefined) delete process.env.APPLICATION_STORAGE_DIR;
        else process.env.APPLICATION_STORAGE_DIR = previousDocumentRoot;
    }
});
