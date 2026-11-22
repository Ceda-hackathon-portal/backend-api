import assert from 'node:assert/strict';
import { PrismaClient, Prisma } from './generated/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

const url = process.env.SPIKE_DATABASE_URL;
assert.ok(url, 'Runner-owned URL required');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 2, connectionTimeoutMillis: 3000 }) });
let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}
try {
  const rows = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;
  assert.match(rows[0]?.version ?? '', /PostgreSQL 17\./);
  console.log(`DATABASE ${rows[0]?.version}`);
  const parent = await prisma.probe.create({ data: {} });
  await check('nullable draft-like field, UUID and timestamptz', async () => {
    assert.equal(parent.optionalText, null);
    assert.match(parent.id, /^[a-f0-9-]{36}$/);
    assert.ok(parent.createdAt instanceof Date);
  });
  const data = { probeId: parent.id, number: 1, title: 'Fictional compatibility fixture', amount: new Prisma.Decimal('1.125'), payload: { theme: 'digital', unicode: '🌱' } };
  await check('decimal/JSON/Unicode round-trip', async () => {
    const row = await prisma.probeSnapshot.create({ data });
    assert.equal(row.amount.toFixed(3), '1.125');
    assert.deepEqual(row.payload, data.payload);
  });
  await check('unique constraint rejects duplicate version', async () => {
    await assert.rejects(prisma.probeSnapshot.create({ data }), (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002');
  });
  await check('foreign key rejects unrelated snapshot', async () => {
    await assert.rejects(prisma.probeSnapshot.create({ data: { ...data, probeId: '00000000-0000-4000-8000-000000000000' } }), (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003');
  });
  await check('transaction rollback preserves parent', async () => {
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.probe.update({ where: { id: parent.id }, data: { optionalText: 'must roll back' } });
      throw new Error('deliberate rollback');
    }), /deliberate rollback/);
    assert.equal((await prisma.probe.findUniqueOrThrow({ where: { id: parent.id } })).optionalText, null);
  });
  await check('concurrent optimistic update has exactly one winner', async () => {
    const results = await Promise.all([1, 2].map(() => prisma.probe.updateMany({ where: { id: parent.id, revision: 0 }, data: { revision: { increment: 1 } } })));
    assert.equal(results.reduce((sum, r) => sum + r.count, 0), 1);
    assert.equal((await prisma.probe.findUniqueOrThrow({ where: { id: parent.id } })).revision, 1);
  });
  await check('SQL immutable trigger rejects update and delete', async () => {
    await assert.rejects(prisma.probeSnapshot.updateMany({ where: { probeId: parent.id }, data: { title: 'changed' } }));
    await assert.rejects(prisma.probeSnapshot.deleteMany({ where: { probeId: parent.id } }));
    assert.equal(await prisma.probeSnapshot.count(), 1);
  });
  await check('SQL check rejects invalid number', async () => {
    await assert.rejects(prisma.probeSnapshot.create({ data: { ...data, number: 0 } }));
  });
  console.log(`RESULT ${passed} compatibility checks passed; runtime ${process.version}`);
} finally {
  await prisma.$disconnect();
}
