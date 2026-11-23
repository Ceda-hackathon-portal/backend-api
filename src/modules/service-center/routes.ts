import { Router, type Request } from "express";
import { randomUUID, createHmac } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Principal, SessionVerifier } from "../../shared/authorization.js";
import { HttpError } from "../../shared/errors.js";
import { validateBody } from "../../shared/validation.js";
import { availability, officeHours, type ServiceConfig } from "./policy.js";
import {
  ServiceRepository,
  scopes,
  requireScope,
  conversation,
  audit,
  notices,
} from "./repository.js";
import { insights, auditRecords } from "./reporting.js";

const uuid = z.string().uuid();
function id(value: unknown) {
  const r = uuid.safeParse(value);
  if (!r.success) throw new HttpError(404, "NOT_FOUND", "Resource not found.");
  return r.data;
}
const forbidden = () =>
  new HttpError(403, "FORBIDDEN", "This action is not permitted.");

export function serviceRoutes(
  db: PrismaClient,
  sessions: SessionVerifier,
  csrf: (req: Request) => void,
  config: ServiceConfig,
  now: () => Date = () => new Date(),
) {
  const router = Router(),
    repo = new ServiceRepository(db);
  router.get("/availability", async (_req, res) => {
    const counts = await db.$queryRaw<
      Array<{ online: number; free: number }>
    >`SELECT count(*)::int online,
     count(*) FILTER(WHERE (SELECT count(*) FROM support_conversations c WHERE c.agent_id=s.user_id AND c.status='OPEN')<s.capacity)::int free
     FROM support_agents s WHERE available AND last_seen_at>now()-interval '45 seconds'
     AND EXISTS(SELECT 1 FROM programme_grants g WHERE g.user_id=s.user_id AND g.permission IN ('support.manage','decision.publish') AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>now()))`;
    res.json({
      data: {
        ...availability(
          officeHours(now(), config.SUPPORT_HOLIDAYS),
          counts[0]?.free ?? 0,
          counts[0]?.online ?? 0,
        ),
        hours: "09:00–16:00 CAT, Monday–Friday",
        callsConfigured: Boolean(config.TURN_URL),
        emailConfigured: Boolean(config.EMAIL_API_URL),
      },
    });
  });
  router.use(async (req, res, next) => {
    const p = await sessions.verify(req.headers.cookie);
    if (!p)
      throw new HttpError(
        401,
        "UNAUTHENTICATED",
        "Sign in to use this service.",
      );
    if (!["GET", "HEAD"].includes(req.method)) csrf(req);
    res.locals.principal = p;
    next();
  });
  const actor = (res: { locals: Record<string, unknown> }) =>
    res.locals.principal as Principal;
  router.get("/capabilities", async (_req, res) =>
    res.json({
      data: await repo.run(actor(res), async (_tx, g) => ({
                  applications:[...g].filter(([,permissions])=>['assignment.manage','eligibility.read-submission','evaluation.write','adjudication.read'].some(permission=>permissions.has(permission))).map(([programmeId])=>programmeId),
support: scopes(g, "support"),
        report: scopes(g, "report"),
        audit: scopes(g, "audit"),
      })),
    }),
  );
  router.get("/programmes", async (_req, res) =>
    res.json({
      data: await repo.run(actor(res), async (tx, g) => {
        const ids = [
          ...new Set([
            ...scopes(g, "support"),
            ...scopes(g, "report"),
            ...scopes(g, "audit"),
          ]),
        ];
        return tx.programme.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true },
        });
      }),
    }),
  );
  router.get("/insights", async (req, res) => {
    const q = z
      .object({
        from: z.iso.date(),
        to: z.iso.date(),
        programmeId: uuid.optional(),
      })
      .safeParse(req.query);
    if (!q.success)
      throw new HttpError(422, "INVALID_FILTER", "Choose valid dates.");
    const from = new Date(q.data.from + "T00:00:00Z"),
      to = new Date(q.data.to + "T00:00:00Z");
    to.setUTCDate(to.getUTCDate() + 1);
    if (to <= from || to.getTime() - from.getTime() > 366 * 86400000)
      throw new HttpError(
        422,
        "INVALID_RANGE",
        "Choose a date range of at most 366 days.",
      );
    res.json({
      data: await repo.run(actor(res), async (tx, g) => {
        const allowed = scopes(g, "report");
        requireScope(allowed);
        const ids = q.data.programmeId ? [q.data.programmeId] : allowed;
        if (ids.some((x) => !allowed.includes(x))) throw forbidden();
        return insights(tx, ids, from, to);
      }),
    });
  });
  router.get("/audit", async (req, res) => {
    const q = z
      .object({
        before: z.iso.datetime().optional(),
        action: z.string().max(100).default(""),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .safeParse(req.query);
    if (!q.success)
      throw new HttpError(422, "INVALID_FILTER", "Check the audit filters.");
    res.json({
      data: await repo.run(actor(res), async (tx, g) => {
        const ids = scopes(g, "audit");
        requireScope(ids);
        const rows = await auditRecords(
          tx,
          ids,
          q.data.before ? new Date(q.data.before) : new Date(),
          q.data.action,
          q.data.offset,
        );
        return { items: rows.slice(0, 50), hasMore: rows.length > 50 };
      }),
    });
  });
  router.post(
    "/agent",
    validateBody(z.strictObject({ available: z.boolean() })),
    async (req, res) => {
      res.json({
        data: await repo.run(actor(res), async (tx, g) => {
          requireScope(scopes(g, "support"));
          await tx.$executeRaw`INSERT INTO support_agents(user_id,available) VALUES(${actor(res).userId}::uuid,${req.body.available})
       ON CONFLICT(user_id) DO UPDATE SET available=excluded.available,last_seen_at=now()`;
          return { available: req.body.available };
        }),
      });
    },
  );
  router.get("/conversations", async (req, res) => {
    const q = z
      .object({
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        status: z.enum(["OPEN", "RESOLVED", "ALL"]).default("ALL"),
        q: z.string().trim().max(160).default(""),
        paged: z.enum(["1"]).optional(),
      })
      .safeParse(req.query);
    if (!q.success)
      throw new HttpError(
        422,
        "INVALID_FILTER",
        "Check the conversation filters.",
      );
    res.json({
      data: await repo.run(actor(res), async (tx, g) => {
        const p = actor(res),
          ids = scopes(g, "support");
        const rows = await tx.$queryRaw<
          Array<Record<string, unknown>>
        >`SELECT c.*,u.name,u.email,
        (SELECT count(*)::int FROM support_messages m WHERE m.conversation_id=c.id AND m.sender_id<>${p.userId}::uuid
        AND (NOT m.internal OR c.programme_id=ANY(${ids}::uuid[]))
        AND m.created_at>coalesce((SELECT read_at FROM support_reads WHERE conversation_id=c.id AND user_id=${p.userId}::uuid),'epoch')) unread
        FROM support_conversations c JOIN users u ON u.id=c.owner_id
        WHERE (c.owner_id=${p.userId}::uuid OR c.programme_id=ANY(${ids}::uuid[]))
        AND (${q.data.status}='ALL' OR c.status=${q.data.status})
        AND (u.name ILIKE ${"%" + q.data.q + "%"} OR c.subject ILIKE ${"%" + q.data.q + "%"})
        ORDER BY c.updated_at DESC,c.id DESC LIMIT 101 OFFSET ${q.data.offset}`;
        return q.data.paged
          ? { items: rows.slice(0, 100), hasMore: rows.length > 100 }
          : rows.slice(0, 100);
      }),
    });
  });
  router.post(
    "/conversations",
    validateBody(
      z.strictObject({
        clientId: uuid,
        programmeId: uuid,
        applicationId: uuid.optional(),
        subject: z.string().trim().min(1).max(160),
      }),
    ),
    async (req, res) => {
      res.status(201).json({
        data: await repo.run(actor(res), async (tx) => {
          const p = actor(res),
            b = req.body;
          const existing = await tx.$queryRaw<
            Array<{ id: string; owner_id: string }>
          >`SELECT id,owner_id FROM support_conversations WHERE id=${b.clientId}::uuid`;
          if (existing[0]) {
            if (existing[0].owner_id !== p.userId) throw forbidden();
            return existing[0];
          }
          if (b.applicationId) {
            const app = await tx.application.findFirst({
              where: {
                id: b.applicationId,
                ownerId: p.userId,
                programmeId: b.programmeId,
              },
            });
            if (!app)
              throw new HttpError(404, "NOT_FOUND", "Application not found.");
          } else if (
            !(await tx.programmeVersion.findFirst({
              where: {
                programmeId: b.programmeId,
                publishedAt: { lte: new Date() },
              },
            }))
          )
            throw new HttpError(404, "NOT_FOUND", "Programme not found.");
          await tx.$executeRaw`INSERT INTO support_conversations(id,owner_id,programme_id,application_id,subject)
       VALUES(${b.clientId}::uuid,${p.userId}::uuid,${b.programmeId}::uuid,${b.applicationId ?? null}::uuid,${b.subject})`;
          await audit(
            tx,
            p.userId,
            b.programmeId,
            b.clientId,
            "support.conversation_opened",
          );
          return { id: b.clientId };
        }),
      });
    },
  );
  router.get("/conversations/:id", async (req, res) =>
    res.json({
      data: await repo.run(actor(res), async (tx, g) => {
        const p = actor(res),
          ids = scopes(g, "support"),
          c = await conversation(tx, id(req.params.id), p.userId, ids);
        // Older pages can be requested without exposing notes to applicants.
        const before = z.iso.datetime().optional().safeParse(req.query.before);
        if (!before.success)
          throw new HttpError(422, "INVALID_CURSOR", "Invalid message cursor.");
        const cursor = uuid.optional().safeParse(req.query.beforeId);
        if (!cursor.success)
          throw new HttpError(422, "INVALID_CURSOR", "Invalid message cursor.");
        const messages = await tx.$queryRaw<
          Array<Record<string, unknown>>
        >`SELECT m.id,m.sender_id,m.body,m.internal,m.created_at,u.name,
          to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') sort_key
          FROM support_messages m JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=${c.id}::uuid
          AND (NOT m.internal OR ${ids.includes(c.programme_id)})
          AND m.created_at<${before.data || "9999-01-01T00:00:00Z"}::timestamptz
          AND (${cursor.data ?? null}::uuid IS NULL OR (m.created_at,m.id)<(
            SELECT created_at,id FROM support_messages WHERE id=${cursor.data ?? null}::uuid
            AND conversation_id=${c.id}::uuid AND (NOT internal OR ${ids.includes(c.programme_id)})))
          ORDER BY m.created_at DESC,m.id DESC LIMIT 201`;
        const calls = await tx.$queryRaw<
          Array<Record<string, unknown>>
        >`SELECT * FROM support_calls WHERE conversation_id=${c.id}::uuid ORDER BY created_at DESC LIMIT 1`;
        return {
          ...c,
          messages: messages.slice(0, 200).reverse(),
          hasMoreMessages: messages.length > 200,
          call: calls[0] ?? null,
          staff: ids.includes(c.programme_id),
        };
      }),
    }),
  );
  router.post(
    "/conversations/:id/read",
    validateBody(z.strictObject({})),
    async (req, res) => {
      await repo.run(actor(res), async (tx, g) => {
        const p = actor(res),
          c = await conversation(
            tx,
            id(req.params.id),
            p.userId,
            scopes(g, "support"),
          );
        await tx.$executeRaw`INSERT INTO support_reads(conversation_id,user_id) VALUES(${c.id}::uuid,${p.userId}::uuid)
       ON CONFLICT(conversation_id,user_id) DO UPDATE SET read_at=now()`;
      });
      res.sendStatus(204);
    },
  );
  router.post(
    "/conversations/:id/messages",
    validateBody(
      z.strictObject({
        clientId: uuid,
        body: z.string().trim().min(1).max(4000),
        internal: z.boolean().default(false),
      }),
    ),
    async (req, res) => {
      res.status(201).json({
        data: await repo.run(actor(res), async (tx, g) => {
          const p = actor(res),
            ids = scopes(g, "support"),
            c = await conversation(tx, id(req.params.id), p.userId, ids, true),
            staff = ids.includes(c.programme_id);
          const b = req.body;
          if (
            staff &&
            !b.internal &&
            !officeHours(now(), config.SUPPORT_HOLIDAYS)
          )
            throw new HttpError(
              409,
              "OUTSIDE_HOURS",
              "Live replies are available Monday–Friday, 09:00–16:00 CAT.",
            );
          if (b.internal && !staff) throw forbidden();
          if (staff && c.agent_id !== p.userId)
            throw new HttpError(
              409,
              "CLAIM_REQUIRED",
              "Assign this conversation to yourself before replying.",
            );
          const existing = await tx.$queryRaw<
            Array<{ id: string; body: string; internal: boolean }>
          >`SELECT id,body,internal FROM support_messages WHERE conversation_id=${c.id}::uuid AND sender_id=${p.userId}::uuid AND client_id=${b.clientId}::uuid`;
          if (existing[0]) {
            if (
              existing[0].body !== b.body ||
              existing[0].internal !== b.internal
            )
              throw new HttpError(
                409,
                "KEY_REUSED",
                "This send identifier was already used for another message.",
              );
            return { id: existing[0].id };
          }
          if (c.status !== "OPEN")
            throw new HttpError(
              409,
              "CHAT_CLOSED",
              "Reopen the conversation before sending.",
            );
          const messageId = randomUUID();
          await tx.$executeRaw`INSERT INTO support_messages(id,conversation_id,sender_id,client_id,body,internal)
       VALUES(${messageId}::uuid,${c.id}::uuid,${p.userId}::uuid,${b.clientId}::uuid,${b.body},${b.internal})`;
          await tx.$executeRaw`UPDATE support_conversations SET updated_at=now(),first_reply_at=CASE WHEN ${staff && !b.internal} THEN coalesce(first_reply_at,now()) ELSE first_reply_at END WHERE id=${c.id}::uuid`;
          await audit(
            tx,
            p.userId,
            c.programme_id,
            c.id,
            b.internal ? "support.note_added" : "support.message_sent",
          );
          return { id: messageId };
        }),
      });
    },
  );
  router.post(
    "/conversations/:id/claim",
    validateBody(z.strictObject({reason:z.string().trim().min(3).max(1000).optional()})),
    async (req, res) => {
      await repo.run(actor(res), async (tx, g) => {
        const p = actor(res),
          ids = scopes(g, "support");
        requireScope(ids);
        // Agent lock also serializes claims across different conversations against capacity.
        await tx.$queryRaw`SELECT user_id FROM support_agents WHERE user_id=${p.userId}::uuid FOR UPDATE`;
        const c = await conversation(
          tx,
          id(req.params.id),
          p.userId,
          ids,
          true,
        );
        if (c.owner_id === p.userId) throw forbidden();
        const takeover=Boolean(c.agent_id&&c.agent_id!==p.userId);
        if(takeover){
          const online=await tx.$queryRaw<Array<{user_id:string}>>`SELECT user_id FROM support_agents WHERE user_id=${c.agent_id}::uuid AND available AND last_seen_at>now()-interval '45 seconds'`;
          if(online.length)throw new HttpError(409,'ALREADY_ASSIGNED','The assigned consultant is online. Ask them to go offline before a handoff.');
          if(!req.body.reason)throw new HttpError(409,'HANDOFF_REASON_REQUIRED','Give a reason before taking over an offline consultant’s conversation.');
        }
        if (!officeHours(now(), config.SUPPORT_HOLIDAYS))
          throw new HttpError(
            409,
            "OUTSIDE_HOURS",
            "Live support is closed. You can review the queue during the next working period.",
          );
        const agents = await tx.$queryRaw<
          Array<{ capacity: number }>
        >`SELECT capacity FROM support_agents WHERE user_id=${p.userId}::uuid AND available AND last_seen_at>now()-interval '45 seconds'`;
        if (!agents[0])
          throw new HttpError(
            409,
            "AGENT_OFFLINE",
            "Set yourself available before taking a conversation.",
          );
        const active = await tx.$queryRaw<
          Array<{ count: number }>
        >`SELECT count(*)::int count FROM support_conversations WHERE agent_id=${p.userId}::uuid AND status='OPEN' AND id<>${c.id}::uuid`;
        if ((active[0]?.count ?? 0) >= agents[0].capacity)
          throw new HttpError(
            409,
            "CAPACITY_REACHED",
            "Resolve an existing conversation before taking another.",
          );
        await tx.$executeRaw`UPDATE support_conversations SET agent_id=${p.userId}::uuid,status='OPEN',resolved_at=NULL,updated_at=now() WHERE id=${c.id}::uuid`;
        if(takeover){
          await tx.$executeRaw`UPDATE support_calls SET state='ENDED',ended_at=now() WHERE conversation_id=${c.id}::uuid AND state IN ('RINGING','ACCEPTED')`;
          await tx.$executeRaw`INSERT INTO support_messages(id,conversation_id,sender_id,client_id,body,internal) VALUES(${randomUUID()}::uuid,${c.id}::uuid,${p.userId}::uuid,${randomUUID()}::uuid,${'Handoff from an offline consultant: '+req.body.reason},true)`;
        }
        await audit(tx,p.userId,c.programme_id,c.id,takeover?'support.reassigned':'support.claimed');
      });
      res.sendStatus(204);
    },
  );
  router.post(
    "/conversations/:id/status",
    validateBody(z.strictObject({ status: z.enum(["OPEN", "RESOLVED"]) })),
    async (req, res) => {
      await repo.run(actor(res), async (tx, g) => {
        const p = actor(res),
          ids = scopes(g, "support"),
          c = await conversation(tx, id(req.params.id), p.userId, ids, true);
        if (ids.includes(c.programme_id) && c.agent_id !== p.userId)
          throw forbidden();
        if (c.owner_id === p.userId && req.body.status === "RESOLVED")
          throw forbidden();
        await tx.$executeRaw`UPDATE support_conversations SET status=${req.body.status},resolved_at=CASE WHEN ${req.body.status}='RESOLVED' THEN now() ELSE NULL END,updated_at=now() WHERE id=${c.id}::uuid`;
        await audit(
          tx,
          p.userId,
          c.programme_id,
          c.id,
          "support." +
            (req.body.status === "RESOLVED" ? "resolved" : "reopened"),
        );
      });
      res.sendStatus(204);
    },
  );
  router.post(
    "/conversations/:id/calls",
    validateBody(z.strictObject({ clientId: uuid })),
    async (req, res) => {
      res.status(201).json({
        data: await repo.run(actor(res), async (tx, g) => {
          const p = actor(res),
            c = await conversation(
              tx,
              id(req.params.id),
              p.userId,
              scopes(g, "support"),
              true,
            );
          if (
            !c.agent_id ||
            c.status !== "OPEN" ||
            ![c.owner_id, c.agent_id].includes(p.userId)
          )
            throw forbidden();
          if (!officeHours(now(), config.SUPPORT_HOLIDAYS))
            throw new HttpError(
              409,
              "OUTSIDE_HOURS",
              "Calls are available during consultant working hours.",
            );
          await tx.$executeRaw`UPDATE support_calls SET state='MISSED',ended_at=now() WHERE conversation_id=${c.id}::uuid AND state='RINGING' AND created_at<now()-interval '60 seconds'`;
          const existing = await tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT id FROM support_calls WHERE conversation_id=${c.id}::uuid AND state IN ('RINGING','ACCEPTED')`;
          if (existing[0]) {
            if (existing[0].id === req.body.clientId) return existing[0];
            throw new HttpError(
              409,
              "CALL_BUSY",
              "A call is already in progress.",
            );
          }
          const callId = req.body.clientId;
          await tx.$executeRaw`INSERT INTO support_calls(id,conversation_id,caller_id,callee_id,state) VALUES(${callId}::uuid,${c.id}::uuid,${p.userId}::uuid,${p.userId === c.owner_id ? c.agent_id : c.owner_id}::uuid,'RINGING')`;
          await audit(
            tx,
            p.userId,
            c.programme_id,
            callId,
            "support.call_started",
          );
          return { id: callId };
        }),
      });
    },
  );

  router.get("/calls/incoming", async (_req, res) =>
    res.json({
      data: await repo.run(actor(res), async (tx, g) => {
        const p = actor(res),
          ids = scopes(g, "support");
        return tx.$queryRaw`SELECT x.id,x.conversation_id,u.name caller,c.subject FROM support_calls x
      JOIN support_conversations c ON c.id=x.conversation_id JOIN users u ON u.id=x.caller_id
      WHERE x.callee_id=${p.userId}::uuid AND x.state='RINGING' AND x.created_at>now()-interval '60 seconds'
      AND (c.owner_id=${p.userId}::uuid OR c.programme_id=ANY(${ids}::uuid[])) ORDER BY x.created_at DESC LIMIT 1`;
      }),
    }),
  );
  router.get("/calls/:id", async (req, res) =>
    res.json({
      data: await repo.run(actor(res), async (tx, g) => {
        const p = actor(res),
          calls = await tx.$queryRaw<
            Array<{
              id: string;
              conversation_id: string;
              caller_id: string;
              callee_id: string;
              state: string;
            }>
          >`SELECT * FROM support_calls WHERE id=${id(req.params.id)}::uuid AND ${p.userId}::uuid IN(caller_id,callee_id)`;
        const call = calls[0];
        if (!call) throw new HttpError(404, "NOT_FOUND", "Call not found.");
        await conversation(
          tx,
          call.conversation_id,
          p.userId,
          scopes(g, "support"),
        );
        const after = z.coerce
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .safeParse(req.query.after ?? 0);
        if (!after.success)
          throw new HttpError(422, "INVALID_CURSOR", "Invalid call cursor.");
        await tx.$executeRaw`UPDATE support_calls SET state='MISSED',ended_at=now() WHERE id=${call.id}::uuid AND state='RINGING' AND created_at<now()-interval '60 seconds'`;

        await tx.$executeRaw`UPDATE support_calls SET caller_seen_at=CASE WHEN caller_id=${p.userId}::uuid THEN now() ELSE caller_seen_at END,
        callee_seen_at=CASE WHEN callee_id=${p.userId}::uuid THEN now() ELSE callee_seen_at END WHERE id=${call.id}::uuid`;
        await tx.$executeRaw`UPDATE support_calls SET state='ENDED',ended_at=now() WHERE id=${call.id}::uuid AND state='ACCEPTED'
        AND (caller_seen_at<now()-interval '60 seconds' OR callee_seen_at<now()-interval '60 seconds')`;
        const fresh = await tx.$queryRaw<
          Array<{ state: string }>
        >`SELECT state FROM support_calls WHERE id=${call.id}::uuid`;
        const signals =
          await tx.$queryRaw`SELECT sequence::float8 sequence,kind,payload FROM support_signals WHERE call_id=${call.id}::uuid AND sender_id<>${p.userId}::uuid AND sequence>${after.data} ORDER BY sequence LIMIT 200`;
        let iceServers: Array<Record<string, unknown>> = [];
        if (config.TURN_URL && config.TURN_SECRET) {
          const username = `${Math.floor(Date.now() / 1000) + 3600}:${p.userId}`;
          iceServers = [
            {
              urls: config.TURN_URL,
              username,
              credential: createHmac("sha1", config.TURN_SECRET)
                .update(username)
                .digest("base64"),
            },
          ];
        }
        return { ...call, state: fresh[0]?.state, signals, iceServers };
      }),
    }),
  );
  router.post(
    "/calls/:id/state",
    validateBody(
      z.strictObject({ state: z.enum(["ACCEPTED", "DECLINED", "ENDED"]) }),
    ),
    async (req, res) => {
      await repo.run(actor(res), async (tx, g) => {
        const p = actor(res),
          rows = await tx.$queryRaw<
            Array<{
              conversation_id: string;
              caller_id: string;
              callee_id: string;
              state: string;
            }>
          >`SELECT * FROM support_calls WHERE id=${id(req.params.id)}::uuid AND ${p.userId}::uuid IN(caller_id,callee_id) FOR UPDATE`;
        const call = rows[0];
        if (!call) throw new HttpError(404, "NOT_FOUND", "Call not found.");
        const c = await conversation(
          tx,
          call.conversation_id,
          p.userId,
          scopes(g, "support"),
        );
        if (
          req.body.state !== "ENDED" &&
          (p.userId !== call.callee_id || call.state !== "RINGING")
        )
          throw forbidden();
        const live = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM support_calls WHERE id=${id(req.params.id)}::uuid AND (state='ACCEPTED' OR (state='RINGING' AND created_at>now()-interval '60 seconds'))`;
        if (req.body.state !== "ENDED" && !live.length)
          throw new HttpError(
            409,
            "CALL_EXPIRED",
            "The call invitation has expired.",
          );
        await tx.$executeRaw`UPDATE support_calls SET state=${req.body.state},updated_at=now(),caller_seen_at=CASE WHEN ${req.body.state}='ACCEPTED' THEN now() ELSE caller_seen_at END,callee_seen_at=CASE WHEN ${req.body.state}='ACCEPTED' THEN now() ELSE callee_seen_at END,ended_at=CASE WHEN ${req.body.state}='ACCEPTED' THEN NULL ELSE now() END WHERE id=${id(req.params.id)}::uuid`;
        await audit(
          tx,
          p.userId,
          c.programme_id,
          id(req.params.id),
          "support.call_" + req.body.state.toLowerCase(),
        );
      });
      res.sendStatus(204);
    },
  );
  router.post(
    "/calls/:id/signals",
    validateBody(
      z.strictObject({
        clientId: uuid,
        kind: z.enum(["offer", "answer", "candidate"]),
        payload: z.record(z.string(), z.unknown()),
      }),
    ),
    async (req, res) => {
      if (JSON.stringify(req.body.payload).length > 16000)
        throw new HttpError(
          422,
          "SIGNAL_TOO_LARGE",
          "Call signal is too large.",
        );
      await repo.run(actor(res), async (tx, g) => {
        const p = actor(res),
          rows = await tx.$queryRaw<
            Array<{
              conversation_id: string;
              caller_id: string;
              callee_id: string;
            }>
          >`SELECT * FROM support_calls WHERE id=${id(req.params.id)}::uuid AND state='ACCEPTED' AND ${p.userId}::uuid IN(caller_id,callee_id)`;
        const call = rows[0];
        if (!call)
          throw new HttpError(404, "NOT_FOUND", "Active call not found.");
        await conversation(
          tx,
          call.conversation_id,
          p.userId,
          scopes(g, "support"),
        );
        if (
          (req.body.kind === "offer" && p.userId !== call.caller_id) ||
          (req.body.kind === "answer" && p.userId !== call.callee_id)
        )
          throw forbidden();
        await tx.$executeRaw`INSERT INTO support_signals(call_id,sender_id,client_id,kind,payload) VALUES(${id(req.params.id)}::uuid,${p.userId}::uuid,${req.body.clientId}::uuid,${req.body.kind},${JSON.stringify(req.body.payload)}::jsonb) ON CONFLICT(call_id,sender_id,client_id) DO NOTHING`;
      });
      res.sendStatus(204);
    },
  );
  router.get("/preferences", async (_req, res) =>
    res.json({
      data: await repo.run(actor(res), async (tx) => {
        const rows = await tx.$queryRaw<
          Array<Record<string, unknown>>
        >`SELECT * FROM alert_preferences WHERE user_id=${actor(res).userId}::uuid`;
        return rows[0] ?? { in_app: true, email: false, consent_version: null };
      }),
    }),
  );
  router.put(
    "/preferences",
    validateBody(
      z.strictObject({
        inApp: z.boolean(),
        email: z.boolean(),
        consent: z.boolean(),
      }),
    ),
    async (req, res) => {
      await repo.run(actor(res), async (tx) => {
        if ((req.body.inApp || req.body.email) && !req.body.consent)
          throw new HttpError(
            422,
            "CONSENT_REQUIRED",
            "Review and accept the privacy notice before saving.",
          );
        const p = actor(res),
          b = req.body;
        if (b.email && !config.EMAIL_API_URL)
          throw new HttpError(
            503,
            "EMAIL_NOT_CONFIGURED",
            "Email delivery is not configured. In-app alerts are available at no charge.",
          );
        await tx.$executeRaw`INSERT INTO alert_preferences(user_id,in_app,email,email_since,contact_consent_version,contact_consent_at) VALUES(${p.userId}::uuid,${b.inApp},${b.email},CASE WHEN ${b.email} THEN now() ELSE NULL END,CASE WHEN ${b.consent} THEN '2026-11-23' ELSE NULL END,CASE WHEN ${b.consent} THEN now() ELSE NULL END) ON CONFLICT(user_id) DO UPDATE SET in_app=excluded.in_app,email=excluded.email,email_since=CASE WHEN excluded.email AND NOT alert_preferences.email THEN now() WHEN NOT excluded.email THEN NULL ELSE alert_preferences.email_since END,contact_consent_version=excluded.contact_consent_version,contact_consent_at=excluded.contact_consent_at,updated_at=now()`;
        await audit(
          tx,
          p.userId,
          null,
          p.userId,
          "privacy.preferences_updated",
        );
      });
      res.sendStatus(204);
    },
  );
  router.get("/notifications", async (_req, res) =>
    res.json({
      data: await repo.run(actor(res), async (tx) => {
        return tx.$queryRaw`SELECT n.id,n.title,n.href,n.created_at,n.read_at,n.email_state FROM service_notifications n
     LEFT JOIN alert_preferences p ON p.user_id=n.recipient_id WHERE n.recipient_id=${actor(res).userId}::uuid AND coalesce(p.in_app,true) ORDER BY n.created_at DESC LIMIT 100`;
      }),
    }),
  );
  router.post(
    "/notifications/:id/read",
    validateBody(z.strictObject({})),
    async (req, res) => {
      await repo.run(actor(res), async (tx) => {
        await tx.$executeRaw`UPDATE service_notifications SET read_at=coalesce(read_at,now()) WHERE id=${id(req.params.id)}::uuid AND recipient_id=${actor(res).userId}::uuid`;
      });
      res.sendStatus(204);
    },
  );

  router.post(
    "/privacy/consent",
    validateBody(
      z.strictObject({
        version: z.literal("2026-11-23"),
        accepted: z.literal(true),
      }),
    ),
    async (_req, res) => {
      await repo.run(actor(res), async (tx) => {
        const p = actor(res);
        await tx.$executeRaw`INSERT INTO alert_preferences(user_id,consent_version,consent_at) VALUES(${p.userId}::uuid,'2026-11-23',now())
       ON CONFLICT(user_id) DO UPDATE SET consent_version=excluded.consent_version,consent_at=now(),updated_at=now()`;
        await audit(
          tx,
          p.userId,
          null,
          p.userId,
          "privacy.application_consent_recorded",
        );
      });
      res.sendStatus(204);
    },
  );
  router.get("/privacy/export", async (_req, res) => {
    const result = await repo.run(actor(res), async (tx) => {
      const p = actor(res);
      const account = await tx.authUser.findUnique({
        where: { id: p.userId },
        select: { id: true, name: true, email: true },
      });
      const applications = await tx.application.findMany({
        where: { ownerId: p.userId },
        select: {
          id: true,
          stage: true,
          draft: true,
          budget: true,
          createdAt: true,
          updatedAt: true,
          documents: {
            select: {
              id: true,
              originalName: true,
              category: true,
              contentType: true,
              sizeBytes: true,
              uploadedAt: true,
            },
          },
          submissions: {
            select: {
              reference: true,
              version: true,
              fields: true,
              budget: true,
              submittedAt: true,
            },
          },
          outcomeRelease: {
            select: { outcome: true, applicantMessage: true, createdAt: true },
          },
        },
      });
      const conversations =
        await tx.$queryRaw`SELECT c.id,c.subject,c.status,c.created_at,m.body,m.created_at sent_at
       FROM support_conversations c LEFT JOIN support_messages m ON m.conversation_id=c.id AND NOT m.internal
       WHERE c.owner_id=${p.userId}::uuid ORDER BY c.created_at,m.created_at`;
      const preferences =
        await tx.$queryRaw`SELECT in_app,email,consent_version,consent_at,contact_consent_version,contact_consent_at FROM alert_preferences WHERE user_id=${p.userId}::uuid`;
      await audit(tx, p.userId, null, p.userId, "privacy.data_exported");
      await tx.$executeRaw`UPDATE privacy_requests SET status='COMPLETED',completed_at=now(),reason='Account holder downloaded their data copy.' WHERE user_id=${p.userId}::uuid AND kind='EXPORT' AND status='PENDING'`;
      return {
        generatedAt: new Date().toISOString(),
        account,
        applications,
        conversations,
        preferences,
      };
    });
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="ceda-account-data.json"',
    );
    res.json({ data: result });
  });
  router.get("/privacy/requests", async (_req, res) =>
    res.json({
      data: await repo.run(
        actor(res),
        async (tx) =>
          tx.$queryRaw`SELECT id,kind,status,created_at,completed_at,reason FROM privacy_requests WHERE user_id=${actor(res).userId}::uuid ORDER BY created_at DESC LIMIT 50`,
      ),
    }),
  );
  router.post(
    "/privacy/requests",
    validateBody(z.strictObject({ kind: z.enum(["EXPORT", "DELETE"]) })),
    async (req, res) => {
      res.status(201).json({
        data: await repo.run(actor(res), async (tx) => {
          const p = actor(res),
            requestId = randomUUID();
          const rows =
            await tx.$queryRaw`INSERT INTO privacy_requests(id,user_id,kind) VALUES(${requestId}::uuid,${p.userId}::uuid,${req.body.kind}) ON CONFLICT(user_id,kind) WHERE status='PENDING' DO UPDATE SET kind=excluded.kind RETURNING id,status`;
          await audit(
            tx,
            p.userId,
            null,
            p.userId,
            "privacy." + req.body.kind.toLowerCase() + "_requested",
          );
          return rows;
        }),
      });
    },
  );
  return router;
}
