import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import type { Principal } from "../../shared/authorization.js";
import { requireActiveSession } from "../auth/session-access.js";
import { liveGrants, hidden } from "../staff/access.js";
import { HttpError } from "../../shared/errors.js";

export type Tx = Prisma.TransactionClient;
export interface Conversation {
  id: string;
  owner_id: string;
  programme_id: string;
  application_id: string | null;
  subject: string;
  agent_id: string | null;
  status: string;
  name: string;
  email: string;
  updated_at: Date;
  created_at: Date;
  first_reply_at: Date | null;
  unread?: number;
}
export class ServiceRepository {
  constructor(readonly db: PrismaClient) {}
  async run<T>(
    p: Principal,
    work: (tx: Tx, grants: Map<string, Set<string>>) => Promise<T>,
  ): Promise<T> {
    return this.db.$transaction(async (tx) => {
      await requireActiveSession(tx, p);
      return work(tx, await liveGrants(tx, p.userId));
    });
  }
}
export function scopes(
  grants: Map<string, Set<string>>,
  capability: "support" | "report" | "audit",
) {
  const permission = {
    support: "support.manage",
    report: "report.read",
    audit: "audit.read",
  }[capability];
  return [...grants]
    .filter(([, p]) => p.has(permission) || p.has("decision.publish"))
    .map(([id]) => id);
}
export function requireScope(ids: string[]) {
  if (!ids.length)
    throw new HttpError(
      403,
      "FORBIDDEN",
      "This account does not have access to this workspace.",
    );
}
export async function conversation(
  tx: Tx,
  id: string,
  userId: string,
  programmes: string[],
  lock = false,
): Promise<Conversation> {
  // Fetch only after access is proven; an unrelated account cannot discover an identifier.
  if (lock)
    await tx.$queryRaw`SELECT id FROM support_conversations WHERE id=${id}::uuid
   AND (owner_id=${userId}::uuid OR programme_id=ANY(${programmes}::uuid[])) FOR UPDATE`;
  const rows = await tx.$queryRaw<
    Conversation[]
  >`SELECT c.*, u.name,u.email FROM support_conversations c JOIN users u ON u.id=c.owner_id
 WHERE c.id=${id}::uuid AND (c.owner_id=${userId}::uuid OR c.programme_id=ANY(${programmes}::uuid[]))`;
  if (!rows[0]) throw hidden();

  return rows[0];
}
export async function audit(
  tx: Tx,
  userId: string,
  programmeId: string | null,
  targetId: string,
  action: string,
) {
  await tx.$executeRaw`INSERT INTO service_audits(id,actor_id,programme_id,target_id,action)
 VALUES(${randomUUID()}::uuid,${userId}::uuid,${programmeId}::uuid,${targetId}::uuid,${action})`;
}
export async function notices(tx: Tx) {
  // Derive only applicant-safe events: public workflow states and actually released outcomes.
  await tx.$executeRaw`INSERT INTO service_notifications(id,recipient_id,source_key,title,href)
 SELECT gen_random_uuid(),a.owner_id,'workflow:'||e.id,
 'Application status updated: '||replace(e.next_state,'_',' '),'/workspace/ideas/'||a.id
 FROM workflow_events e JOIN applications a ON a.id=e.application_id
 WHERE e.next_state IN ('ELIGIBILITY_SCREENING','OFFICER_VERIFICATION','ASSIGNED','UNDER_EVALUATION','SCORES_LOCKED','ADJUDICATION')
 ON CONFLICT(recipient_id,source_key) DO NOTHING`;
  await tx.$executeRaw`INSERT INTO service_notifications(id,recipient_id,source_key,title,href)
 SELECT gen_random_uuid(),a.owner_id,'submission:'||s.id,'Application submitted','/workspace/ideas/'||a.id
 FROM submission_versions s JOIN applications a ON a.id=s.application_id ON CONFLICT(recipient_id,source_key) DO NOTHING`;
  await tx.$executeRaw`INSERT INTO service_notifications(id,recipient_id,source_key,title,href)
 SELECT gen_random_uuid(),a.owner_id,'outcome:'||r.id,'Your application outcome is available','/workspace/ideas/'||a.id
 FROM outcome_releases r JOIN applications a ON a.id=r.application_id ON CONFLICT(recipient_id,source_key) DO NOTHING`;
}
