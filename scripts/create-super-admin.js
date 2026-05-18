require('dotenv').config();
const prisma = require('../src/config/db');
const { getBootstrapConfig, upsertSuperAdmin } = require('../src/services/superAdminService');

(async () => {
  try {
    const config = getBootstrapConfig();
    if (!config.email || !config.password) {
      console.error('BOOTSTRAP_SUPER_ADMIN_EMAIL and BOOTSTRAP_SUPER_ADMIN_PASSWORD are required');
      process.exit(1);
    }

    const account = await upsertSuperAdmin(config);
    console.log(`Super admin ready: ${account.email}`);
  } finally {
    await prisma.$disconnect();
  }
})();
