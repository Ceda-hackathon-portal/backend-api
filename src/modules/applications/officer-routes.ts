import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../../config/env.js';
import type { SessionVerifier } from '../../shared/authorization.js';
import { HttpError } from '../../shared/errors.js';
import type { OfficerSubmissionReader } from './officer-submission-reader.js';
import { draftFields } from './service.js';

const uuid = z.string().uuid();
export const officerSubmissionDto = z.strictObject({
  submissionVersionId: uuid, applicationId: uuid, programmeId: uuid, programmeVersionId: uuid,
  submissionVersionNumber: z.literal(1), reference: z.string().max(64), submittedAt: z.iso.datetime(),
  submissionFields: draftFields.pick({ title: true, theme: true, problem: true, solution: true, impact: true }),
});

/** Called only inside the authenticated server composition. No provisioning client belongs here. */
export function mountOfficerSubmissionRoutes(api: Router, config: Pick<Config, 'OFFICER_READ_API_ENABLED'>,
  sessions: SessionVerifier, reader: OfficerSubmissionReader): void {
  if (!config.OFFICER_READ_API_ENABLED) return;
  const router = Router();
  router.get('/submissions/:submissionVersionId', async (req, res) => {
    const principal = await sessions.verify(req.headers.cookie);
    if (!principal) throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
    const id = uuid.safeParse(req.params.submissionVersionId);
    if (!id.success) throw new HttpError(422, 'VALIDATION_FAILED', 'A valid submission identifier is required.');
    const result = await reader.readForOfficer({ principal, requestId: res.locals.requestId as string }, id.data.toLowerCase());
    res.json({ data: officerSubmissionDto.parse(result) });
  });
  api.use('/officer', router);
}
