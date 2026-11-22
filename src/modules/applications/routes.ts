import { Router, raw, type Request } from 'express';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Principal, SessionVerifier } from '../../shared/authorization.js';
import { HttpError } from '../../shared/errors.js';
import { validateBody } from '../../shared/validation.js';
import { ApplicationService, budgetDto, draftFields } from './service.js';
import { PrismaApplicationRepository } from './repository.js';
import { LocalPrivateDocumentStorage } from './document-storage.js';
const uuid = z.string().uuid();
const revision = z.number().int().nonnegative().max(2147483647);
const expectedRevision = revision.max(2147483646);
const documentDto = z.strictObject({ id: uuid, category: z.string(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), sha256: z.string().length(64), uploadedAt: z.date(), expiresAt: z.date().nullable() });
const submissionDto = z.strictObject({
    id: uuid, applicationId: uuid, programmeVersionId: uuid, version: z.number().int().positive().optional(), reference: z.string().max(64),
    revision, fields: draftFields, budget: budgetDto,
    documents: z.array(documentDto), submittedAt: z.date(),
});
const applicationDto = z.strictObject({
    id: uuid, ownerId: uuid, programmeId: uuid, programmeVersionId: uuid,
    revision, stage: z.enum(['DRAFT', 'SUBMITTED']), fields: draftFields, budget: budgetDto,
    documents: z.array(documentDto), latestSubmission: submissionDto.nullable().optional(),
});
function identifier(value: unknown): string {
    const parsed = uuid.safeParse(value);
    if (!parsed.success)
        throw new HttpError(422, 'VALIDATION_FAILED', 'A valid identifier is required.');
    return parsed.data;
}
export function applicationRoutes(db: PrismaClient, sessions: SessionVerifier, requireCsrf: (request: Request) => void) {
    const router = Router();
    const documentStorage = new LocalPrivateDocumentStorage();
    router.use(async (req, res, next) => {
        const principal = await sessions.verify(req.headers.cookie);
        if (!principal)
            throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
        res.locals.principal = principal;
        if (!['GET', 'HEAD'].includes(req.method))
            requireCsrf(req);
        next();
    });
    function command(principal: Principal, requestId: string) {
        return new ApplicationService(new PrismaApplicationRepository(db, principal, requestId));
    }
    router.get('/', async (_req, res) => {
        const principal = res.locals.principal as Principal;
        const result = await command(principal, res.locals.requestId as string).list(principal);
        res.json({ data: z.array(applicationDto).parse(result) });
    });
    router.post('/', validateBody(z.strictObject({ programmeId: uuid, programmeVersionId: uuid })), async (req, res) => {
        const principal = res.locals.principal as Principal;
        const result = await command(principal, res.locals.requestId as string).create(principal, req.body.programmeId, req.body.programmeVersionId);
        res.status(201).json({ data: applicationDto.parse(result) });
    });
    router.post('/:id/documents', raw({ type: 'application/octet-stream', limit: 10 * 1024 * 1024 }), async (req, res) => {
        const principal = res.locals.principal as Principal;
        const applicationId = identifier(req.params.id);
        const name = z.string().min(1).max(200).regex(/^[^\\/\x00-\x1f]+$/).safeParse(req.query.name);
        const category = z.enum(['technical-proposal', 'company-registration', 'identity', 'shareholding', 'tax-clearance', 'supporting']).safeParse(req.query.category);
        const expected = z.coerce.number().int().nonnegative().safeParse(req.query.expectedRevision);
        let expiresAt: Date | null = null;
        if (req.query.expiresAt !== undefined) {
            const expiry = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(req.query.expiresAt);
            const expiryDate = expiry.success ? new Date(`${expiry.data}T00:00:00.000Z`) : null;
            if (!expiry.success || !expiryDate || !Number.isFinite(expiryDate.getTime()) || expiryDate.toISOString().slice(0, 10) !== expiry.data || expiry.data < new Date().toISOString().slice(0, 10))
                throw new HttpError(422, 'VALIDATION_FAILED', 'Choose a valid current or future document expiry date.');
            expiresAt = expiryDate;
        }
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!name.success || !category.success || !expected.success || !body.length) throw new HttpError(422, 'VALIDATION_FAILED', 'Choose a valid document, category, and current draft revision.');
        const extensions: Record<string, { mime: string; signature: (bytes: Buffer) => boolean }> = {
            '.pdf': { mime: 'application/pdf', signature: b => b.subarray(0, 5).toString() === '%PDF-' },
            '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', signature: b => b.subarray(0, 4).equals(Buffer.from([0x50,0x4b,0x03,0x04])) && b.includes(Buffer.from('[Content_Types].xml')) && b.includes(Buffer.from('word/document.xml')) },
            '.png': { mime: 'image/png', signature: b => b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) },
            '.jpg': { mime: 'image/jpeg', signature: b => b.subarray(0, 3).equals(Buffer.from([255,216,255])) },
            '.jpeg': { mime: 'image/jpeg', signature: b => b.subarray(0, 3).equals(Buffer.from([255,216,255])) },
        };
        const fileType = extensions[name.data.slice(name.data.lastIndexOf('.')).toLowerCase()];
        if (!fileType || !fileType.signature(body) || req.headers['content-type'] !== 'application/octet-stream') throw new HttpError(422, 'INVALID_DOCUMENT', 'The file content must match a supported PDF, DOCX, JPG, or PNG file.');
        const id = randomUUID();
        const storageKey = randomUUID();
        await documentStorage.put(storageKey, body);
        try {
            const result = await db.$transaction(async tx => {
                const application = await tx.application.findFirst({ where: { id: applicationId, ownerId: principal.userId } });
                if (!application) throw new HttpError(404, 'NOT_FOUND', 'Resource not found.');
                if (application.stage !== 'DRAFT' || application.revision !== expected.data) throw new HttpError(409, 'REVISION_CONFLICT', 'The application has changed.');
                if (await tx.applicationDocument.count({ where: { applicationId, submissionVersionId: null } }) >= 10) throw new HttpError(422, 'DOCUMENT_LIMIT', 'Attach up to 10 documents.');
                const document = await tx.applicationDocument.create({ data: { id, applicationId, ownerId: principal.userId, category: category.data, originalName: name.data, contentType: fileType.mime, sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), storageKey, expiresAt } });
                const revision = application.revision + 1;
                await tx.application.update({ where: { id: applicationId }, data: { revision } });
                const audit = await tx.auditEvent.create({ data: { id: randomUUID(), actorId: principal.userId, applicationId, action: 'application.document_uploaded', revision, requestId: res.locals.requestId as string } });
                await tx.outboxEvent.create({ data: { id: randomUUID(), auditEventId: audit.id, recipientId: principal.userId, kind: 'application.document_uploaded' } });
                return { document, revision };
            });
            res.status(201).json({ data: { id: result.document.id, category: result.document.category, name: result.document.originalName, contentType: result.document.contentType, sizeBytes: result.document.sizeBytes, sha256: result.document.sha256, uploadedAt: result.document.uploadedAt, expiresAt: result.document.expiresAt, revision: result.revision } });
        } catch (error) { await documentStorage.remove(storageKey); throw error; }
    });
    router.get('/:id/documents/:documentId', async (req, res) => {
        const principal = res.locals.principal as Principal;
        const doc = await db.applicationDocument.findFirst({ where: { id: identifier(req.params.documentId), applicationId: identifier(req.params.id), ownerId: principal.userId, application: { ownerId: principal.userId } } });
        if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Resource not found.');
        const bytes = await documentStorage.get(doc.storageKey);
        if (createHash('sha256').update(bytes).digest('hex') !== doc.sha256) throw new HttpError(500, 'DOCUMENT_INTEGRITY_FAILED', 'The stored document failed its integrity check.');
        res.setHeader('Content-Type', doc.contentType);
        res.setHeader('Content-Length', String(doc.sizeBytes));
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.originalName)}`);
        res.send(bytes);
    });
    router.get('/:id', async (req, res) => {
        const principal = res.locals.principal as Principal;
        const result = await command(principal, res.locals.requestId as string).read(principal, identifier(req.params.id));
        res.json({ data: applicationDto.parse(result) });
    });
    router.patch('/:id', validateBody(z.strictObject({ expectedRevision, fields: draftFields, budget: budgetDto.optional() })), async (req, res) => {
        const principal = res.locals.principal as Principal;
        const result = await command(principal, res.locals.requestId as string).update(principal, identifier(req.params.id), req.body.expectedRevision, req.body.fields, req.body.budget);
        res.json({ data: applicationDto.parse(result) });
    });
    router.post('/:id/submit', validateBody(z.strictObject({ expectedRevision })), async (req, res) => {
        const key = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).safeParse(req.headers['idempotency-key']);
        if (!key.success)
            throw new HttpError(422, 'VALIDATION_FAILED', 'A valid Idempotency-Key is required.');
        const principal = res.locals.principal as Principal;
        const result = await command(principal, res.locals.requestId as string).submit(principal, identifier(req.params.id), req.body.expectedRevision, key.data);
        res.json({ data: submissionDto.parse(result) });
    });
    router.get('/:id/submissions/:versionId', async (req, res) => {
        const principal = res.locals.principal as Principal;
        const result = await command(principal, res.locals.requestId as string).readSubmission(principal, identifier(req.params.id), identifier(req.params.versionId));
        res.json({ data: submissionDto.parse(result) });
    });
    return router;
}
