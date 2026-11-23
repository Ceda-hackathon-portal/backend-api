// Isolated, synthetic browser acceptance environment. Never reads .env or a shared database.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import {createServer as createTcpServer} from "node:net";
import { Router } from "express";
import { Client } from "pg";
import { pino } from "pino";
import { PrismaClient } from "../dist/src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { createApp } from "../dist/src/app.js";
import { loadConfig } from "../dist/src/config/env.js";
import { authRoutes } from "../dist/src/modules/auth/routes.js";
import { PrismaSessionStore } from "../dist/src/modules/auth/store.js";
import { hash, token } from "../dist/src/modules/auth/crypto.js";
import { serviceRoutes } from "../dist/src/modules/service-center/routes.js";
import { serviceConfigSchema } from "../dist/src/modules/service-center/policy.js";
import { mountStaffRoutes } from "../dist/src/modules/staff/routes.js";
import { applicationRoutes } from "../dist/src/modules/applications/routes.js";
import { ApplicationService } from "../dist/src/modules/applications/service.js";
import { PrismaApplicationRepository } from "../dist/src/modules/applications/repository.js";
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
if (Number(process.versions.node.split(".")[0]) !== 24)
  throw new Error("Node 24 required");
const runId = randomUUID(),
  root = resolve(".runtime", "service-browser-" + runId),
  bin = resolve(
    "spikes/prisma7/node_modules/@embedded-postgres/windows-x64/native/bin",
  );
mkdirSync(root, { recursive: true });
function command(exe, args, env = process.env) {
  const r = spawnSync(exe, args, { windowsHide: true, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(r.stderr || "Command failed");
}
const reservation=createTcpServer();await new Promise(ok=>reservation.listen(0,'127.0.0.1',ok));
const pgPort=reservation.address().port;await new Promise(ok=>reservation.close(ok));
command(join(bin, "initdb.exe"), [
  "-D",
  join(root, "data"),
  "-U",
  "fixture",
  "-A",
  "trust",
  "--encoding=UTF8",
  "--locale=C",
]);
const pg = spawn(
  join(bin, "postgres.exe"),
  ["-D", join(root, "data"), "-h", "127.0.0.1", "-p", String(pgPort)],
  { windowsHide: true, stdio: "ignore" },
);
const databaseUrl = `postgresql://fixture@127.0.0.1:${pgPort}/postgres`;
let owner, db, server;
async function stop() {
  if (server) await new Promise((ok) => server.close(ok));
  await db?.$disconnect();
  await owner?.$disconnect();
  command(join(bin, "pg_ctl.exe"), [
    "-D",
    join(root, "data"),
    "-m",
    "fast",
    "-w",
    "stop",
  ]);
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const c = new Client({ connectionString: databaseUrl });
    try {
      await c.connect();
      ready = true;
    } catch {
    } finally {
      await c.end().catch(() => {});
    }
    if (ready) break;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  if (!ready) throw new Error("Database did not start");
  command(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    { ...process.env, DATABASE_URL: databaseUrl },
  );
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(readFileSync("ops/runtime-role.sql", "utf8"));
  await admin.query("CREATE ROLE service_preview LOGIN IN ROLE ceda_runtime");
  await admin.end();
  owner = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: databaseUrl,
      options: "-c timezone=UTC",
      max: 4,
    }),
  });
  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = "service_preview";
  db = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: runtimeUrl.href,
      options: "-c timezone=UTC",
      max: 8,
    }),
  });
  const store = new PrismaSessionStore(db),
    key = randomBytes(32).toString("hex");
  async function person(name) {
    const raw = token();
    await store.create(
      {
        issuer: "https://fixture.example",
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
    return { ...session, raw };
  }
  const applicant = await person("Kabelo — test applicant"),
    agent = await person("CEDA consultant — test account");
  const programme = await owner.programme.create({
    data: {
      code: "SVC-" + runId,
      name: "Innovation programme — browser test",
    },
  });
  const version = await owner.programmeVersion.create({
    data: {
      programmeId: programme.id,
      version: 1,
      publishedAt: new Date(Date.now() - 86400000),
      opensAt: new Date(Date.now() - 86400000),
      closesAt: new Date(Date.now() + 86400000),
      config: { themes: ["digital"] },
    },
  });
  for (const permission of ["support.manage", "report.read", "audit.read"])
    await owner.programmeGrant.create({
      data: {
        userId: agent.userId,
        programmeId: programme.id,
        permission,
        grantedById: agent.userId,
      },
    });
  const principal = {
    userId: applicant.userId,
    sessionId: applicant.id,
    authnLevel: "password",
  };
  const application = await new ApplicationService(
    new PrismaApplicationRepository(db, principal, randomUUID()),
  ).create(principal, programme.id, version.id);
  const api = Router(),
    auth = authRoutes(
      {
        mode: "cognito",
        issuer: "https://fixture.example",
        clientId: "fixture",
        apiOrigin: "http://localhost:3017",
        frontendOrigin: "http://localhost:5187",
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
    applicationRoutes(db, auth.verifier, auth.requireCsrf),
  );
  // Fixed working-hours clock is injected ONLY into this explicitly synthetic acceptance harness.
  api.use(
    "/service",
    serviceRoutes(
      db,
      auth.verifier,
      auth.requireCsrf,
      serviceConfigSchema.parse({}),
      () => new Date("2026-11-23T09:00:00Z"),
    ),
  );
  mountStaffRoutes(api, db, null, auth.verifier, auth.requireCsrf);
  server = createServer(
    createApp(
      loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: runtimeUrl.href,
        ALLOWED_ORIGINS: "http://localhost:5187",
      }),
      {
        database: { async check() {}, async close() {} },
        logger: pino({ level: "silent" }),
        apiRouter: api,
      },
    ),
  );
  await new Promise((ok) => server.listen(3017, "127.0.0.1", ok));
  writeFileSync(
    ".runtime/service-browser-session.json",
    JSON.stringify({
      applicant,
      agent,
      applicationId: application.id,
      programmeId: programme.id,
    }),
  );
  console.log(
    "Isolated service acceptance API ready at http://localhost:3017. Synthetic test accounts and fixed office-hours clock; sessions saved only in ignored .runtime.",
  );
} catch (error) {
  console.error(error);
  await stop();
}
