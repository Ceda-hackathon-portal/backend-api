import { defineConfig } from 'prisma/config';

// This URL is supplied only by run.mjs for its newly created loopback cluster.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.SPIKE_DATABASE_URL ?? 'postgresql://invalid:invalid@127.0.0.1:1/invalid' },
});
