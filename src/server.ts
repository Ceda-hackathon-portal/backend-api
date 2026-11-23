import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createDatabase } from './infrastructure/database.js';
import { createLogger } from './shared/logging.js';
import { closeResources } from './shared/shutdown.js';
import { Router } from 'express';
import { PrismaClient } from './generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { authConfig } from './modules/auth/config.js';
import { CognitoProvider } from './modules/auth/provider.js';
import { PrismaSessionStore } from './modules/auth/store.js';
import { authRoutes } from './modules/auth/routes.js';
import { applicationRoutes } from './modules/applications/routes.js';
import { mountOfficerSubmissionRoutes } from './modules/applications/officer-routes.js';
import { PrismaOfficerSubmissionReader } from './modules/applications/officer-submission-reader.js';
import { PrismaOfficerReviewScope } from './modules/applications/prisma-officer-review-scope.js';
import { mountEvaluationRoutes } from './infrastructure/evaluation-routes.js';
import { mountDecisionRoutes } from './infrastructure/decision-routes.js';
import { serviceRoutes } from './modules/service-center/routes.js';
import { serviceConfigSchema } from './modules/service-center/policy.js';
import { startServiceWorker } from './modules/service-center/worker.js';
import { mountStaffRoutes } from './modules/staff/routes.js';

async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node.js 24 LTS is required.');
  const config = loadConfig(process.env);
  const authentication = authConfig(process.env, config.SESSION_IDLE_SECONDS, config.SESSION_ABSOLUTE_SECONDS);
  const logger = createLogger(config);
  const database = createDatabase(config, () => logger.error({ code: 'DATABASE_IDLE_ERROR' }, 'database_error'));
  const apiRouter = Router();
  const prisma = authentication ? new PrismaClient({ adapter: new PrismaPg(database.pool, { disposeExternalPool: false }) }) : null;
  const assignmentDatabase = authentication && config.ASSIGNMENT_DATABASE_URL
    ? createDatabase({ ...config, DATABASE_URL: config.ASSIGNMENT_DATABASE_URL }, () => logger.error({ code: 'ASSIGNMENT_DATABASE_IDLE_ERROR' }, 'database_error'))
    : null;
  const assignmentPrisma = assignmentDatabase ? new PrismaClient({ adapter: new PrismaPg(assignmentDatabase.pool, { disposeExternalPool: false }) }) : null;
  let stopServiceWorker = async () => {};
  if (authentication && prisma) {
    const provider = authentication.mode === 'cognito' ? new CognitoProvider(authentication) : undefined;
    const auth = authRoutes(authentication, new PrismaSessionStore(prisma), provider);
    apiRouter.use('/auth', auth.router);
    const parsedServices = serviceConfigSchema.safeParse(process.env);
    if (!parsedServices.success) throw new Error('Invalid service configuration');
    apiRouter.use('/service', serviceRoutes(prisma, auth.verifier, auth.requireCsrf, parsedServices.data));
    stopServiceWorker = startServiceWorker(prisma, parsedServices.data, () => logger.error({code:'SERVICE_WORKER_FAILED'}, 'service_worker_failed'));
    apiRouter.use('/applications', applicationRoutes(prisma, auth.verifier, auth.requireCsrf, { screenOnSubmit: true, requirePrivacyConsent: true }));
    // Before the evaluation and decision routers: the decision router authenticates everything that reaches it.
    mountStaffRoutes(apiRouter, prisma, assignmentPrisma, auth.verifier, auth.requireCsrf);
    mountOfficerSubmissionRoutes(apiRouter, config, auth.verifier,
      new PrismaOfficerSubmissionReader(prisma, new PrismaOfficerReviewScope()));
    mountEvaluationRoutes(apiRouter, prisma, auth.verifier, auth.requireCsrf);
    mountDecisionRoutes(apiRouter, prisma, auth.verifier, auth.requireCsrf);
  }
  const resources = { check: () => database.check(), async close() { await stopServiceWorker(); await prisma?.$disconnect(); await assignmentPrisma?.$disconnect(); await assignmentDatabase?.close(); await database.close(); } };
  let draining = false;
  const server = createServer(createApp(config, { database: resources, logger, isDraining: () => draining, apiRouter }));
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.keepAliveTimeout = 5000;
  const shutdown = async (failed: boolean) => {
    if (draining) return;
    draining = true;
    try {
      await closeResources(server, resources, config.SHUTDOWN_TIMEOUT_MS);
      process.exitCode = failed ? 1 : 0;
      logger.info('shutdown_complete');
    } catch {
      logger.fatal({ code: 'SHUTDOWN_FAILED' }, 'shutdown_failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => { void shutdown(false); });
  process.on('SIGINT', () => { void shutdown(false); });
  server.once('error', () => {
    logger.fatal({ code: 'LISTEN_FAILED' }, 'startup_failed');
    const timer = setTimeout(() => process.exit(1), config.SHUTDOWN_TIMEOUT_MS);
    void resources.close().then(() => { clearTimeout(timer); process.exitCode = 1; }, () => { clearTimeout(timer); process.exit(1); });
  });
  server.listen(config.PORT, config.HOST, () => logger.info({ port: config.PORT }, 'server_listening'));
}

main().catch(error => {
  // Only configuration field names or a fixed startup message, never external error details.
  const safeMessages = ['Node.js 24 LTS is required.', 'Invalid authentication configuration', 'Invalid authentication origins'];
  const message = error instanceof Error && (error.message.startsWith('Invalid configuration fields:') || safeMessages.includes(error.message)) ? error.message : 'Backend startup failed.';
  console.error(message);
  process.exitCode = 1;
});
