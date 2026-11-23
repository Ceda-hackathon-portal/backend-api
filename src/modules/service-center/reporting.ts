import type { Tx } from "./repository.js";

export async function insights(tx: Tx, ids: string[], from: Date, to: Date) {
  const participation = await tx.$queryRaw<
    Array<{ day: string; applications: number; submissions: number }>
  >`

 WITH created AS (
  SELECT to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD') day_key,count(*)::int total
  FROM applications a WHERE a.programme_id=ANY(${ids}::uuid[])
  AND a.created_at>=${from.toISOString()}::timestamptz AND a.created_at<${to.toISOString()}::timestamptz GROUP BY 1
 ), submitted AS (
  SELECT to_char(s.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD') day_key,count(*)::int total
  FROM submission_versions s JOIN applications a ON a.id=s.application_id
  WHERE a.programme_id=ANY(${ids}::uuid[]) AND s.submitted_at>=${from.toISOString()}::timestamptz
  AND s.submitted_at<${to.toISOString()}::timestamptz GROUP BY 1
 ), days AS (
  SELECT to_char(d AT TIME ZONE 'UTC','YYYY-MM-DD') day_key
  FROM generate_series(${from.toISOString()}::timestamptz,${to.toISOString()}::timestamptz-interval '1 day',interval '1 day') d
 ) SELECT days.day_key AS "day",coalesce(c.total,0)::int applications,coalesce(s.total,0)::int submissions
 FROM days LEFT JOIN created c USING(day_key) LEFT JOIN submitted s USING(day_key) ORDER BY days.day_key
`;
  const stages = await tx.$queryRaw<Array<{ stage: string; count: number }>>`
 SELECT coalesce(w.state,a.stage) stage,count(*)::int count FROM applications a LEFT JOIN workflow_state w ON w.application_id=a.id
 WHERE a.programme_id=ANY(${ids}::uuid[]) AND a.created_at>=${from.toISOString()}::timestamptz AND a.created_at<${to.toISOString()}::timestamptz GROUP BY 1 ORDER BY 1`;
  const outcomes = await tx.$queryRaw<
    Array<{ outcome: string; count: number }>
  >`
 SELECT d.outcome,count(*)::int count FROM outcome_releases r JOIN adjudication_decisions d ON d.id=r.decision_id
 JOIN applications a ON a.id=r.application_id WHERE a.programme_id=ANY(${ids}::uuid[]) AND r.created_at>=${from.toISOString()}::timestamptz AND r.created_at<${to.toISOString()}::timestamptz GROUP BY d.outcome`;
  const timing = await tx.$queryRaw<
    Array<{ averageDays: number | null; released: number }>
  >`
 SELECT avg(extract(epoch FROM(r.created_at-s.submitted_at))/86400)::float8 "averageDays",count(*)::int released
 FROM outcome_releases r JOIN submission_versions s ON s.id=r.submission_version_id JOIN applications a ON a.id=r.application_id
 WHERE a.programme_id=ANY(${ids}::uuid[]) AND r.created_at>=${from.toISOString()}::timestamptz AND r.created_at<${to.toISOString()}::timestamptz`;
  const support = await tx.$queryRaw<
    Array<{
      total: number;
      resolved: number;
      averageReplyMinutes: number | null;
      averageResolutionHours: number | null;
    }>
  >`
 SELECT count(*)::int total,count(*) FILTER(WHERE status='RESOLVED')::int resolved,
 avg(extract(epoch FROM(first_reply_at-created_at))/60)::float8 "averageReplyMinutes",
 avg(extract(epoch FROM(resolved_at-created_at))/3600)::float8 "averageResolutionHours"
 FROM support_conversations WHERE programme_id=ANY(${ids}::uuid[]) AND created_at>=${from.toISOString()}::timestamptz AND created_at<${to.toISOString()}::timestamptz`;
  return {
    participation,
    stages,
    outcomes,
    timing: timing[0],
    support: support[0],
    from,
    to,
  };
}
export async function auditRecords(
  tx: Tx,
  ids: string[],
  before: Date,
  action: string,
  offset: number,
) {
  return tx.$queryRaw<
    Array<{
      id: string;
      actor: string;
      action: string;
      target: string;
      createdAt: Date;
    }>
  >`
 WITH events AS (
 SELECT e.id,e.actor_id,e.action,e.application_id target,e.created_at,a.programme_id FROM audit_events e JOIN applications a ON a.id=e.application_id
 UNION ALL SELECT e.id,e.actor_id,'evaluation.'||e.action,e.application_id,e.created_at,a.programme_id FROM evaluation_audits e JOIN applications a ON a.id=e.application_id
 UNION ALL SELECT e.id,e.actor_id,'decision.'||e.action,e.application_id,e.created_at,a.programme_id FROM decision_audits e JOIN applications a ON a.id=e.application_id
 UNION ALL SELECT e.id,e.actor_id,'workflow.'||e.action,e.application_id,e.created_at,a.programme_id FROM workflow_events e JOIN applications a ON a.id=e.application_id

 UNION ALL SELECT e.id,e.requested_by_id,'eligibility.'||e.overall_status,e.application_id,e.created_at,e.programme_id FROM eligibility_checks e
 UNION ALL SELECT e.id,e.reviewer_id,'officer.'||e.outcome,e.application_id,e.created_at,a.programme_id FROM officer_reviews e JOIN applications a ON a.id=e.application_id
 UNION ALL SELECT id,actor_id,action,target_id,created_at,programme_id FROM service_audits
 ) SELECT e.id,u.name actor,e.action,e.target,e.created_at "createdAt" FROM events e JOIN users u ON u.id=e.actor_id
 WHERE e.programme_id=ANY(${ids}::uuid[]) AND e.created_at<=${before.toISOString()}::timestamptz AND e.action ILIKE ${"%" + action + "%"}
 ORDER BY e.created_at DESC,e.id DESC LIMIT 51 OFFSET ${offset}`;
}
