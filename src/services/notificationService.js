const prisma = require('../config/db');

async function createNotification({ tenantId = null, accountId = null, type, title, body = null, severity = 'INFO', payload = null }) {
  return prisma.platformNotification.create({
    data: {
      tenant_id: tenantId,
      account_id: accountId,
      type,
      title,
      body,
      severity,
      payload_json: payload || undefined
    }
  });
}

module.exports = { createNotification };
