const prisma = require('../config/db');
const httpError = require('../utils/httpError');

exports.latest = async (req, res, next) => {
  try {
    const platform = String(req.query.platform || '').toUpperCase();
    const channel = String(req.query.channel || 'STABLE').toUpperCase();
    if (!platform) throw httpError(400, 'platform is required');

    if (req.query.tenant_id) {
      const tenant = await prisma.tenant.findUnique({ where: { id: req.query.tenant_id } });
      if (!tenant) throw httpError(404, 'Tenant not found');
      if (!['ACTIVE', 'GRACE'].includes(tenant.lifecycle_status)) {
        throw httpError(403, 'Tenant is not active for downloads');
      }
    }

    const release = await prisma.release.findFirst({
      where: { platform, channel, is_active: true },
      orderBy: { created_at: 'desc' }
    });
    if (!release) throw httpError(404, 'No matching release found');
    res.json({ ok: true, release });
  } catch (error) { next(error); }
};
