const { PrismaClient } = require('../generated/prisma');
const { env } = require('./env');

module.exports = new PrismaClient({
  log: env.isProduction ? ['error'] : ['error', 'warn']
});
