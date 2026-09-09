const prisma = require('../config/db');
const { redact } = require('../utils/redact');

async function createAudit({ actorType, actorId = null, tenantId = null, entityType, entityId = null, action, metadata = null }) {
  return prisma.opsAuditLog.create({
    data: {
      actor_type: actorType,
      actor_id: actorId,
      tenant_id: tenantId,
      entity_type: entityType,
      entity_id: entityId,
      action,
      metadata_json: metadata ? redact(metadata) : undefined
    }
  });
}

module.exports = { createAudit };
