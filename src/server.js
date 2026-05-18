require('dotenv').config();
const app = require('./app');
const prisma = require('./config/db');
const { env, validate } = require('./config/env');
const logger = require('./utils/logger');
const { ensureDefaultPlans } = require('./services/planService');
const { startProvisioningWorker } = require('./services/provisioningService');
const { bootstrapSuperAdminIfConfigured } = require('./services/superAdminService');

if (env.validateEnvOnBoot) validate();

(async () => {
  try {
    await ensureDefaultPlans();
    await bootstrapSuperAdminIfConfigured();
    startProvisioningWorker();
    const server = app.listen(env.port, '0.0.0.0', () => {
      logger.info('UnitFlow platform API started', { port: env.port, build_fingerprint: env.buildFingerprint });
    });

    const shutdown = async (signal) => {
      logger.info('Shutting down platform API', { signal });
      server.close(async () => {
        await prisma.$disconnect().catch(() => null);
        process.exit(0);
      });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    logger.error('Failed to start platform API', { error_message: error.message });
    process.exit(1);
  }
})();
