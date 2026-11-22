import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cpus, totalmem, release } from 'node:os';
import { Router } from 'express';
import { pino } from 'pino';
import { Writable } from 'node:stream';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaSessionStore } from '../src/modules/auth/store.js';
import { authRoutes } from '../src/modules/auth/routes.js';
import type { LoginAttempt } from '../src/modules/auth/provider.js';
import { hash, token } from '../src/modules/auth/crypto.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { requireAccess } from '../src/shared/authorization.js';

test('security verification: HTTP + real session database, synthetic provider; no production/grant claims', async () => {
  assert.match(process.env.DISPOSABLE_DATABASE_RUN ?? '', /^[a-f0-9-]{36}$/);
  const url = process.env.DATABASE_URL!; assert.equal(new URL(url).hostname, '127.0.0.1');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, options: '-c timezone=UTC', max: 5 }) });
  const store = new PrismaSessionStore(db);
  const observations: string[] = []; const findings: string[] = [];
  let log = ''; const logger = pino({ level: 'info' }, new Writable({ write(chunk, _encoding, callback) { log += String(chunk); callback(); } }));
  let attempt!: LoginAttempt; let unavailable = false;
  const key = randomBytes(32).toString('hex');
  const origin = 'https://frontend.example.test';
  const identity = { issuer: 'https://synthetic.example.test', subject: token(), email: token() + '@example.test', name: 'Fictional test account' };
  const cfg = { mode: 'cognito' as const, issuer: identity.issuer, clientId: 'synthetic', apiOrigin: 'https://api.example.test', frontendOrigin: origin, key, secure: true, idleSeconds: 1800, absoluteSeconds: 28800 };
  const wrapped = { saveAttempt: store.saveAttempt.bind(store), consumeAttempt: store.consumeAttempt.bind(store), create: store.create.bind(store), revoke: store.revoke.bind(store), async find(h: string, idle: number) { if (unavailable) throw new Error('PRIVATE_FAILURE_CANARY'); return store.find(h, idle); } };
  const auth = authRoutes(cfg, wrapped, { async begin(a) { attempt = a; return 'https://synthetic.example.test/authorize'; }, async complete() { return identity; } });
  const router = Router(); router.use('/auth', auth.router);
  router.get('/verification-only/denied', requireAccess({ permission: 'fixture' }, auth.verifier), (_req, res) => res.json({ data: 'unreachable' }));
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url, ALLOWED_ORIGINS: origin, LOG_LEVEL: 'info' });
  const server = createServer(createApp(config, { database: { async check() { await db.$queryRaw`SELECT 1`; }, async close() {} }, logger, apiRouter: router }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const checks: Array<{ name: string; status: number }> = [];
  async function request(path: string, expected: number, init: RequestInit = {}) {
    const result = await fetch(base + path, { redirect: 'manual', ...init });
    assert.equal(result.status, expected, path); assert.equal(result.headers.get('cache-control'), 'no-store');
    checks.push({ name: path.split('?')[0]!, status: result.status }); return result;
  }
  const takeCookie = (r: Response, name: string) => r.headers.getSetCookie().find(s => s.startsWith(name + '='))!.split(';')[0]!;
  try {
    await request('/auth/session', 401);
    await request('/auth/session', 401, { headers: { Cookie: '__Host-ceda_session=bad' } });
    const boot = await request('/auth/csrf', 200); const anon = takeCookie(boot, '__Host-ceda_csrf'); const anti = (await boot.json()).data.csrfToken;
    const mutation = (cookie: string, csrf: string, suppliedOrigin = origin) => ({ method: 'POST', headers: { Cookie: cookie, Origin: suppliedOrigin, 'X-CSRF-Token': csrf } });
    await request('/auth/login', 403, { method: 'POST' });
    await request('/auth/login', 403, mutation(anon, 'invalid'));
    await request('/auth/login', 403, mutation(anon, anti, 'https://evil.example.test'));
    await request('/auth/login', 403, mutation(anon, anti, 'null'));
    for (const role of ['submitter','evaluator','adjudicator','administrator','management','system-administrator']) {
      await request('/auth/login', 422, { ...mutation(anon, anti), headers: { ...mutation(anon, anti).headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
    }
    const login = await request('/auth/login', 200, mutation(anon, anti)); const browser = takeCookie(login, '__Host-ceda_oidc');
    const callback = await request('/auth/callback?code=synthetic&state=' + attempt.state, 303, { headers: { Cookie: browser } });
    const first = takeCookie(callback, '__Host-ceda_session'); const raw = first.split('=')[1]!;
    assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
    const flags = callback.headers.getSetCookie().find(s => s.startsWith('__Host-ceda_session='))!;
    for (const flag of ['Secure','HttpOnly','SameSite=Lax','Path=/']) assert.ok(flags.includes(flag));
    const saved = await db.authSession.findUniqueOrThrow({ where: { tokenHash: hash(raw) } });
    assert.notEqual(saved.tokenHash, raw); assert.equal(saved.tokenHash, hash(raw));
    const restored = await request('/auth/session', 200, { headers: { Cookie: first } }); const profile = (await restored.json()).data;
    assert.deepEqual(profile.user.roles, []); assert.deepEqual(profile.grants, []);
    await request('/verification-only/denied', 401);
    await request('/verification-only/denied?userId=forged&programmeId=forged&role=system-administrator', 403, { headers: { Cookie: first } });
    await request('/auth/logout', 403, mutation(first, anti)); // Anonymous token cannot authorize session mutation.
    await request('/auth/session', 401, { headers: { Cookie: first + '; ' + first } });
    unavailable = true; const failure = await request('/auth/session', 500, { headers: { Cookie: first } });
    assert.ok(!(await failure.text()).includes('PRIVATE_FAILURE_CANARY')); unavailable = false;
    const durations: Array<Record<string, unknown>> = [];
    for (const [path, expected, headers] of [ ['/auth/session',200,{ Cookie: first }], ['/verification-only/denied',403,{ Cookie: first }], ['/auth/session',401,{}] ] as const) {
      for (let i=0;i<10;i++) await (await fetch(base+path,{headers})).text();
      let index=0, errors=0; const times: number[]=[];
      await Promise.all(Array.from({length:5},async()=>{ while(index++<100){const start=performance.now();const r=await fetch(base+path,{headers});await r.text();if(r.status!==expected)errors++;times.push(performance.now()-start);} }));
      times.sort((a,b)=>a-b);durations.push({endpoint:path,expectedStatus:expected,requests:times.length,concurrency:5,medianMs:times[49],p95Ms:times[94],unexpectedErrorRate:errors/times.length});
    }
    const tokens = Array.from({length:1000},()=>token()); assert.equal(new Set(tokens).size,1000); observations.push('1000 generated session tokens unique; entropy assurance is source crypto.randomBytes, not statistical proof');
    const cap = await store.find(hash(raw), 999999); assert.ok(cap); assert.ok(cap.expiresAt <= saved.absoluteExpiresAt);
    await Promise.all(Array.from({length:10},()=>store.find(hash(raw),1800)));
    await db.authUser.update({where:{id:saved.userId},data:{status:'SUSPENDED'}});
    await request('/auth/session',401,{headers:{Cookie:first}});
    await assert.rejects(store.create(identity,hash(token()),null,1800,28800));
    await db.authUser.update({where:{id:saved.userId},data:{status:'ACTIVE'}});
    await request('/auth/session', 401, { headers: { Cookie: first } });
    const freshLogin = await request('/auth/login', 200, mutation(anon, anti));
    const freshCallback = await request('/auth/callback?code=synthetic&state=' + attempt.state, 303, {
      headers: { Cookie: takeCookie(freshLogin, '__Host-ceda_oidc') }
    });
    const fresh = takeCookie(freshCallback, '__Host-ceda_session');
    await request('/auth/session', 200, { headers: { Cookie: fresh } });
    const extra=hash(token());await store.create(identity,extra,null,1800,28800);assert.ok(await store.find(extra,1800));observations.push('Concurrent independent sessions supported');
    const renewed=await request('/auth/csrf',200,{headers:{Cookie:fresh}});const logoutCsrf=(await renewed.json()).data.csrfToken;
    await request('/auth/logout',204,mutation(fresh,logoutCsrf));await request('/auth/session',401,{headers:{Cookie:fresh}});await request('/verification-only/denied',401,{headers:{Cookie:fresh}});
    assert.ok(await store.find(extra,1800));await Promise.all([store.revoke(extra),store.find(extra,1800)]);assert.equal(await store.find(extra,1800),null);
    await assert.rejects(db.authSession.create({data:{tokenHash:hash(token()),userId:'00000000-0000-4000-8000-000000000000',idleExpiresAt:new Date(Date.now()+1000),absoluteExpiresAt:new Date(Date.now()+2000)}}));
    const before=await db.authUser.count();await assert.rejects(db.$transaction(async tx=>{await tx.authUser.create({data:{email:token()+'@example.test',name:'Rollback fixture'}});throw new Error('rollback');}));assert.equal(await db.authUser.count(),before);
    let limited=false;for(let i=0;i<25;i++){const r=await fetch(base+'/auth/login',mutation(anon,anti));await r.text();if(r.status===429){assert.equal(r.headers.get('cache-control'),'no-store');limited=true;break;}}assert.equal(limited,true);
    await new Promise(resolve=>setTimeout(resolve,50));assert.ok(!log.includes(raw)&&!log.includes(identity.email)&&!log.includes('PRIVATE_FAILURE_CANARY'));
    writeFileSync('.runtime/phase4-security-results.json',JSON.stringify({syntheticProvider:true,realDatabase:true,checks,findings,observations,performance:durations,machine:{node:process.version,os:release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,ramGiB:totalmem()/1024**3}},null,2));
    console.log(JSON.stringify({performance:durations,findings,checks:checks.length}));
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await db.$disconnect();}
});
