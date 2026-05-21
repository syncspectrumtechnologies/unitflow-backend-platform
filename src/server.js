require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { env, validate } = require('./config/env');
const logger = require('./utils/logger');

const generatedPrismaClientPath = path.join(__dirname, 'generated', 'prisma', 'index.js');

function ensurePrismaClientGenerated() {
  if (fs.existsSync(generatedPrismaClientPath)) return;

  logger.info('Prisma client not found at startup. Running prisma generate.');

  const generateScriptPath = path.resolve(__dirname, '..', 'scripts', 'prisma-generate.js');
  const result = spawnSync(process.execPath, [generateScriptPath], {
    cwd: path.resolve(__dirname, '..'),
    env: process.env,
    stdio: 'inherit'
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`prisma generate failed with exit code ${result.status}`);
  }
  if (!fs.existsSync(generatedPrismaClientPath)) {
    throw new Error('Prisma client generation completed but the generated client is still missing.');
  }
}

if (env.validateEnvOnBoot) validate();

(async () => {
  try {
    ensurePrismaClientGenerated();

    const app = require('./app');
    const prisma = require('./config/db');
    const { ensureDefaultPlans } = require('./services/planService');
    const { startProvisioningWorker } = require('./services/provisioningService');
    const { bootstrapSuperAdminIfConfigured } = require('./services/superAdminService');

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
