import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Principal, SessionVerifier } from '../../shared/authorization.js';
import { HttpError } from '../../shared/errors.js';
import { validateBody } from '../../shared/validation.js';
import { LocalPrivateDocumentStorage } from '../applications/document-storage.js';
import { requireActiveSession } from '../auth/session-access.js';
import { hidden, liveGrants, roleFor } from './access.js';
import { StaffCommands } from './commands.js';
import { applicantProgress, staffApplication, staffApplications, staffDocument } from './queries.js';

const uuid = z.string().uuid();
const reason = z.string().trim().min(1).max(1000);

function param(value: unknown): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw hidden();
  return parsed.data.toLowerCase();
}

/**
 * Mounts /staff (grant holders only), /programmes (public) and /progress (the applicant's own).
 * The evaluation, decision and release commands keep their existing routes.
 */
export function mountStaffRoutes(api: Router, db: PrismaClient, assignmentDb: PrismaClient | null,
  sessions: SessionVerifier, requireCsrf: (request: Request) => void): void {
  api.get('/programmes', async (_req, res) => {
    const now = new Date();
    const versions = await db.programmeVersion.findMany({
      where: { publishedAt: { lte: now }, opensAt: { lte: now }, closesAt: { gt: now } },
      include: { programme: true }, orderBy: { publishedAt: 'desc' },
    });
    // Rule ids are public so the form can send matching evidence. Scoring configuration is not.
    const rules = await db.eligibilityRuleVersion.findMany({
      where: { programmeVersionId: { in: versions.map(row => row.id) }, publishedAt: { lte: now } }, orderBy: { version: 'desc' },
    });
    res.json({ data: versions.map(row => {
      const config = z.object({ themes: z.array(z.string()) }).safeParse(row.config);
      const snapshot = z.object({ requirements: z.array(z.object({ id: z.string() })) })
        .safeParse(rules.find(rule => rule.programmeVersionId === row.id)?.snapshot);
      return {
        programmeId: row.programmeId, programmeVersionId: row.id, name: row.programme.name,
        opensAt: row.opensAt, closesAt: row.closesAt,
        themes: config.success ? config.data.themes : [],
        requirements: snapshot.success ? snapshot.data.requirements.map(item => item.id) : [],
      };
    }) });
  });

  const authenticate = async (req: Request) => {
    const principal = await sessions.verify(req.headers.cookie);
    if (!principal) throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
    if (!['GET', 'HEAD'].includes(req.method)) requireCsrf(req);
    return principal;
  };

  api.get('/progress/:id', async (req, res) => {
    res.json({ data: await applicantProgress(db, await authenticate(req), param(req.params.id)) });
  });

  const router = Router();
  const storage = new LocalPrivateDocumentStorage();
  router.use(async (req, res, next) => {
    const principal = await authenticate(req);
    const grants = await db.$transaction(async tx => {
      await requireActiveSession(tx, principal);
      return liveGrants(tx, principal.userId);
    });
    const role = roleFor(new Set([...grants.values()].flatMap(permissions => [...permissions])));
    // /me answers for any account, so an applicant's sign-in check is not a refusal.
    if (!role && req.path !== '/me') throw new HttpError(403, 'NOT_STAFF', 'This account has no staff access.');
    res.locals.principal = principal;
    res.locals.staffRole = role;
    next();
  });
  const actor = (res: Response) => res.locals.principal as Principal;
  const commands = (res: Response) => new StaffCommands(db, assignmentDb, actor(res), res.locals.requestId as string);

  router.get('/me', (_req, res) => {
    res.json({ data: { role: res.locals.staffRole as string | null } });
  });
  router.get('/applications', async (_req, res) => {
    res.json({ data: await staffApplications(db, actor(res)) });
  });
  router.get('/applications/:id', async (req, res) => {
    res.json({ data: await staffApplication(db, actor(res), param(req.params.id)) });
  });
  router.get('/applications/:id/documents/:documentId', async (req, res) => {
    const document = await staffDocument(db, actor(res), param(req.params.id), param(req.params.documentId));
    const bytes = await storage.get(document.storageKey);
    if (createHash('sha256').update(bytes).digest('hex') !== document.sha256)
      throw new HttpError(500, 'DOCUMENT_INTEGRITY_FAILED', 'The stored document failed its integrity check.');
    res.setHeader('Content-Type', document.contentType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(document.originalName)}`);
    res.send(bytes);
  });
  router.post('/applications/:id/assignments', validateBody(z.strictObject({ userId: uuid })), async (req, res) => {
    res.status(201).json({ data: await commands(res).assign(param(req.params.id), req.body.userId.toLowerCase()) });
  });
  router.post('/applications/:id/assignments/:assignmentId/revoke', validateBody(z.strictObject({ reason })), async (req, res) => {
    res.json({ data: await commands(res).revoke(param(req.params.id), param(req.params.assignmentId), req.body.reason) });
  });
  router.post('/applications/:id/declaration', validateBody(z.strictObject({ hasConflict: z.boolean() })), async (req, res) => {
    res.status(201).json({ data: await commands(res).declare(param(req.params.id), req.body.hasConflict) });
  });
  router.post('/applications/:id/declarations/:disclosureId/confirm', validateBody(z.strictObject({})), async (req, res) => {
    res.json({ data: await commands(res).confirm(param(req.params.id), param(req.params.disclosureId)) });
  });
  router.post('/applications/:id/eligibility', validateBody(z.strictObject({ outcome: z.enum(['ELIGIBLE', 'NOT_ELIGIBLE']), reason })), async (req, res) => {
    res.status(201).json({ data: await commands(res).confirmEligibility(param(req.params.id), req.body.outcome, req.body.reason) });
  });
  router.post('/applications/:id/send-to-review', validateBody(z.strictObject({})), async (req, res) => {
    await commands(res).sendToReview(param(req.params.id));
    res.sendStatus(204);
  });
  router.post('/applications/:id/start-evaluation', validateBody(z.strictObject({})), async (req, res) => {
    await commands(res).startEvaluation(param(req.params.id));
    res.sendStatus(204);
  });
  api.use('/staff', router);
}
