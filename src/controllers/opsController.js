const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { syncTenantStatus } = require('../services/coreSyncService');
const { createAudit } = require('../services/auditService');
const { createNotification } = require('../services/notificationService');
const { listProvisioningQueue, queueProvisioning, processProvisioningQueue } = require('../services/provisioningService');
const { revokeTenantRuntimeAccess } = require('../services/runtimeAccessService');

exports.listTenants = async (req, res, next) => {
  try {
    const tenants = await prisma.tenant.findMany({
      include: {
        owner: { select: { id: true, email: true, name: true } },
        config: true,
        locations: true,
        subscriptions: { orderBy: { created_at: 'desc' }, take: 1 },
        payments: { orderBy: { created_at: 'desc' }, take: 5 }
      },
      orderBy: { created_at: 'desc' }
    });
    res.json({ ok: true, tenants });
  } catch (error) { next(error); }
};

exports.getTenant = async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.tenantId },
      include: {
        owner: { select: { id: true, email: true, name: true, phone: true } },
        config: true,
        locations: true,
        subscriptions: { include: { plan: true }, orderBy: { created_at: 'desc' } },
        payments: { orderBy: { created_at: 'desc' } },
        devices: true,
        notifications: { orderBy: { created_at: 'desc' }, take: 20 }
      }
    });
    if (!tenant) throw httpError(404, 'Tenant not found');
    res.json({ ok: true, tenant });
  } catch (error) { next(error); }
};

async function transitionTenant(req, res, next, targetStatus) {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.tenantId }, include: { subscriptions: { orderBy: { created_at: 'desc' }, take: 1 } } });
    if (!tenant) throw httpError(404, 'Tenant not found');

    await prisma.tenant.update({ where: { id: tenant.id }, data: { lifecycle_status: targetStatus } });

    const latest = tenant.subscriptions[0];
    if (latest) {
      let subStatus = latest.status;
      if (targetStatus === 'SUSPENDED') subStatus = 'EXPIRED';
      if (targetStatus === 'GRACE') subStatus = 'GRACE';
      if (targetStatus === 'ACTIVE') subStatus = 'ACTIVE';
      await prisma.tenantSubscription.update({ where: { id: latest.id }, data: { status: subStatus } });
    }

    if (targetStatus === 'SUSPENDED' || targetStatus === 'CANCELLED') {
      await revokeTenantRuntimeAccess(tenant.id, `tenant_${targetStatus.toLowerCase()}`);
    }

    await syncTenantStatus(tenant.id, {
      is_active: targetStatus !== 'SUSPENDED' && targetStatus !== 'EXPIRED' && targetStatus !== 'CANCELLED',
      subscription_status: targetStatus.toLowerCase()
    });

    await createNotification({ tenantId: tenant.id, accountId: tenant.owner_account_id, type: `tenant.${targetStatus.toLowerCase()}`, title: `Tenant ${targetStatus.toLowerCase()}`, body: `Your workspace status is now ${targetStatus.toLowerCase()}.` });
    await createAudit({ actorType: 'OPS', actorId: req.opsUser.id, tenantId: tenant.id, entityType: 'tenant', entityId: tenant.id, action: `tenant.${targetStatus.toLowerCase()}` });

    res.json({ ok: true, tenant_id: tenant.id, lifecycle_status: targetStatus });
  } catch (error) { next(error); }
}

exports.suspendTenant = (req, res, next) => transitionTenant(req, res, next, 'SUSPENDED');
exports.reactivateTenant = (req, res, next) => transitionTenant(req, res, next, 'ACTIVE');
exports.graceTenant = (req, res, next) => transitionTenant(req, res, next, 'GRACE');

exports.listNotifications = async (req, res, next) => {
  try {
    const notifications = await prisma.platformNotification.findMany({ orderBy: { created_at: 'desc' }, take: 100 });
    res.json({ ok: true, notifications });
  } catch (error) { next(error); }
};

exports.createRelease = async (req, res, next) => {
  try {
    const { channel, platform, version, artifact_url, checksum_sha256, min_supported_core_version, min_supported_platform_version, notes } = req.body || {};
    if (!channel || !platform || !version || !artifact_url) throw httpError(400, 'channel, platform, version, artifact_url are required');
    const release = await prisma.release.create({ data: { channel, platform, version, artifact_url, checksum_sha256, min_supported_core_version, min_supported_platform_version, notes } });
    await createAudit({ actorType: 'OPS', actorId: req.opsUser.id, entityType: 'release', entityId: release.id, action: 'release.created' });
    res.status(201).json({ ok: true, release });
  } catch (error) { next(error); }
};

exports.updateRelease = async (req, res, next) => {
  try {
    const release = await prisma.release.update({ where: { id: req.params.releaseId }, data: req.body || {} });
    await createAudit({ actorType: 'OPS', actorId: req.opsUser.id, entityType: 'release', entityId: release.id, action: 'release.updated' });
    res.json({ ok: true, release });
  } catch (error) { next(error); }
};

exports.listCoupons = async (req, res, next) => {
  try {
    const coupons = await prisma.coupon.findMany({
      include: {
        created_by: { select: { id: true, email: true, name: true } },
        redemptions: {
          select: { id: true, account_id: true, payment_id: true, status: true, discount_minor: true, applied_at: true },
          orderBy: { applied_at: 'desc' },
          take: 10
        }
      },
      orderBy: { created_at: 'desc' }
    });
    res.json({ ok: true, coupons });
  } catch (error) { next(error); }
};

exports.createCoupon = async (req, res, next) => {
  try {
    const {
      code,
      name,
      description,
      discount_type,
      amount_minor,
      percentage_off,
      max_discount_minor,
      min_amount_minor,
      currency,
      usage_limit,
      per_account_limit,
      first_payment_only,
      applies_to_plan_codes,
      active_from,
      expires_at,
      is_active = true,
      metadata_json
    } = req.body || {};

    if (!code || !name || !discount_type) {
      throw httpError(400, 'code, name, and discount_type are required');
    }

    const coupon = await prisma.coupon.create({
      data: {
        code: String(code).trim().toUpperCase(),
        name: String(name).trim(),
        description: description || null,
        discount_type,
        amount_minor: amount_minor ?? null,
        percentage_off: percentage_off ?? null,
        max_discount_minor: max_discount_minor ?? null,
        min_amount_minor: min_amount_minor ?? null,
        currency: currency || 'INR',
        usage_limit: usage_limit ?? null,
        per_account_limit: per_account_limit ?? 1,
        first_payment_only: first_payment_only !== false,
        applies_to_plan_codes: Array.isArray(applies_to_plan_codes) ? applies_to_plan_codes : undefined,
        active_from: active_from ? new Date(active_from) : null,
        expires_at: expires_at ? new Date(expires_at) : null,
        is_active: is_active !== false,
        metadata_json: metadata_json || undefined,
        created_by_account_id: null
      }
    });
    await createAudit({ actorType: 'OPS', actorId: req.opsUser.id, entityType: 'coupon', entityId: coupon.id, action: 'coupon.created' });
    res.status(201).json({ ok: true, coupon });
  } catch (error) { next(error); }
};

exports.updateCoupon = async (req, res, next) => {
  try {
    const payload = { ...(req.body || {}) };
    if (payload.code) payload.code = String(payload.code).trim().toUpperCase();
    if (payload.active_from !== undefined) payload.active_from = payload.active_from ? new Date(payload.active_from) : null;
    if (payload.expires_at !== undefined) payload.expires_at = payload.expires_at ? new Date(payload.expires_at) : null;
    const coupon = await prisma.coupon.update({
      where: { id: req.params.couponId },
      data: payload
    });
    await createAudit({ actorType: 'OPS', actorId: req.opsUser.id, entityType: 'coupon', entityId: coupon.id, action: 'coupon.updated' });
    res.json({ ok: true, coupon });
  } catch (error) { next(error); }
};

exports.listProvisioningQueue = async (req, res, next) => {
  try {
    const queue = await listProvisioningQueue();
    res.json({ ok: true, queue });
  } catch (error) { next(error); }
};

exports.retryProvisioning = async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.tenantId } });
    if (!tenant) throw httpError(404, 'Tenant not found');
    const queued = await queueProvisioning({ tenantId: tenant.id, reason: 'ops_retry', actorType: 'OPS', actorId: req.opsUser.id });
    res.json({ ok: true, ...queued });
  } catch (error) { next(error); }
};

exports.runProvisioningQueue = async (req, res, next) => {
  try {
    const result = await processProvisioningQueue();
    res.json({ ok: true, ...result });
  } catch (error) { next(error); }
};
