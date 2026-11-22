import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Principal, SessionVerifier } from '../shared/authorization.js';
import { HttpError } from '../shared/errors.js';
import { validateBody } from '../shared/validation.js';
import { PrismaEvaluationRepository } from './evaluation-repository.js';

const uuid = z.string().uuid();
const evaluationCommand = z.strictObject({
  expectedRevision: z.number().int().nonnegative().max(2147483646),
  scores: z.array(z.strictObject({ criterionId: z.string().min(1).max(100), value: z.number().finite(), evidence: z.string().max(4000), comment: z.string().max(4000).optional() })),
  comment: z.string().max(4000),
  recommendation: z.enum(['APPROVE', 'REJECT', 'REVISE']).nullable(),
  finalize: z.boolean(),
});
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** Protected evaluator write route. Auth, CSRF, live grant and assignment checks run on every command. */
export function mountEvaluationRoutes(api: Router, db: PrismaClient, sessions: SessionVerifier,
  requireCsrf: (request: Request) => void): void {
  const router = Router();
  const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    const principal = await sessions.verify(req.headers.cookie);
    if (!principal) throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
    requireCsrf(req);
    res.locals.principal = principal;
    next();
  };
  router.put('/assignments/:assignmentId/evaluation', authenticate, validateBody(evaluationCommand), async (req, res) => {
    const assignmentId = uuid.safeParse(req.params.assignmentId);
    const key = idempotencyKey.safeParse(req.headers['idempotency-key']);
    if (!assignmentId.success || !key.success) throw new HttpError(422, 'VALIDATION_FAILED', 'A valid assignment and Idempotency-Key are required.');
    const repository = new PrismaEvaluationRepository(db, res.locals.principal as Principal, res.locals.requestId as string);
    const evaluation = await repository.write(assignmentId.data, { ...req.body, idempotencyKey: key.data });
    res.json({ data: evaluation });
  });
  api.use(router);
}
