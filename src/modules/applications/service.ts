import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../../shared/errors.js';
import type { Principal } from '../../shared/authorization.js';
export const draftFields = z.strictObject({
    title: z.string().trim().max(120), theme: z.string().trim().max(100),
    problem: z.string().trim().max(3000), solution: z.string().trim().max(5000),
    impact: z.string().trim().max(3000), team: z.string().trim().max(150),
    // Optional for backward compatibility. These are unverified applicant
    // inputs bound to the submission snapshot, never officer evidence.
    eligibilityEvidence: z.array(z.strictObject({
        requirementId: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
        value: z.union([z.boolean(), z.number().finite(), z.null()]),
        unit: z.string().trim().min(1).max(40).optional(),
    })).max(200).optional(),
});
const budgetFields = z.strictObject({
  items: z.array(z.strictObject({ description: z.string().trim().min(1).max(200), amount: z.string().regex(/^\d+(\.\d{1,2})?$/) })),
  fundingRequested: z.string().regex(/^(|\d+(\.\d{1,2})?)$/),
  notApplicable: z.boolean(),
});
function cents(value: string): bigint { const [whole, fraction = ''] = value.split('.'); return BigInt(whole || '0') * 100n + BigInt((fraction + '00').slice(0, 2)); }
export const budgetDto = budgetFields.superRefine((budget, context) => {
  if (budget.items.some(item => cents(item.amount) <= 0n)) context.addIssue({ code: 'custom', message: 'Budget amounts must be positive.' });
  const total = budget.items.reduce((sum, item) => sum + cents(item.amount), 0n);
  if (budget.fundingRequested && cents(budget.fundingRequested) > total) context.addIssue({ code: 'custom', message: 'Requested funding cannot exceed the budget total.' });
});
export function parseStoredBudget(value: unknown): Budget {
    if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)
        return { items: [], fundingRequested: '', notApplicable: false };
    return budgetDto.parse(value);
}
export type Budget = z.infer<typeof budgetDto>;
export type DraftFields = z.infer<typeof draftFields>;
export interface Application {
    id: string;
    ownerId: string;
    programmeId: string;
    programmeVersionId: string;
    revision: number;
    stage: 'DRAFT' | 'SUBMITTED';
    fields: DraftFields;
    budget: Budget;
    documents: Array<{ id: string; category: string; name: string; contentType: string; sizeBytes: number; sha256: string; uploadedAt: Date; expiresAt: Date | null }>;
    latestSubmission?: Submission | null;
}
export interface PublishedProgramme {
    id: string;
    programmeId: string;
    opensAt: Date;
    closesAt: Date;
    themes: readonly string[];
}
export interface Submission {
    id: string;
    applicationId: string;
    programmeVersionId: string;
    version?: number;
    reference: string;
    revision: number;
    fields: DraftFields;
    budget: Budget;
    documents: Array<{ id: string; category: string; name: string; contentType: string; sizeBytes: number; sha256: string; uploadedAt: Date; expiresAt: Date | null }>;
    submittedAt: Date;
}
export interface ApplicationTransaction {
    // Lock session/user and application rows for writes. Use the database clock.
    now(): Promise<Date>;
    requireSession(principal: Principal): Promise<void>;
    requireProgrammePermission(programmeId: string, permission: string): Promise<void>;
    programme(programmeId: string, versionId: string): Promise<PublishedProgramme | null>;
    applications(): Promise<Application[]>;
    application(id: string): Promise<Application | null>;
    requirements(applicationId: string, ownerId: string): Promise<{ budget: Budget; documents: Application['documents'] }>;
    submission(applicationId: string, versionId: string): Promise<Submission | null>;
    insert(application: Application): Promise<void>;
    save(application: Application): Promise<void>;
    receipt(actorId: string, applicationId: string, key: string): Promise<Submission | null>;
    submit(application: Application, submission: Submission, actorId: string, key: string): Promise<void>;
    // Implement with allowlisted metadata and a durable event/audit insert in this transaction.
    record(actorId: string, applicationId: string, action: string, revision: number): Promise<void>;
}
export interface ApplicationRepository {
    // Roll back all writes on failure, serialize competing commands and enforce receipt uniqueness.
    transaction<T>(work: (tx: ApplicationTransaction) => Promise<T>): Promise<T>;
}
const revisionSchema = z.number().int().nonnegative().max(2147483646);
const idSchema = z.string().uuid();
const keySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
function conflict(): never { throw new HttpError(409, 'REVISION_CONFLICT', 'The application has changed.'); }
function owned(application: Application | null, principal: Principal): Application {
    if (!application || application.ownerId !== principal.userId)
        throw new HttpError(404, 'NOT_FOUND', 'Resource not found.');
    return application;
}
function editable(application: Application, revision: number) {
    if (application.revision !== revision || application.stage !== 'DRAFT')
        conflict();
}
export class ApplicationService {
    constructor(private readonly repository: ApplicationRepository) { }
    async list(principal: Principal): Promise<Application[]> {
        return this.repository.transaction(async (tx) => {
            await tx.requireSession(principal);
            return tx.applications();
        });
    }
    async readSubmission(principal: Principal, applicationId: string, versionId: string): Promise<Submission> {
        idSchema.parse(applicationId);
        idSchema.parse(versionId);
        return this.repository.transaction(async (tx) => {
            await tx.requireSession(principal);
            owned(await tx.application(applicationId), principal);
            const submission = await tx.submission(applicationId, versionId);
            if (!submission)
                throw new HttpError(404, 'NOT_FOUND', 'Resource not found.');
            return submission;
        });
    }
    async create(principal: Principal, programmeId: string, programmeVersionId: string): Promise<Application> {
        idSchema.parse(programmeId);
        idSchema.parse(programmeVersionId);
        return this.repository.transaction(async (tx) => {
            await tx.requireSession(principal);
            if (!await tx.programme(programmeId, programmeVersionId))
                throw new HttpError(404, 'NOT_FOUND', 'Resource not found.');
            const application: Application = { id: randomUUID(), ownerId: principal.userId, programmeId, programmeVersionId,
                revision: 0, stage: 'DRAFT', fields: { title: '', theme: '', problem: '', solution: '', impact: '', team: '' },
                budget: { items: [], fundingRequested: '', notApplicable: false }, documents: [] };
            await tx.insert(application);
            await tx.record(principal.userId, application.id, 'application.created', 0);
            return application;
        });
    }
    async read(principal: Principal, id: string): Promise<Application> {
        idSchema.parse(id);
        return this.repository.transaction(async (tx) => {
            await tx.requireSession(principal);
            return owned(await tx.application(id), principal);
        });
    }
    async update(principal: Principal, id: string, expectedRevision: number, input: unknown, budgetInput?: unknown): Promise<Application> {
        idSchema.parse(id);
        revisionSchema.parse(expectedRevision);
        const fields = draftFields.parse(input);
        const budget = budgetDto.parse(budgetInput ?? { items: [], fundingRequested: '', notApplicable: false });
        return this.repository.transaction(async (tx) => {
            await tx.requireSession(principal);
            const application = owned(await tx.application(id), principal);
            editable(application, expectedRevision);
            const updated = { ...application, fields, budget, revision: application.revision + 1 };
            await tx.save(updated);
            await tx.record(principal.userId, id, 'application.draft_updated', updated.revision);
            return updated;
        });
    }
    async submit(principal: Principal, id: string, expectedRevision: number, key: string): Promise<Submission> {
        idSchema.parse(id);
        revisionSchema.parse(expectedRevision);
        keySchema.parse(key);
        return this.repository.transaction(async (tx) => {
            await tx.requireSession(principal);
            const application = owned(await tx.application(id), principal);
            const previous = await tx.receipt(principal.userId, id, key);
            if (previous) {
                if (previous.revision !== expectedRevision + 1)
                    conflict();
                return previous;
            }
            editable(application, expectedRevision);
            const programme = await tx.programme(application.programmeId, application.programmeVersionId);
            const now = await tx.now();
            if (!programme || now < programme.opensAt || now >= programme.closesAt)
                throw new HttpError(409, 'INTAKE_CLOSED', 'Submission is unavailable.');
            const fields = draftFields.parse(application.fields);
            if (Object.values(fields).some(value => !value) || !programme.themes.includes(fields.theme))
                throw new HttpError(422, 'INVALID_SUBMISSION', 'Complete the required programme fields.');
            const { budget, documents } = await tx.requirements(id, principal.userId);
            if (!documents.some(document => document.category === 'technical-proposal'))
                throw new HttpError(422, 'DOCUMENT_REQUIRED', 'Attach the required technical proposal before submitting.');
            if (!budget.notApplicable && (budget.items.length === 0 || budget.items.some(item => Number(item.amount) <= 0)))
                throw new HttpError(422, 'BUDGET_REQUIRED', 'Complete the budget details or mark funding figures as not applicable.');
            const submission: Submission = { id: randomUUID(), applicationId: id, programmeVersionId: programme.id,
                reference: 'CEDA-' + randomUUID(), revision: application.revision + 1, fields, budget, documents,
                submittedAt: now };
            await tx.submit({ ...application, revision: submission.revision, stage: 'SUBMITTED' }, submission, principal.userId, key);
            await tx.record(principal.userId, id, 'application.submitted', submission.revision);
            return submission;
        });
    }
}
