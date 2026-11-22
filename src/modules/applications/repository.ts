import { requireActiveSession, requireProgrammePermission } from '../auth/session-access.js';
import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { HttpError } from '../../shared/errors.js';
import type { Principal } from '../../shared/authorization.js';
import { parseStoredBudget, draftFields, type Application, type ApplicationRepository, type ApplicationTransaction, type Submission } from './service.js';
import { z } from 'zod';
export class PrismaApplicationRepository implements ApplicationRepository {
    constructor(private readonly db: PrismaClient, private readonly principal: Principal, private readonly requestId: string) {
        z.string().uuid().parse(requestId);
    }
    async transaction<T>(work: (tx: ApplicationTransaction) => Promise<T>): Promise<T> {
        return this.db.$transaction(async (db) => {
            const principal = this.principal;
            let authenticated = false;
            const requireAuthenticated = () => {
                if (!authenticated)
                    throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
            };
            const tx: ApplicationTransaction = {
                async submission(applicationId, versionId) {
                    requireAuthenticated();
                    const row = await db.submissionVersion.findFirst({
                        where: { id: versionId, applicationId, application: { ownerId: principal.userId } }, include: { documents: true },
                    });
                    if (!row)
                        return null;
                    return { id: row.id, applicationId: row.applicationId, programmeVersionId: row.programmeVersionId,
                        reference: row.reference, revision: row.revision, fields: draftFields.parse(row.fields), budget: parseStoredBudget(row.budget), documents: row.documents.map(d => ({ id:d.id,category:d.category,name:d.originalName,contentType:d.contentType,sizeBytes:d.sizeBytes,sha256:d.sha256,uploadedAt:d.uploadedAt,expiresAt:d.expiresAt })), submittedAt: row.submittedAt };
                },
                async requireProgrammePermission(programmeId, permission) {
                    requireAuthenticated();
                    await requireProgrammePermission(db, principal, programmeId, permission);
                },
                async requireSession(supplied) {
                    if (supplied.userId !== principal.userId || supplied.sessionId !== principal.sessionId)
                        throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
                    await requireActiveSession(db, principal);
                    authenticated = true;
                },
                async now() { const rows = await db.$queryRaw<Array<{
                    now: Date;
                }>> `SELECT clock_timestamp() AS now`; return rows[0]!.now; },
                async programme(programmeId, versionId) {
                    requireAuthenticated();
                    const row = await db.programmeVersion.findFirst({ where: { id: versionId, programmeId, publishedAt: { lte: new Date() } } });
                    if (!row)
                        return null;
                    const config = z.object({ themes: z.array(z.string().min(1)).min(1) }).parse(row.config);
                    return { id: row.id, programmeId: row.programmeId, opensAt: row.opensAt, closesAt: row.closesAt, themes: config.themes };
                },
                async applications() {
                    requireAuthenticated();
                    const rows = await db.application.findMany({
                        where: { ownerId: principal.userId },
                        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
                        include: {
                            documents: { where: { submissionVersionId: null }, orderBy: { uploadedAt: 'asc' } },
                            submissions: { orderBy: { version: 'desc' }, take: 1, include: { documents: true } },
                        },
                    });
                    return rows.map(row => {
                        const latest = row.submissions[0];
                        return {
                            id: row.id, ownerId: row.ownerId, programmeId: row.programmeId,
                            programmeVersionId: row.programmeVersionId, revision: row.revision,
                            stage: z.enum(['DRAFT', 'SUBMITTED']).parse(row.stage),
                            fields: draftFields.parse(row.draft), budget: parseStoredBudget(row.budget),
                            documents: row.documents.map(d => ({ id:d.id,category:d.category,name:d.originalName,contentType:d.contentType,sizeBytes:d.sizeBytes,sha256:d.sha256,uploadedAt:d.uploadedAt,expiresAt:d.expiresAt })),
                            latestSubmission: latest ? {
                                id: latest.id, applicationId: latest.applicationId,
                                programmeVersionId: latest.programmeVersionId, version: latest.version, reference: latest.reference,
                                revision: latest.revision, fields: draftFields.parse(latest.fields),
                                budget: parseStoredBudget(latest.budget),
                                documents: latest.documents.map(d => ({ id:d.id,category:d.category,name:d.originalName,contentType:d.contentType,sizeBytes:d.sizeBytes,sha256:d.sha256,uploadedAt:d.uploadedAt,expiresAt:d.expiresAt })),
                                submittedAt: latest.submittedAt,
                            } : null,
                        };
                    });
                },
                async application(id) {
                    requireAuthenticated();
                    await db.$queryRaw `SELECT id FROM applications WHERE id=${id}::uuid AND owner_id=${principal.userId}::uuid FOR UPDATE`;
                    const row = await db.application.findFirst({ where: { id, ownerId: principal.userId }, include: {
                        documents: { where: { submissionVersionId: null }, orderBy: { uploadedAt: 'asc' } },
                        submissions: { orderBy: { version: 'desc' }, take: 1, include: { documents: true } },
                    } });
                    if (!row)
                        return null;
                    const latest = row.submissions[0];
                    return {
                        id: row.id, ownerId: row.ownerId, programmeId: row.programmeId,
                        programmeVersionId: row.programmeVersionId, revision: row.revision,
                        stage: z.enum(['DRAFT', 'SUBMITTED']).parse(row.stage),
                        fields: draftFields.parse(row.draft), budget: parseStoredBudget(row.budget),
                        documents: row.documents.map(d => ({ id:d.id,category:d.category,name:d.originalName,contentType:d.contentType,sizeBytes:d.sizeBytes,sha256:d.sha256,uploadedAt:d.uploadedAt,expiresAt:d.expiresAt })),
                        latestSubmission: latest ? {
                            id: latest.id, applicationId: latest.applicationId,
                            programmeVersionId: latest.programmeVersionId, version: latest.version, reference: latest.reference,
                            revision: latest.revision, fields: draftFields.parse(latest.fields),
                            budget: parseStoredBudget(latest.budget),
                            documents: latest.documents.map(d => ({ id:d.id,category:d.category,name:d.originalName,contentType:d.contentType,sizeBytes:d.sizeBytes,sha256:d.sha256,uploadedAt:d.uploadedAt,expiresAt:d.expiresAt })),
                            submittedAt: latest.submittedAt,
                        } : null,
                    };
                },
                async requirements(applicationId, ownerId) {
                    requireAuthenticated();
                    if (ownerId !== principal.userId) throw new HttpError(404, 'NOT_FOUND', 'Resource not found.');
                    const row = await db.application.findFirst({ where: { id: applicationId, ownerId }, include: { documents: { where: { submissionVersionId: null }, orderBy: { uploadedAt: 'asc' } } } });
                    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Resource not found.');
                    return { budget: parseStoredBudget(row.budget), documents: row.documents.map(d => ({ id:d.id,category:d.category,name:d.originalName,contentType:d.contentType,sizeBytes:d.sizeBytes,sha256:d.sha256,uploadedAt:d.uploadedAt,expiresAt:d.expiresAt })) };
                },
                async insert(app) {
                    requireAuthenticated();
                    if (app.ownerId !== principal.userId)
                        throw new HttpError(403, 'FORBIDDEN', 'This action is not permitted.');
                    await db.application.create({ data: { id: app.id, ownerId: app.ownerId, programmeId: app.programmeId, programmeVersionId: app.programmeVersionId, draft: app.fields, budget: { items: [], fundingRequested: '', notApplicable: false } } });
                },
                async save(app) {
                    requireAuthenticated();
                    const result = await db.application.updateMany({ where: { id: app.id, ownerId: principal.userId, revision: app.revision - 1, stage: 'DRAFT' }, data: { draft: app.fields, budget: app.budget, revision: app.revision } });
                    if (result.count !== 1)
                        throw new HttpError(409, 'REVISION_CONFLICT', 'The application has changed.');
                },
                async receipt(actorId, applicationId, key) {
                    requireAuthenticated();
                    if (actorId !== principal.userId)
                        throw new HttpError(403, 'FORBIDDEN', 'This action is not permitted.');
                    const row = await db.commandReceipt.findUnique({ where: { actorId_applicationId_operation_key: { actorId, applicationId, operation: 'submit', key } }, include: { submission: true } });
                    if (!row)
                        return null;
                    const s = row.submission;
                    const docs = await db.applicationDocument.findMany({ where: { submissionVersionId: s.id }, orderBy: { uploadedAt: 'asc' } });
                    return { id: s.id, applicationId: s.applicationId, programmeVersionId: s.programmeVersionId, reference: s.reference, revision: s.revision, fields: draftFields.parse(s.fields), budget: parseStoredBudget(s.budget), documents: docs.map(d => ({ id:d.id,category:d.category,name:d.originalName,contentType:d.contentType,sizeBytes:d.sizeBytes,sha256:d.sha256,uploadedAt:d.uploadedAt,expiresAt:d.expiresAt })), submittedAt: s.submittedAt };
                },
                async submit(app: Application, s: Submission, actorId, key) {
                    requireAuthenticated();
                    if (actorId !== principal.userId || app.ownerId !== actorId)
                        throw new HttpError(403, 'FORBIDDEN', 'This action is not permitted.');
                    const changed = await db.application.updateMany({ where: { id: app.id, ownerId: actorId, revision: app.revision - 1, stage: 'DRAFT' }, data: { stage: 'SUBMITTED', revision: app.revision } });
                    if (changed.count !== 1)
                        throw new HttpError(409, 'REVISION_CONFLICT', 'The application has changed.');
                    await db.submissionVersion.create({ data: { id: s.id, applicationId: s.applicationId, programmeVersionId: s.programmeVersionId, version: 1, revision: s.revision, reference: s.reference, fields: s.fields, budget: s.budget, submittedAt: s.submittedAt } });
                    await db.applicationDocument.updateMany({ where: { applicationId: app.id, ownerId: actorId, submissionVersionId: null }, data: { submissionVersionId: s.id } });
                    await db.commandReceipt.create({ data: { actorId, applicationId: app.id, operation: 'submit', key, requestHash: createHash('sha256').update(JSON.stringify(['submit', app.id, app.revision - 1])).digest('hex'), submissionVersionId: s.id } });
                },
                record: async (actorId, applicationId, action, revision) => {
                    requireAuthenticated();
                    if (actorId !== principal.userId)
                        throw new HttpError(403, 'FORBIDDEN', 'This action is not permitted.');
                    await db.auditEvent.create({ data: { id: randomUUID(), actorId, applicationId, action, revision, requestId: this.requestId, outbox: { create: { recipientId: actorId, kind: action } } } });
                },
            };
            const result = await work(tx);
            // Recheck expiry before committing while revocation/suspension locks are held.
            await tx.requireSession(principal);
            return result;
        }, { maxWait: 5000, timeout: 10000 });
    }
}
