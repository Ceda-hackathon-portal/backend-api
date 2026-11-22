import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { HttpError } from './errors.js';

export function validateBody(schema: z.ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) throw new HttpError(422, 'VALIDATION_FAILED', 'Some fields need attention.', result.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code })));
    req.body = result.data;
    next();
  };
}
