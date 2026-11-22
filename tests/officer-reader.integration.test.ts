import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { ApplicationService } from '../src/modules/applications/service.js';
import { PrismaApplicationRepository } from '../src/modules/applications/repository.js';
import {
  PrismaOfficerSubmissionReader, OFFICER_SUBMISSION_PERMISSION,
  type AuthenticatedRequestContext,
} from '../src/modules/applications/officer-submission-reader.js';
import { PrismaOfficerReviewScope } from '../src/modules/applications/prisma-officer-review-scope.js';
import { attachFixtureTechnicalProposal, requiredFixtureBudget } from './support/valid-submission-fixture.js';
import { OFFICER_ASSIGNMENT_MANAGE_PERMISSION, PrismaOfficerAssignmentService } from '../src/modules/applications/officer-assignment-service.js';

test('officer version reads enforce live grants, scope, self-review, session status and DTO isolation', async () => {
  assert.match(process.env.DISPOSABLE_DATABASE_RUN ?? '', /^[a-f0-9-]{36}$/);
  const url = process.env.DATABASE_URL!;
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const admin = new Client({ connectionString: url });
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, options: '-c timezone=UTC', max: 5 }) });
  let runtime: PrismaClient | undefined;
  let provisioner: PrismaClient | undefined;
  await admin.connect();
  try {
    await admin.query(readFileSync('ops/assignment-provisioner-role.sql', 'utf8'));
    const person = async () => {
      const user = await db.authUser.create({ data: { name: 'Fictional reader fixture', email: randomUUID() + '@example.test' } });
      const session = await db.authSession.create({ data: { userId: user.id, tokenHash: randomBytes(32).toString('hex'), idleExpiresAt: new Date(Date.now() + 600000), absoluteExpiresAt: new Date(Date.now() + 1200000) } });
      return { principal: { userId: user.id, sessionId: session.id, authnLevel: 'oidc' }, requestId: randomUUID() };
    };
    const applicant = await person(), officer = await person(), other = await person();
    const programme = await db.programme.create({ data: { code: randomUUID(), name: 'Fictional officer intake' } });
    const published = await db.programmeVersion.create({ data: { programmeId: programme.id, version: 1, publishedAt: new Date(Date.now() - 60000), opensAt: new Date(Date.now() - 60000), closesAt: new Date(Date.now() + 600000), config: { themes: ['digital'] } } });
    const own = new ApplicationService(new PrismaApplicationRepository(db, applicant.principal, applicant.requestId));
    const app = await own.create(applicant.principal, programme.id, published.id);
    const fields = { title: 'Idea', theme: 'digital', problem: 'Problem', solution: 'Solution', impact: 'Impact', team: 'Team' };
    await own.update(applicant.principal, app.id, 0, fields, requiredFixtureBudget);
    await attachFixtureTechnicalProposal(db, app.id, applicant.principal.userId);
    const submission = await own.submit(applicant.principal, app.id, 1, 'officer-fixture');
    const role = 'officer_' + randomUUID().replaceAll('-', '');
    const password = randomBytes(24).toString('hex');
    await admin.query('CREATE ROLE ' + role + " LOGIN PASSWORD '" + password + "' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    await admin.query('GRANT USAGE ON SCHEMA public TO ' + role);
    await admin.query('GRANT SELECT ON users,sessions,applications,submission_versions,programme_versions,programme_grants TO ' + role);
    await admin.query('GRANT UPDATE(id) ON users,sessions,applications,programme_grants TO ' + role);
    await admin.query('GRANT SELECT ON officer_assignments,conflict_disclosures TO ' + role);
    const runtimeUrl = new URL(url); runtimeUrl.username = role; runtimeUrl.password = password;
    runtime = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeUrl.href, options: '-c timezone=UTC', max: 5 }) });
    const provisionerRole = 'assignment_' + randomUUID().replaceAll('-', '');
    const provisionerPassword = randomBytes(24).toString('hex');
    await admin.query('CREATE ROLE ' + provisionerRole + " LOGIN PASSWORD '" + provisionerPassword + "' IN ROLE ceda_assignment_manager NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    const provisionerUrl = new URL(url); provisionerUrl.username = provisionerRole; provisionerUrl.password = provisionerPassword;
    provisioner = new PrismaClient({ adapter: new PrismaPg({ connectionString: provisionerUrl.href, options: '-c timezone=UTC -c role=ceda_assignment_manager', max: 5 }) });
    assert.deepEqual(await provisioner.$queryRaw`SELECT current_user::text AS role`, [{ role: 'ceda_assignment_manager' }]);
    const scope = new PrismaOfficerReviewScope();
    const reader = new PrismaOfficerSubmissionReader(runtime, scope);
    const read = (context: AuthenticatedRequestContext = officer) => reader.readForOfficer(context, submission.id);
    await assert.rejects(read(), { status: 404 });
    const grant = await db.programmeGrant.create({ data: { userId: officer.principal.userId, programmeId: programme.id, permission: OFFICER_SUBMISSION_PERMISSION, grantedById: applicant.principal.userId, grantedAt: new Date(Date.now() - 60000) } });
    await assert.rejects(read(), { status: 404 }); // grant alone is never sufficient
    await db.programmeGrant.create({ data: { userId: applicant.principal.userId, programmeId: programme.id,
      permission: OFFICER_ASSIGNMENT_MANAGE_PERMISSION, grantedById: applicant.principal.userId } });
    const assignments = new PrismaOfficerAssignmentService(provisioner);
    const issueCommand = { actorId: officer.principal.userId, applicationId: app.id, submissionVersionId: submission.id, programmeId: programme.id };
    await assert.rejects(new PrismaOfficerAssignmentService(runtime).issue(officer.principal, randomUUID(), issueCommand), { status: 403 });
    await assert.rejects(assignments.issue(applicant.principal, randomUUID(), { ...issueCommand, actorId: applicant.principal.userId }), { status: 404 });
    await assert.rejects(provisioner.$executeRaw`UPDATE officer_assignments SET actor_id=${applicant.principal.userId}::uuid`);
    await assert.rejects(provisioner.$executeRaw`DELETE FROM officer_assignments`);
    await assert.rejects(provisioner.$executeRaw`ALTER TABLE officer_assignments ADD COLUMN forbidden integer`);
    await assert.rejects(provisioner.$queryRaw`SELECT * FROM eligibility_rule_versions`);
    const issueRequestId = randomUUID();
    const issued = await assignments.issue(applicant.principal, issueRequestId, issueCommand);
    assert.equal(issued.replayed, false);
    assert.deepEqual(await assignments.issue(applicant.principal, issueRequestId, issueCommand), { assignmentId: issued.assignmentId, replayed: true });
    await assert.rejects(assignments.issue(applicant.principal, issueRequestId, { ...issueCommand, expiresAt: new Date(Date.now() + 60000) }), { status: 409 });
    const assignment = await db.officerAssignment.findUniqueOrThrow({ where: { id: issued.assignmentId } });
    const disclosureResult = await assignments.discloseConflict(officer.principal, randomUUID(), assignment.id);
    const resolved = await assignments.resolveConflict(applicant.principal, randomUUID(), disclosureResult.disclosureId, 'NO_CONFLICT', 'Fixture conflict review');
    assert.equal(resolved.replayed, false);
    const disclosure = await db.conflictDisclosure.findUniqueOrThrow({ where: { id: disclosureResult.disclosureId } });
    const result = await read();
    assert.deepEqual(await reader.readForOfficer({ ...officer, principal: {
      ...officer.principal, userId: officer.principal.userId.toUpperCase(), sessionId: officer.principal.sessionId.toUpperCase(),
    } }, submission.id.toUpperCase()), result);
    assert.deepEqual(result, {
      submissionVersionId: submission.id, applicationId: app.id, programmeId: programme.id,
      programmeVersionId: published.id, submissionVersionNumber: 1, reference: submission.reference,
      submittedAt: submission.submittedAt.toISOString(), submissionFields: {
        title: fields.title, theme: fields.theme, problem: fields.problem,
        solution: fields.solution, impact: fields.impact,
      },
    });
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.submissionFields));
    await assert.rejects(new PrismaOfficerSubmissionReader(runtime).readForOfficer(officer, submission.id), { status: 404 });
    const deniedByPostgres = (error: unknown) => error instanceof Error &&
      'code' in error && error.code === 'P2010' && error.message.includes('42501') && error.message.includes('permission denied');
    await assert.rejects(runtime.$executeRaw`UPDATE officer_assignments SET status='REVOKED' WHERE id=${assignment.id}::uuid`, deniedByPostgres);
    await assert.rejects(runtime.$executeRaw`DELETE FROM officer_assignments WHERE id=${assignment.id}::uuid`, deniedByPostgres);
    await assert.rejects(runtime.$executeRaw`UPDATE conflict_disclosures SET status='CLEARED' WHERE id=${disclosure.id}::uuid`, deniedByPostgres);
    await db.conflictDisclosure.update({ where: { id: disclosure.id }, data: { status: 'UNRESOLVED', resolvedAt: null, resolvedById: null, resolutionRequestId: null } });
    await assert.rejects(read(), { status: 404 });
    await db.conflictDisclosure.update({ where: { id: disclosure.id }, data: { status: 'NO_CONFLICT', resolvedAt: new Date(), resolvedById: applicant.principal.userId, resolutionRequestId: randomUUID() } });
    await db.conflictDisclosure.update({ where: { id: disclosure.id }, data: { status: 'CONFLICT' } });
    await assert.rejects(read(), { status: 404 });
    await db.conflictDisclosure.update({ where: { id: disclosure.id }, data: { status: 'NO_CONFLICT' } });

    const mismatch = await runtime.$transaction(tx => scope.allows(tx, officer, {
      submissionVersionId: submission.id, applicationId: app.id, programmeId: randomUUID(), programmeVersionId: published.id,
    }));
    assert.equal(mismatch, false, 'cross-programme scope is denied');
    const wrongVersion = await runtime.$transaction(tx => scope.allows(tx, officer, {
      submissionVersionId: randomUUID(), applicationId: app.id, programmeId: programme.id, programmeVersionId: published.id,
    }));
    assert.equal(wrongVersion, false, 'wrong immutable version is denied');

    const applicantGrant = await db.programmeGrant.create({ data: {
      userId: applicant.principal.userId, programmeId: programme.id,
      permission: OFFICER_SUBMISSION_PERMISSION, grantedById: officer.principal.userId,
    } });
    const selfAssignment = await db.officerAssignment.create({ data: {
      applicationId: app.id, submissionVersionId: submission.id, programmeId: programme.id,
      actorId: applicant.principal.userId, issuedById: officer.principal.userId, issuedRequestId: randomUUID(),
      validFrom: new Date(Date.now() - 60000),
    } });
    await db.conflictDisclosure.create({ data: {
      assignmentId: selfAssignment.id, status: 'NO_CONFLICT', disclosedById: applicant.principal.userId,
      disclosedRequestId: randomUUID(), resolvedAt: new Date(), resolvedById: officer.principal.userId,
      resolutionRequestId: randomUUID(),
    } });
    await assert.rejects(reader.readForOfficer(applicant, submission.id), { status: 404 });
    await db.programmeGrant.update({ where: { id: applicantGrant.id }, data: { revokedAt: new Date() } });

    const expiredApp = await own.create(applicant.principal, programme.id, published.id);
    await own.update(applicant.principal, expiredApp.id, 0, fields, requiredFixtureBudget);
    await attachFixtureTechnicalProposal(db, expiredApp.id, applicant.principal.userId);
    const expiredSubmission = await own.submit(applicant.principal, expiredApp.id, 1, 'officer-expired-fixture');
    await assignments.issue(applicant.principal, randomUUID(), {
      actorId: officer.principal.userId, applicationId: expiredApp.id, submissionVersionId: expiredSubmission.id,
      programmeId: programme.id, validFrom: new Date(Date.now() - 60000), expiresAt: new Date(Date.now() - 1000),
    });
    await assert.rejects(reader.readForOfficer(officer, expiredSubmission.id), { status: 404 });

    const revokeApp = await own.create(applicant.principal, programme.id, published.id);
    await own.update(applicant.principal, revokeApp.id, 0, fields, requiredFixtureBudget);
    await attachFixtureTechnicalProposal(db, revokeApp.id, applicant.principal.userId);
    const revokeSubmission = await own.submit(applicant.principal, revokeApp.id, 1, 'officer-revoke-fixture');
    const revokeAssignment = await db.officerAssignment.create({ data: {
      applicationId: revokeApp.id, submissionVersionId: revokeSubmission.id, programmeId: programme.id,
      actorId: officer.principal.userId, issuedById: applicant.principal.userId, issuedRequestId: randomUUID(),
      validFrom: new Date(Date.now() - 60000),
    } });
    await db.conflictDisclosure.create({ data: {
      assignmentId: revokeAssignment.id, status: 'NO_CONFLICT', disclosedById: officer.principal.userId,
      disclosedRequestId: randomUUID(), resolvedAt: new Date(), resolvedById: applicant.principal.userId,
      resolutionRequestId: randomUUID(),
    } });

    let releaseRead!: () => void;
    let signalReadLocked!: () => void;
    const readLocked = new Promise<void>(resolve => { signalReadLocked = resolve; });
    const holdRead = new Promise<void>(resolve => { releaseRead = resolve; });
    const authorizationTransaction = runtime.$transaction(async tx => {
      const allowed = await scope.allows(tx, officer, {
        submissionVersionId: revokeSubmission.id, applicationId: revokeApp.id, programmeId: programme.id, programmeVersionId: published.id,
      });
      signalReadLocked();
      await holdRead;
      return allowed;
    });
    await readLocked;
    let revocationFinished = false;
    const revocationRequestId = randomUUID();
    const revocation = assignments.revoke(applicant.principal, revocationRequestId, revokeAssignment.id, 'Test revocation')
      .then(() => { revocationFinished = true; });
    const assignmentLock = await admin.query("SELECT hashtextextended('officer-assignment-scope:' || $1::uuid::text || ':' || $2::uuid::text || ':' || $3::uuid::text || ':' || $4::uuid::text, 0)::text AS value",
      [officer.principal.userId, revokeApp.id, revokeSubmission.id, programme.id]);
    const assignmentLockKey = BigInt(assignmentLock.rows[0]!.value);
    const assignmentLockClass = Number((assignmentLockKey >> 32n) & 0xffff_ffffn);
    const assignmentLockObject = Number(assignmentLockKey & 0xffff_ffffn);
    const waitForLock = async (lockClass: number, lockObject: number) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await admin.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=$1::oid AND objid=$2::oid AND objsubid=1 LIMIT 1", [lockClass, lockObject]);
        if (waiting.rowCount) return true;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return false;
    };
    assert.equal(await waitForLock(assignmentLockClass, assignmentLockObject), true, 'revocation waits on the scope transaction lock');
    assert.equal(revocationFinished, false);
    releaseRead();
    assert.equal(await authorizationTransaction, true);
    await revocation;
    assert.deepEqual(await assignments.revoke(applicant.principal, revocationRequestId, revokeAssignment.id, 'Test revocation'), {
      assignmentId: revokeAssignment.id, replayed: true,
    });
    await assert.rejects(reader.readForOfficer(officer, revokeSubmission.id), { status: 404 });
    await assert.rejects(db.officerAssignment.delete({ where: { id: revokeAssignment.id } }));

    let releaseConflictRead!: () => void;
    let signalConflictRead!: () => void;
    const conflictReadLocked = new Promise<void>(resolve => { signalConflictRead = resolve; });
    const holdConflictRead = new Promise<void>(resolve => { releaseConflictRead = resolve; });
    const conflictAuthorization = runtime.$transaction(async tx => {
      const allowed = await scope.allows(tx, officer, {
        submissionVersionId: submission.id, applicationId: app.id, programmeId: programme.id, programmeVersionId: published.id,
      });
      signalConflictRead();
      await holdConflictRead;
      return allowed;
    });
    await conflictReadLocked;
    let conflictWriteFinished = false;
    const conflictWrite = db.conflictDisclosure.update({ where: { id: disclosure.id }, data: { status: 'CONFLICT' } })
      .then(() => { conflictWriteFinished = true; });
    const conflictLock = await admin.query("SELECT hashtextextended('officer-conflict:' || $1::uuid::text, 0)::text AS value", [assignment.id]);
    const conflictLockKey = BigInt(conflictLock.rows[0]!.value);
    const conflictLockClass = Number((conflictLockKey >> 32n) & 0xffff_ffffn);
    const conflictLockObject = Number(conflictLockKey & 0xffff_ffffn);
    assert.equal(await waitForLock(conflictLockClass, conflictLockObject), true, 'conflict changes wait on the scope transaction lock');
    assert.equal(conflictWriteFinished, false);
    releaseConflictRead();
    assert.equal(await conflictAuthorization, true);
    await conflictWrite;
    await assert.rejects(read(), { status: 404 });
    await db.conflictDisclosure.update({ where: { id: disclosure.id }, data: { status: 'NO_CONFLICT' } });
    await db.programmeGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date() } });
    await assert.rejects(read(), { status: 404 });
    await db.programmeGrant.update({ where: { id: grant.id }, data: { revokedAt: null, expiresAt: new Date(Date.now() - 1000) } });
    await assert.rejects(read(), { status: 404 });
    await db.programmeGrant.update({ where: { id: grant.id }, data: { expiresAt: null } });
    assert.equal((await read()).submissionVersionId, submission.id);
    await assert.rejects(read(other), { status: 404 });
    await db.programmeGrant.create({ data: { userId: applicant.principal.userId, programmeId: programme.id, permission: OFFICER_SUBMISSION_PERMISSION, grantedById: officer.principal.userId } });
    await assert.rejects(read(applicant), { status: 404 });
    await assert.rejects(reader.readForOfficer({ ...applicant, principal: { ...applicant.principal, userId: applicant.principal.userId.toUpperCase() } }, submission.id), { status: 404 });
    // The scope deliberately permits this exact version: self-review must still
    // be denied before scope can turn a differently spelled UUID into authority.
    await assert.rejects(read({ ...applicant, principal: {
      ...applicant.principal, userId: applicant.principal.userId.toUpperCase(), sessionId: applicant.principal.sessionId.toUpperCase(),
    } }), { status: 404 });
    assert.equal((await own.readSubmission(applicant.principal, app.id, submission.id)).id, submission.id);
    const otherService = new ApplicationService(new PrismaApplicationRepository(db, other.principal, other.requestId));
    await assert.rejects(otherService.readSubmission(other.principal, app.id, submission.id), { status: 404 });
    const unrelated = await db.programme.create({ data: { code: randomUUID(), name: 'Other scope' } });
    await db.programmeGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date() } });
    await db.programmeGrant.create({ data: { userId: officer.principal.userId, programmeId: unrelated.id, permission: OFFICER_SUBMISSION_PERMISSION, grantedById: applicant.principal.userId } });
    await db.programmeGrant.create({ data: { userId: officer.principal.userId, programmeId: programme.id, permission: 'programme.manage', grantedById: applicant.principal.userId } });
    assert.equal(await runtime.$transaction(tx => scope.allows(tx, officer, {
      submissionVersionId: submission.id, applicationId: app.id, programmeId: unrelated.id, programmeVersionId: published.id,
    })), false, 'matching grant for another programme cannot authorize this submission');
    await assert.rejects(db.officerAssignment.create({ data: {
      applicationId: app.id, submissionVersionId: submission.id, programmeId: unrelated.id,
      actorId: officer.principal.userId, issuedById: applicant.principal.userId, issuedRequestId: randomUUID(),
    } }), { code: 'P2003' });
    await assert.rejects(read(), { status: 404 });
    await db.programmeGrant.update({ where: { id: grant.id }, data: { revokedAt: null } });
    await assert.rejects(reader.readForOfficer(officer, randomUUID()), { status: 404 });
    await assert.rejects(reader.readForOfficer(officer, 'invalid'), { status: 422 });
    await assert.rejects(read({ ...officer, principal: { ...officer.principal, userId: other.principal.userId } }), { status: 401 });
    const otherDraft = await own.create(applicant.principal, programme.id, published.id);
    await assert.rejects(db.submissionVersion.create({ data: { applicationId: otherDraft.id, programmeVersionId: randomUUID(), version: 1, revision: 1, reference: randomUUID(), fields } }), { code: 'P2003' });
    await db.authSession.update({ where: { id: officer.principal.sessionId }, data: { revokedAt: new Date() } });
    await assert.rejects(read(), { status: 401 });
    await db.authSession.update({ where: { id: officer.principal.sessionId }, data: { revokedAt: null, idleExpiresAt: new Date(0) } });
    await assert.rejects(read(), { status: 401 });
    await db.authSession.update({ where: { id: officer.principal.sessionId }, data: { idleExpiresAt: new Date(Date.now() + 600000) } });
    await db.authUser.update({ where: { id: officer.principal.userId }, data: { status: 'SUSPENDED' } });
    await assert.rejects(read(), { status: 401 });
  } finally { await provisioner?.$disconnect(); await runtime?.$disconnect(); await db.$disconnect(); await admin.end(); }
});
