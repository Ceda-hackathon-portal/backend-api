import type { RequestHandler } from 'express';
import { HttpError } from './errors.js';

export interface Principal {
  readonly userId: string;
  readonly sessionId: string;
  readonly authnLevel: string;
}
export interface AccessRequest {
  readonly permission: string;
  readonly programmeId?: string;
  readonly recordId?: string;
}
// Implementations must check live session/grants; no provider or database policy implementation here.
export interface SessionVerifier { verify(cookieHeader: string | undefined): Promise<Principal | null> }
export interface AuthorizationPolicy { allows(principal: Principal, access: AccessRequest): Promise<boolean> }
export const denySessions: SessionVerifier = { async verify() { return null; } };
export const denyPolicy: AuthorizationPolicy = { async allows() { return false; } };

export function requireAccess(access: AccessRequest, sessions: SessionVerifier = denySessions, policy: AuthorizationPolicy = denyPolicy): RequestHandler {
  return async (req, res, next) => {
    const principal = await sessions.verify(req.headers.cookie);
    if (!principal) throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
    if (!await policy.allows(principal, access)) throw new HttpError(403, 'FORBIDDEN', 'This action is not permitted.');
    res.locals.principal = principal;
    next();
  };
}
