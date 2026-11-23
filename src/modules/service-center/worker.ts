import type { PrismaClient } from "../../generated/prisma/client.js";
import type { ServiceConfig } from "./policy.js";
import { notices } from "./repository.js";

/** One database-backed cycle; provider acceptance is distinct from inbox delivery. */
export async function runServiceCycle(
  db: PrismaClient,
  config: ServiceConfig,
  send: typeof fetch = fetch,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await notices(tx);
  });
  await db.$executeRaw`DELETE FROM support_signals WHERE created_at<now()-interval '1 day'`;
  await db.$executeRaw`UPDATE support_calls SET state='ENDED',ended_at=now() WHERE state='ACCEPTED' AND updated_at<now()-interval '2 hours'`;
  if (!config.EMAIL_API_URL) return;
  const rows = await db.$transaction(
    async (tx) => tx.$queryRaw<
      Array<{
        id: string;
        email: string;
        title: string;
        href: string;
        attempts: number;
      }>
    >`
       UPDATE service_notifications n SET lease_until=now()+interval '45 seconds',attempts=n.attempts+1 FROM
       (SELECT x.id FROM service_notifications x JOIN alert_preferences p ON p.user_id=x.recipient_id
        WHERE p.email AND x.created_at>=p.email_since AND x.email_state IN ('PENDING','RETRY') AND x.next_attempt_at<=now()
        AND (x.lease_until IS NULL OR x.lease_until<now()) ORDER BY x.created_at LIMIT 10 FOR UPDATE OF x SKIP LOCKED) picked,
       users u WHERE n.id=picked.id AND u.id=n.recipient_id RETURNING n.id,u.email,n.title,n.href,n.attempts`,
  );
  for (const row of rows) {
    try {
      const response = await send(config.EMAIL_API_URL, {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.EMAIL_API_KEY}`,
          "Idempotency-Key": row.id,
        },
        body: JSON.stringify({
          from: config.EMAIL_FROM,
          to: [row.email],
          subject: row.title,
          text: `${row.title}\n\nSign in to view details: ${new URL(row.href, config.PUBLIC_PORTAL_URL)}\n\nManage free alerts in your portal settings.`,
        }),
      });
      if (!response.ok) throw new Error("PROVIDER_REFUSED");
      await db.$executeRaw`UPDATE service_notifications SET email_state='SENT',lease_until=NULL,last_error=NULL WHERE id=${row.id}::uuid`;
    } catch {
      await db.$executeRaw`UPDATE service_notifications SET email_state=${row.attempts >= 6 ? "FAILED" : "RETRY"},lease_until=NULL,last_error='DELIVERY_FAILED',next_attempt_at=now()+(${Math.min(3600, 30 * 2 ** row.attempts)}*interval '1 second') WHERE id=${row.id}::uuid`;
    }
  }
}

export function startServiceWorker(
  db: PrismaClient,
  config: ServiceConfig,
  onFailure: () => void,
) {
  let stopped = false,
    inFlight: Promise<void> | null = null;
  function tick() {
    if (stopped || inFlight) return;
    inFlight = runServiceCycle(db, config)
      .catch(onFailure)
      .finally(() => {
        inFlight = null;
      });
  }
  const timer = setInterval(tick, 10000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}
