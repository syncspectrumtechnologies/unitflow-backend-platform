const prisma = require('../config/db');

async function createAudit({ actorType, actorId = null, tenantId = null, entityType, entityId = null, action, metadata = null }) {
  return prisma.opsAuditLog.create({
    data: {
      actor_type: actorType,
      actor_id: actorId,
      tenant_id: tenantId,
      entity_type: entityType,
      entity_id: entityId,
      action,
      metadata_json: metadata || undefined
    }
  });
}

module.exports = { createAudit };
