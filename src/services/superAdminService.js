const bcrypt = require('bcrypt');
const prisma = require('../config/db');
const logger = require('../utils/logger');

function getBootstrapConfig() {
  const email = String(process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL || '').toLowerCase().trim();
  const password = String(process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD || '').trim();
  const name = String(process.env.BOOTSTRAP_SUPER_ADMIN_NAME || 'UnitFlow Super Admin').trim();
  const phone = String(process.env.BOOTSTRAP_SUPER_ADMIN_PHONE || '').trim() || null;
  return { email, password, name, phone };
}

async function upsertSuperAdmin({ email, password, name, phone = null }) {
  if (!email) throw new Error('BOOTSTRAP_SUPER_ADMIN_EMAIL is required');
  if (!password) throw new Error('BOOTSTRAP_SUPER_ADMIN_PASSWORD is required');

  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();

  return prisma.account.upsert({
    where: { email },
    update: {
      name,
      phone: phone || undefined,
      password_hash: passwordHash,
      status: 'ACTIVE',
      is_super_admin: true,
      runtime_access_exempt: true,
      email_verified_at: now,
      phone_verified_at: phone ? now : null
    },
    create: {
      email,
      phone,
      name,
      password_hash: passwordHash,
      status: 'ACTIVE',
      is_super_admin: true,
      runtime_access_exempt: true,
      email_verified_at: now,
      phone_verified_at: phone ? now : null
    }
  });
}

async function bootstrapSuperAdminIfConfigured() {
  const config = getBootstrapConfig();
  if (!config.email || !config.password) return null;
  const account = await upsertSuperAdmin(config);
  logger.info('Super admin bootstrap ensured', { account_id: account.id, email: account.email });
  return account;
}

module.exports = { getBootstrapConfig, upsertSuperAdmin, bootstrapSuperAdminIfConfigured };
