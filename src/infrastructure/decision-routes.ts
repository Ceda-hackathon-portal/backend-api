import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Principal, SessionVerifier } from '../shared/authorization.js';
import { HttpError } from '../shared/errors.js';
import { validateBody } from '../shared/validation.js';
import { PrismaDecisionRepository } from './decision-repository.js';

const uuid = z.string().uuid();
const expectedRevision = z.number().int().nonnegative().max(2147483646);
const key = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const decision = z.strictObject({ expectedRevision, outcome: z.enum(['APPROVED', 'REJECTED', 'REVISION_REQUESTED']),
  reason: z.string().trim().min(1).max(4000) });
const release = z.strictObject({ expectedRevision, reason: z.string().trim().min(1).max(4000),
  applicantMessage: z.string().trim().min(1).max(4000) });
const workflow = z.strictObject({ expectedRevision });

/** Authenticated decision commands and applicant-safe released outcome retrieval. */
export function mountDecisionRoutes(api: Router, db: PrismaClient, sessions: SessionVerifier,
  requireCsrf: (request: Request) => void): void {
  const router = Router();
  router.use(async (req, res, next) => {
    const principal = await sessions.verify(req.headers.cookie);
    if (!principal) throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
    if (!['GET', 'HEAD'].includes(req.method)) requireCsrf(req);
    res.locals.principal = principal;
    next();
  });
  const repository = (res: Response) => new PrismaDecisionRepository(db, res.locals.principal as Principal,
    res.locals.requestId as string);
  const id = (value: unknown) => {
    const parsed = uuid.safeParse(value);
    if (!parsed.success) throw new HttpError(404, 'NOT_FOUND', 'Resource not found.');
    return parsed.data;
  };
  const idempotency = (req: Request) => {
    const parsed = key.safeParse(req.headers['idempotency-key']);
    if (!parsed.success) throw new HttpError(422, 'VALIDATION_FAILED', 'A valid Idempotency-Key is required.');
    return parsed.data;
  };

  router.post('/applications/:applicationId/workflow/lock-scores', validateBody(workflow), async (req, res) => {
    res.json({ data: await repository(res).lockScores(id(req.params.applicationId), req.body.expectedRevision, idempotency(req)) });
  });
  router.post('/applications/:applicationId/workflow/open-adjudication', validateBody(workflow), async (req, res) => {
    res.json({ data: await repository(res).openAdjudication(id(req.params.applicationId), req.body.expectedRevision, idempotency(req)) });
  });
  router.post('/applications/:applicationId/decisions', validateBody(decision), async (req, res) => {
    res.json({ data: await repository(res).recordDecision(id(req.params.applicationId), req.body, idempotency(req)) });
  });
  router.post('/decisions/:decisionId/publish', validateBody(release), async (req, res) => {
    res.json({ data: await repository(res).releaseDecision(id(req.params.decisionId), req.body, idempotency(req)) });
  });
  router.get('/applications/:applicationId/outcome', async (req, res) => {
    res.json({ data: await repository(res).readApplicantOutcome(id(req.params.applicationId)) });
  });
  api.use(router);
}
