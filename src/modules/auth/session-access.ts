import type { Prisma } from '../../generated/prisma/client.js';
import type { Principal } from '../../shared/authorization.js';
import { HttpError } from '../../shared/errors.js';

/** Lock in user/session order so suspension and revocation serialize with access. */
export async function requireActiveSession(db: Prisma.TransactionClient, principal: Principal): Promise<void> {
  await db.$queryRaw`SELECT id FROM users WHERE id=${principal.userId}::uuid FOR SHARE`;
  await db.$queryRaw`SELECT id FROM sessions WHERE id=${principal.sessionId}::uuid FOR SHARE`;
  const rows = await db.$queryRaw<Array<{ id: string }>>`SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.id=${principal.sessionId}::uuid AND u.id=${principal.userId}::uuid AND u.status='ACTIVE'
    AND s.revoked_at IS NULL AND s.idle_expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp()`;
  if (rows.length !== 1) throw new HttpError(401, 'UNAUTHENTICATED', 'A valid session is required.');
}

export async function requireProgrammePermission(
  db: Prisma.TransactionClient, principal: Principal, programmeId: string, permission: string,
): Promise<void> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM programme_grants
    WHERE user_id=${principal.userId}::uuid AND programme_id=${programmeId}::uuid
    AND permission=${permission} AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR SHARE`;
  if (rows.length !== 1) throw new HttpError(403, 'FORBIDDEN', 'This action is not permitted.');
}
