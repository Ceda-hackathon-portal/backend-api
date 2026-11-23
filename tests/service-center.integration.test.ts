import { runServiceCycle } from "../src/modules/service-center/worker.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Router } from "express";
import { pino } from "pino";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { authRoutes } from "../src/modules/auth/routes.js";
import { PrismaSessionStore } from "../src/modules/auth/store.js";
import { hash, token, csrf } from "../src/modules/auth/crypto.js";
import { serviceRoutes } from "../src/modules/service-center/routes.js";
import {
  serviceConfigSchema,
  officeHours,
  availability,
} from "../src/modules/service-center/policy.js";
import { applicationRoutes } from "../src/modules/applications/routes.js";
import { ApplicationService } from "../src/modules/applications/service.js";
import { PrismaApplicationRepository } from "../src/modules/applications/repository.js";
import { insights } from "../src/modules/service-center/reporting.js";
import { notices } from "../src/modules/service-center/repository.js";

test("CAT office hours, holidays and busy/offline states", () => {
  assert.equal(officeHours(new Date("2026-11-23T06:59:00Z")), false);
  assert.equal(officeHours(new Date("2026-11-23T07:00:00Z")), true);
  assert.equal(officeHours(new Date("2026-11-23T13:59:00Z")), true);
  assert.equal(officeHours(new Date("2026-11-23T14:00:00Z")), false);
  assert.equal(officeHours(new Date("2026-11-22T09:00:00Z")), false);
  assert.equal(
    officeHours(new Date("2026-11-23T09:00:00Z"), ["2026-11-23"]),
    false,
  );
  assert.equal(availability(true, 0, 2).code, "BUSY");
  assert.equal(availability(true, 0, 0).code, "OFFLINE");
  assert.equal(availability(false, 2, 2).code, "CLOSED");
  assert.equal(availability(true, 1, 2).code, "AVAILABLE");
});

test(
  "real PostgreSQL + HTTP: chat isolation, duplicate sends, claims, notes, calls, reports, audit, alerts, consent and revocation",
  { timeout: 60000 },
  async () => {
    assert.match(process.env.DISPOSABLE_DATABASE_RUN ?? "", /^[a-f0-9-]{36}$/);
    const url = process.env.DATABASE_URL!;
    assert.equal(new URL(url).hostname, "127.0.0.1");
    const owner = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: url,
        options: "-c timezone=UTC",
        max: 6,
      }),
    });
    const admin = new Client({ connectionString: url });
    await admin.connect();
    let runtime: PrismaClient | undefined;
    try {
      await admin.query(readFileSync("ops/service-center-role.sql", "utf8"));
      const role = "service_" + randomUUID().replaceAll("-", "");
      await admin.query(`CREATE ROLE ${role} LOGIN IN ROLE ceda_runtime`);
      const runtimeUrl = new URL(url);
      runtimeUrl.username = role;
      runtime = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: runtimeUrl.href,
          options: "-c timezone=UTC",
          max: 6,
        }),
      });
      const db = runtime,
        store = new PrismaSessionStore(db),
        key = randomBytes(32).toString("hex");
      async function person(name: string) {
        const raw = token();
        await store.create(
          {
            issuer: "https://identity.example.test",
            subject: randomUUID(),
            email: randomUUID() + "@example.test",
            name,
          },
          hash(raw),
          null,
          1800,
          28800,
        );
        const session = await store.find(hash(raw), 1800);
        assert.ok(session);
        return { raw, userId: session.userId, sessionId: session.id };
      }
      const applicant = await person("Applicant A"),
        other = await person("Applicant B"),
        agent = await person("Consultant"),
        second = await person("Second consultant"),
        outsider = await person("Other programme consultant");
      const programme = await owner.programme.create({
        data: { code: randomUUID(), name: "Service test programme" },
      });
      const otherProgramme = await owner.programme.create({
        data: { code: randomUUID(), name: "Other programme" },
      });
      const pv = await owner.programmeVersion.create({
        data: {
          programmeId: programme.id,
          version: 1,
          publishedAt: new Date(Date.now() - 1000),
          opensAt: new Date(Date.now() - 1000),
          closesAt: new Date(Date.now() + 86400000),
          config: { themes: ["digital"] },
        },
      });
      for (const [person, pid] of [
        [agent, programme.id],
        [second, programme.id],
        [outsider, otherProgramme.id],
      ] as const) {
        for (const permission of [
          "support.manage",
          "report.read",
          "audit.read",
        ])
          await owner.programmeGrant.create({
            data: {
              userId: person.userId,
              programmeId: pid,
              permission,
              grantedById: agent.userId,
            },
          });
      }
      const principal = {
        userId: applicant.userId,
        sessionId: applicant.sessionId,
        authnLevel: "password",
      };
      const app = await new ApplicationService(
        new PrismaApplicationRepository(db, principal, randomUUID()),
      ).create(principal, programme.id, pv.id);
      const api = Router(),
        auth = authRoutes(
          {
            mode: "cognito",
            issuer: "https://identity.example.test",
            clientId: "fixture",
            apiOrigin: "http://localhost:3001",
            frontendOrigin: "http://localhost:5174",
            key,
            secure: false,
            idleSeconds: 1800,
            absoluteSeconds: 28800,
          },
          store,
        );
      api.use("/auth", auth.router);
      api.use(
        "/applications",
        applicationRoutes(db, auth.verifier, auth.requireCsrf, {
          requirePrivacyConsent: true,
        }),
      );
      let clock = new Date("2026-11-23T09:00:00Z");
      api.use(
        "/service",
        serviceRoutes(
          db,
          auth.verifier,
          auth.requireCsrf,
          serviceConfigSchema.parse({}),
          () => clock,
        ),
      );
      const server = createServer(
        createApp(
          loadConfig({
            DATABASE_URL: runtimeUrl.href,
            NODE_ENV: "test",
            ALLOWED_ORIGINS: "http://localhost:5174",
            DATABASE_STATEMENT_TIMEOUT_MS: "10000",
            DATABASE_LOCK_TIMEOUT_MS: "5000",
          }),
          {
            database: { async check() {}, async close() {} },
            logger: pino({ level: "silent" }),
            apiRouter: api,
          },
        ),
      );
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/service`;
      async function req(
        who: typeof applicant,
        path: string,
        method = "GET",
        body?: unknown,
        expected = 200,
      ) {
        const response = await fetch(
          (path.startsWith("/applications")
            ? base.replace(/\/service$/, "")
            : base) + path,
          {
            method,
            headers: {
              Cookie: "dev_ceda_session=" + who.raw,
              Origin: "http://localhost:5174",
              "Content-Type": "application/json",
              "X-CSRF-Token": csrf(key, who.raw),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        );
        const result =
          response.status === 204
            ? null
            : ((await response.json()) as { data?: any; error?: unknown });
        assert.equal(
          response.status,
          expected,
          `${method} ${path}: ${JSON.stringify(result)}`,
        );
        return result?.data ?? result?.error;
      }
      try {
        assert.deepEqual((await req(agent,"/capabilities")).applications,[]);
      const cid = randomUUID();
        await req(
          applicant,
          "/conversations",
          "POST",
          {
            clientId: cid,
            programmeId: programme.id,
            applicationId: app.id,
            subject: "Document help",
          },
          201,
        );
        await req(other, `/conversations/${cid}`, "GET", undefined, 404);
        await req(outsider, `/conversations/${cid}`, "GET", undefined, 404);
        await req(
          other,
          "/conversations",
          "POST",
          {
            clientId: randomUUID(),
            programmeId: programme.id,
            applicationId: app.id,
            subject: "Unowned",
          },
          404,
        );
        const messageId = randomUUID(),
          body = { clientId: messageId, body: "Please help me upload." };
        const first = await req(
          applicant,
          `/conversations/${cid}/messages`,
          "POST",
          body,
          201,
        );
        const retry = await req(
          applicant,
          `/conversations/${cid}/messages`,
          "POST",
          body,
          201,
        );
        assert.equal(first.id, retry.id);
        await req(
          applicant,
          `/conversations/${cid}/messages`,
          "POST",
          { ...body, body: "Different" },
          409,
        );
        await req(
          applicant,
          `/conversations/${cid}/messages`,
          "POST",
          { clientId: randomUUID(), body: "Secret", internal: true },
          403,
        );
        await req(agent, "/agent", "POST", { available: true });
        await req(second, "/agent", "POST", { available: true });
        await req(agent, `/conversations/${cid}/claim`, "POST", {}, 204);
        await req(second, `/conversations/${cid}/claim`, "POST", {}, 409);
        await req(
          agent,
          `/conversations/${cid}/messages`,
          "POST",
          { clientId: randomUUID(), body: "Use the Documents step." },
          201,
        );
        await req(
          agent,
          `/conversations/${cid}/messages`,
          "POST",
          { clientId: randomUUID(), body: "Private note", internal: true },
          201,
        );
        const applicantChat = await req(applicant, `/conversations/${cid}`);
        assert.equal(applicantChat.messages.length, 2);
        assert.ok(
          applicantChat.messages.every(
            (m: { internal: boolean }) => !m.internal,
          ),
        );
        assert.equal(
          (await req(agent, `/conversations/${cid}`)).messages.length,
          3,
        );
        const callId = randomUUID();
        await req(
          applicant,
          `/conversations/${cid}/calls`,
          "POST",
          { clientId: callId },
          201,
        );
        await req(second, `/calls/${callId}`, "GET", undefined, 404);
        await req(
          applicant,
          `/calls/${callId}/state`,
          "POST",
          { state: "ACCEPTED" },
          403,
        );
        await req(
          agent,
          `/calls/${callId}/state`,
          "POST",
          { state: "ACCEPTED" },
          204,
        );
        await req(
          applicant,
          `/calls/${callId}/signals`,
          "POST",
          {
            clientId: randomUUID(),
            kind: "offer",
            payload: { type: "offer", sdp: "test SDP transport" },
          },
          204,
        );
        assert.equal((await req(agent, `/calls/${callId}`)).signals.length, 1);
        assert.equal(
          (await req(applicant, `/calls/${callId}`)).signals.length,
          0,
        );
        await req(
          agent,
          `/calls/${callId}/state`,
          "POST",
          { state: "ENDED" },
          204,
        );
        await req(
          agent,
          `/conversations/${cid}/status`,
          "POST",
          { status: "RESOLVED" },
          204,
        );
        await req(
          applicant,
          `/conversations/${cid}/messages`,
          "POST",
          { clientId: randomUUID(), body: "Closed" },
          409,
        );
        await req(
          applicant,
          `/conversations/${cid}/status`,
          "POST",
          { status: "OPEN" },
          204,
        );
        clock = new Date("2026-11-23T15:00:00Z");
        await req(
          agent,
          `/conversations/${cid}/messages`,
          "POST",
          { clientId: randomUUID(), body: "After hours" },
          409,
        );
        await req(
          applicant,
          `/conversations/${cid}/calls`,
          "POST",
          { clientId: randomUUID() },
          409,
        );
        // Queued applicant messages remain possible when live consultants are closed.
        await req(
          applicant,
          `/conversations/${cid}/messages`,
          "POST",
          { clientId: randomUUID(), body: "Please reply tomorrow." },
          201,
        );
        const from = new Date(Date.now() - 86400000).toISOString().slice(0, 10),
          to = new Date().toISOString().slice(0, 10);
        await db.$transaction((tx) =>
          insights(
            tx,
            [programme.id],
            new Date(from),
            new Date(Date.now() + 86400000),
          ),
        );
        const report = await req(agent, `/insights?from=${from}&to=${to}`);
        assert.equal(
          report.participation.reduce(
            (n: number, d: { applications: number }) => n + d.applications,
            0,
          ),
          1,
        );
        assert.equal(report.support.total, 1);
        await req(
          other,
          `/insights?from=${from}&to=${to}`,
          "GET",
          undefined,
          403,
        );
        await req(
          outsider,
          `/insights?from=${from}&to=${to}&programmeId=${programme.id}`,
          "GET",
          undefined,
          403,
        );
        const trail = await req(agent, "/audit");
        assert.ok(
          trail.items.some(
            (r: { action: string }) => r.action === "support.message_sent",
          ),
          JSON.stringify(trail),
        );
        await req(applicant, "/audit", "GET", undefined, 403);
        await assert.rejects(
          db.$executeRaw`UPDATE service_audits SET action='tamper' WHERE actor_id=${agent.userId}::uuid`,
        );

        assert.equal(
          (
            await req(
              applicant,
              `/applications/${app.id}/submit`,
              "POST",
              { expectedRevision: 0 },
              422,
            )
          ).code,
          "PRIVACY_CONSENT_REQUIRED",
        );
        await req(
          applicant,
          "/privacy/consent",
          "POST",
          { version: "2026-11-23", accepted: true },
          204,
        );
        const service = new ApplicationService(
          new PrismaApplicationRepository(db, principal, randomUUID()),
        );
        await service.update(
          principal,
          app.id,
          0,
          {
            title: "Water-saving irrigation",
            theme: "digital",
            problem: "Water loss",
            solution: "Measure use",
            impact: "Reduce waste",
            team: "Test team",
          },
          { items: [], fundingRequested: "", notApplicable: true },
        );
        const upload = await fetch(
          base.replace(/\/service$/, "") +
            `/applications/${app.id}/documents?name=proposal.pdf&category=technical-proposal&expectedRevision=1`,
          {
            method: "POST",
            headers: {
              Cookie: "dev_ceda_session=" + applicant.raw,
              Origin: "http://localhost:5174",
              "Content-Type": "application/octet-stream",
              "X-CSRF-Token": csrf(key, applicant.raw),
            },
            body: Buffer.from("%PDF-1.7\nsynthetic HTTP fixture"),
          },
        );
        assert.equal(upload.status, 201);
        const document = (await upload.json()) as {
          data: { revision: number };
        };
        await service.submit(
          principal,
          app.id,
          document.data.revision,
          randomUUID(),
        );
        await req(
          applicant,
          "/preferences",
          "PUT",
          { inApp: true, email: false, consent: false },
          422,
        );
        await req(
          applicant,
          "/preferences",
          "PUT",
          { inApp: true, email: true, consent: true },
          503,
        );
        await req(
          applicant,
          "/preferences",
          "PUT",
          { inApp: true, email: false, consent: true },
          204,
        );
        assert.equal(
          (await req(applicant, "/preferences")).consent_version,
          "2026-11-23",
        );
        await req(
          applicant,
          "/privacy/requests",
          "POST",
          { kind: "DELETE" },
          201,
        );
        await req(
          applicant,
          "/privacy/requests",
          "POST",
          { kind: "DELETE" },
          201,
        );
        assert.equal((await req(applicant, "/privacy/requests")).length, 1);

        await req(
          applicant,
          "/privacy/requests",
          "POST",
          { kind: "EXPORT" },
          201,
        );
        await req(
          applicant,
          "/preferences",
          "PUT",
          { inApp: false, email: false, consent: false },
          204,
        );
        const withdrawn = await req(applicant, "/preferences");
        assert.equal(withdrawn.contact_consent_version, null);
        assert.equal(withdrawn.consent_version, "2026-11-23");
        await req(
          applicant,
          "/preferences",
          "PUT",
          { inApp: true, email: false, consent: true },
          204,
        );
        const exported = await req(applicant, "/privacy/export");
        assert.equal(exported.account.id, applicant.userId);
        assert.equal(exported.applications.length, 1);
        assert.ok(!JSON.stringify(exported).includes("Private note"));
        assert.ok(
          (await req(applicant, "/privacy/requests")).some(
            (r: { kind: string; status: string }) =>
              r.kind === "EXPORT" && r.status === "COMPLETED",
          ),
        );
        await db.$transaction(async (tx) => {
          await notices(tx);
        });
        await db.$transaction(async (tx) => {
          await notices(tx);
        });
        const generated = await req(applicant, "/notifications");
        assert.equal(generated.length, 1);
        assert.equal(generated[0].title, "Application submitted");

        const noticeId = randomUUID();
        await owner.$executeRaw`INSERT INTO service_notifications(id,recipient_id,source_key,title,href) VALUES(${noticeId}::uuid,${applicant.userId}::uuid,'test','Application updated','/workspace')`;
        assert.equal((await req(other, "/notifications")).length, 0);
        assert.equal((await req(applicant, "/notifications")).length, 2);

        // Real database queue/retry test with a contract-only provider. No external email is sent.
        await owner.$executeRaw`UPDATE alert_preferences SET email=true,email_since=now() WHERE user_id=${applicant.userId}::uuid`;
        const emailId = randomUUID();
        await owner.$executeRaw`INSERT INTO service_notifications(id,recipient_id,source_key,title,href) VALUES(${emailId}::uuid,${applicant.userId}::uuid,'delivery-test','Status update','/workspace')`;
        const keys: string[] = [];
        const config = serviceConfigSchema.parse({
          EMAIL_API_URL: "https://mail.example.test/emails",
          EMAIL_API_KEY: "fixture-only",
          EMAIL_FROM: "portal@example.test",
        });
        const send: typeof fetch = async (_url, options) => {
          keys.push(new Headers(options?.headers).get("Idempotency-Key")!);
          return new Response("{}", { status: keys.length === 1 ? 429 : 200 });
        };
        await runServiceCycle(db, config, send);
        let status = await owner.$queryRaw<
          Array<{ email_state: string; attempts: number }>
        >`SELECT email_state,attempts FROM service_notifications WHERE id=${emailId}::uuid`;
        assert.equal(status[0]?.email_state, "RETRY");
        assert.equal(status[0]?.attempts, 1);
        await owner.$executeRaw`UPDATE service_notifications SET next_attempt_at=now() WHERE id=${emailId}::uuid`;
        await runServiceCycle(db, config, send);
        await runServiceCycle(db, config, send);
        status = await owner.$queryRaw<
          Array<{ email_state: string; attempts: number }>
        >`SELECT email_state,attempts FROM service_notifications WHERE id=${emailId}::uuid`;
        assert.equal(status[0]?.email_state, "SENT");
        assert.deepEqual(keys, [emailId, emailId]);

        const contested = randomUUID();
        await req(
          applicant,
          "/conversations",
          "POST",
          {
            clientId: contested,
            programmeId: programme.id,
            subject: "Concurrent assignment",
          },
          201,
        );
        clock = new Date("2026-11-23T09:00:00Z");
        const statuses = await Promise.all(
          [agent, second].map(async (person) => {
            const response = await fetch(
              base + `/conversations/${contested}/claim`,
              {
                method: "POST",
                headers: {
                  Cookie: "dev_ceda_session=" + person.raw,
                  Origin: "http://localhost:5174",
                  "Content-Type": "application/json",
                  "X-CSRF-Token": csrf(key, person.raw),
                },
                body: "{}",
              },
            );
            return response.status;
          }),
        );
        assert.deepEqual(statuses.sort(), [204, 409]);
        const abandonedCall=randomUUID();await req(applicant,`/conversations/${cid}/calls`,'POST',{clientId:abandonedCall},201);
      await req(agent,'/agent','POST',{available:false});
      await req(second,`/conversations/${cid}/claim`,'POST',{},409);
      await req(second,`/conversations/${cid}/claim`,'POST',{reason:'The previous consultant finished their shift.'},204);
      assert.equal((await req(second,`/conversations/${cid}`)).agent_id,second.userId);
      assert.equal((await req(applicant,`/calls/${abandonedCall}`)).state,'ENDED');
      assert.ok(!(await req(applicant,`/conversations/${cid}`)).messages.some((m:{body:string})=>m.body.includes('finished their shift')));
      const queue = await req(agent, "/conversations?paged=1&q=Concurrent");
        assert.equal(queue.items.length, 1);
        assert.equal(queue.hasMore, false);
        await owner.$executeRaw`INSERT INTO support_messages(id,conversation_id,sender_id,client_id,body)
        SELECT gen_random_uuid(),${cid}::uuid,${applicant.userId}::uuid,gen_random_uuid(),'History fixture '||n FROM generate_series(1,205) n`;
        const recent = await req(applicant, `/conversations/${cid}`);
        assert.equal(recent.messages.length, 200);
        assert.equal(recent.hasMoreMessages, true);
        const older = await req(
          applicant,
          `/conversations/${cid}?beforeId=${recent.messages[0].id}`,
        );
        assert.ok(older.messages.length > 0);
        assert.ok(
          older.messages.every((m: { internal: boolean }) => !m.internal),
        );
        const ids = new Set(recent.messages.map((m: { id: string }) => m.id));
        assert.ok(older.messages.every((m: { id: string }) => !ids.has(m.id)));
        await owner.programmeGrant.updateMany({
          where: { userId: agent.userId },
          data: { revokedAt: new Date() },
        });
        await req(agent, `/conversations/${cid}`, "GET", undefined, 404);
        await store.revoke(hash(applicant.raw));
        await req(applicant, "/conversations", "GET", undefined, 401);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((e) => (e ? reject(e) : resolve())),
        );
      }
    } finally {
      await runtime?.$disconnect();
      await owner.$disconnect();
      await admin.end();
    }
  },
);
