const crypto = require('crypto');
const prisma = require('../config/db');
const { env } = require('../config/env');
const logger = require('../utils/logger');
const httpError = require('../utils/httpError');
const { provisionTenant, syncTenantConfig, syncTenantStatus } = require('./coreSyncService');
const { createAudit } = require('./auditService');
const { createNotification } = require('./notificationService');
const { isPrivilegedRuntimeAccess } = require('./runtimeAccessService');

let workerTimer = null;
let workerRunning = false;

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function configVersionHash(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 16);
}

function getLatestSubscription(tenant) {
  return Array.isArray(tenant?.subscriptions) ? tenant.subscriptions[0] || null : null;
}

function buildPrivilegedSubscriptionSnapshot() {
  return {
    id: null,
    status: 'ACTIVE',
    billing_cycle: 'YEARLY',
    seat_limit: Number.MAX_SAFE_INTEGER,
    renews_at: null,
    ends_at: null,
    plan: {
      code: 'SUPER_ADMIN',
      name: 'Super Admin Access',
      plan_type: 'MULTI_USER',
      feature_limits_json: { enabled_modules: ['core_erp'], privileged_runtime_access: true }
    },
    plan_snapshot_json: {
      code: 'SUPER_ADMIN',
      name: 'Super Admin Access',
      plan_type: 'MULTI_USER',
      feature_limits_json: { enabled_modules: ['core_erp'], privileged_runtime_access: true }
    }
  };
}

function buildProvisioningVersion(tenant, subscription) {
  return configVersionHash({
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      display_name: tenant.display_name,
      legal_name: tenant.legal_name,
      business_type: tenant.business_type,
      onboarding_status: tenant.onboarding_status,
      lifecycle_status: tenant.lifecycle_status
    },
    owner: {
      email: tenant.owner?.email,
      phone: tenant.owner?.phone,
      name: tenant.owner?.name
    },
    config: {
      theme_color: tenant.config?.theme_color,
      logo_url: tenant.config?.logo_url,
      app_title: tenant.config?.app_title,
      invoice_header: tenant.config?.invoice_header,
      invoice_footer: tenant.config?.invoice_footer,
      locale: tenant.config?.locale,
      timezone: tenant.config?.timezone
    },
    locations: (tenant.locations || []).map((item) => ({
      name: item.name,
      code: item.code,
      address: item.address,
      is_active: item.is_active
    })).sort((a, b) => a.name.localeCompare(b.name)),
    sales_companies: (tenant.sales_companies || []).map((item) => ({
      name: item.name,
      legal_name: item.legal_name,
      gstin: item.gstin,
      phone: item.phone,
      email: item.email,
      address: item.address,
      state: item.state,
      state_code: item.state_code,
      is_gst_enabled: item.is_gst_enabled,
      is_active: item.is_active,
      same_as_main_company: item.same_as_main_company
    })).sort((a, b) => a.name.localeCompare(b.name)),
    subscription: subscription ? {
      id: subscription.id,
      status: subscription.status,
      billing_cycle: subscription.billing_cycle,
      seat_limit: subscription.seat_limit,
      plan_code: subscription.plan?.code || subscription.plan_snapshot_json?.code || null,
      plan_type: subscription.plan?.plan_type || subscription.plan_snapshot_json?.plan_type || null,
      renews_at: subscription.renews_at?.toISOString?.() || null,
      ends_at: subscription.ends_at?.toISOString?.() || null,
      feature_limits_json: subscription.plan?.feature_limits_json || subscription.plan_snapshot_json?.feature_limits_json || null
    } : null
  });
}

async function loadTenantForProvisioning(tenantId) {
  return prisma.tenant.findUnique({
    where: { id: tenantId },
    include: {
      owner: true,
      config: true,
      locations: { orderBy: { created_at: 'asc' } },
      sales_companies: { orderBy: { created_at: 'asc' } },
      subscriptions: {
        include: { plan: true },
        orderBy: { created_at: 'desc' },
        take: 1
      }
    }
  });
}

function buildProvisionPayload(tenant, subscription, configVersion) {
  const planCode = subscription.plan?.code || subscription.plan_snapshot_json?.code || null;
  const featureLimits = subscription.plan?.feature_limits_json || subscription.plan_snapshot_json?.feature_limits_json || {};

  return {
    tenant_id: tenant.id,
    company: {
      name: tenant.display_name,
      legal_name: tenant.legal_name,
      phone: tenant.owner.phone,
      email: tenant.owner.email,
      address: tenant.locations?.[0]?.address || null
    },
    branding: {
      tenant_slug: tenant.slug,
      theme_color: tenant.config?.theme_color,
      logo_url: tenant.config?.logo_url,
      app_title: tenant.config?.app_title || tenant.display_name,
      invoice_header: tenant.config?.invoice_header,
      invoice_footer: tenant.config?.invoice_footer,
      locale: tenant.config?.locale,
      timezone: tenant.config?.timezone,
      config_version: configVersion,
      enabled_modules: featureLimits.enabled_modules || ['core_erp'],
      feature_flags: featureLimits
    },
    locations: (tenant.locations || []).map((item) => ({
      name: item.name,
      code: item.code,
      address: item.address,
      is_active: item.is_active !== false
    })),
    sales_companies: (tenant.sales_companies || []).map((item) => ({
      name: item.name,
      legal_name: item.legal_name,
      gstin: item.gstin,
      phone: item.phone,
      email: item.email,
      address: item.address,
      state: item.state,
      state_code: item.state_code,
      is_gst_enabled: item.is_gst_enabled,
      is_active: item.is_active !== false,
      same_as_main_company: item.same_as_main_company === true
    })),
    admin_account: {
      email: tenant.owner.email,
      phone: tenant.owner.phone,
      name: tenant.owner.name,
      password_hash: tenant.owner.password_hash
    },
    subscription: {
      plan_code: planCode,
      billing_cycle: String(subscription.billing_cycle || '').toLowerCase(),
      status: String(subscription.status || '').toLowerCase(),
      active_until: subscription.renews_at?.toISOString?.() || subscription.ends_at?.toISOString?.() || null,
      seat_limit: subscription.seat_limit,
      feature_limits: featureLimits,
      config_version: configVersion
    }
  };
}

async function setTenantQueueState(tenantId, nextStatus, onboardingStatus = 'PROVISIONING') {
  return prisma.tenant.update({
    where: { id: tenantId },
    data: {
      runtime_provision_status: nextStatus,
      onboarding_status: onboardingStatus
    }
  });
}

async function queueProvisioning({ tenantId, reason = 'manual', actorType = 'SYSTEM', actorId = null }) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw httpError(404, 'Tenant not found');

  const nextStatus = tenant.runtime_company_id ? 'SYNC_PENDING' : 'QUEUED';
  await setTenantQueueState(tenantId, nextStatus);

  await createAudit({
    actorType,
    actorId,
    tenantId,
    entityType: 'tenant',
    entityId: tenantId,
    action: 'tenant.provisioning.queued',
    metadata: { reason, queue_status: nextStatus }
  });

  return { tenant_id: tenantId, runtime_provision_status: nextStatus };
}

async function runProvisioningJob(tenantId, { reason = 'worker', actorType = 'SYSTEM', actorId = null, force = false } = {}) {
  const tenant = await loadTenantForProvisioning(tenantId);
  if (!tenant) throw httpError(404, 'Tenant not found');

  const privilegedProvisioning = isPrivilegedRuntimeAccess(tenant);
  const latestSubscription = getLatestSubscription(tenant) || (privilegedProvisioning ? buildPrivilegedSubscriptionSnapshot() : null);
  if (!latestSubscription || !['ACTIVE', 'GRACE'].includes(latestSubscription.status)) {
    throw httpError(409, 'Tenant does not have an active subscription for provisioning');
  }

  if (!tenant.owner?.email_verified_at || !tenant.owner?.phone_verified_at) {
    throw httpError(409, 'Email and phone verification are required before provisioning');
  }

  if (tenant.runtime_provision_status === 'IN_PROGRESS' && !force) {
    return { queued: false, skipped: true, tenant_id: tenant.id, runtime_provision_status: 'IN_PROGRESS' };
  }

  const configVersion = buildProvisioningVersion(tenant, latestSubscription);

  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      runtime_provision_status: 'IN_PROGRESS',
      onboarding_status: 'PROVISIONING'
    }
  });

  const payload = buildProvisionPayload(tenant, latestSubscription, configVersion);

  try {
    const provisioned = await provisionTenant(payload);
    await syncTenantConfig(tenant.id, {
      company: payload.company,
      branding: payload.branding,
      locations: payload.locations,
      sales_companies: payload.sales_companies
    });
    await syncTenantStatus(tenant.id, {
      is_active: privilegedProvisioning || ['ACTIVE', 'GRACE'].includes(latestSubscription.status),
      subscription_status: privilegedProvisioning ? 'super_admin' : String(latestSubscription.status || '').toLowerCase(),
      plan_code: payload.subscription.plan_code,
      billing_cycle: payload.subscription.billing_cycle,
      active_until: payload.subscription.active_until,
      trial_ends_at: null
    });

    const targetLifecycleStatus = privilegedProvisioning ? 'ACTIVE' : latestSubscription.status === 'GRACE' ? 'GRACE' : 'ACTIVE';
    const updatedTenant = await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        runtime_company_id: provisioned.company_id || tenant.runtime_company_id || tenant.id,
        runtime_owner_user_id: provisioned.admin_user_id || tenant.runtime_owner_user_id,
        runtime_provision_status: 'READY',
        runtime_last_synced_at: new Date(),
        onboarding_status: 'READY',
        lifecycle_status: targetLifecycleStatus
      }
    });

    await createAudit({
      actorType,
      actorId,
      tenantId: tenant.id,
      entityType: 'tenant',
      entityId: tenant.id,
      action: 'tenant.provisioning.completed',
      metadata: {
        reason,
        config_version: configVersion,
        company_id: updatedTenant.runtime_company_id,
        admin_user_id: updatedTenant.runtime_owner_user_id,
        plan_code: payload.subscription.plan_code,
        billing_cycle: payload.subscription.billing_cycle
      }
    });

    await createNotification({
      tenantId: tenant.id,
      accountId: tenant.owner_account_id,
      type: 'tenant.provisioning.ready',
      title: 'Workspace is ready',
      body: `${tenant.display_name} is provisioned and ready for runtime access.`,
      payload: { config_version: configVersion }
    });

    return { ok: true, tenant_id: tenant.id, config_version: configVersion, runtime_company_id: updatedTenant.runtime_company_id };
  } catch (error) {
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        runtime_provision_status: 'FAILED',
        onboarding_status: tenant.runtime_company_id ? 'READY' : 'PROFILE_COMPLETED'
      }
    });

    await createAudit({
      actorType,
      actorId,
      tenantId: tenant.id,
      entityType: 'tenant',
      entityId: tenant.id,
      action: 'tenant.provisioning.failed',
      metadata: { reason, error_message: error.message, config_version: configVersion }
    });

    await createNotification({
      tenantId: tenant.id,
      accountId: tenant.owner_account_id,
      type: 'tenant.provisioning.failed',
      severity: 'CRITICAL',
      title: 'Workspace provisioning failed',
      body: error.message,
      payload: { reason }
    });

    throw error;
  }
}

async function processProvisioningQueue() {
  if (workerRunning) return { ok: true, skipped: true };
  workerRunning = true;

  try {
    const batchSize = Number(process.env.PROVISIONING_WORKER_BATCH_SIZE || 5);
    const queued = await prisma.tenant.findMany({
      where: { runtime_provision_status: { in: ['QUEUED', 'SYNC_PENDING'] } },
      orderBy: { updated_at: 'asc' },
      take: batchSize,
      select: { id: true }
    });

    for (const item of queued) {
      try {
        await runProvisioningJob(item.id, { reason: 'worker', actorType: 'SYSTEM' });
      } catch (error) {
        logger.error('Provisioning worker failed for tenant', { tenant_id: item.id, error_message: error.message });
      }
    }

    return { ok: true, processed: queued.length };
  } finally {
    workerRunning = false;
  }
}

function kickProvisioningWorker() {
  setImmediate(() => {
    processProvisioningQueue().catch((error) => {
      logger.error('Provisioning worker kickoff failed', { error_message: error.message });
    });
  });
}

function startProvisioningWorker() {
  if (workerTimer || String(process.env.PROVISIONING_WORKER_ENABLED || 'true').toLowerCase() === 'false') return;
  const intervalMs = Number(process.env.PROVISIONING_WORKER_INTERVAL_MS || 5000);
  workerTimer = setInterval(() => {
    processProvisioningQueue().catch((error) => {
      logger.error('Provisioning worker interval failed', { error_message: error.message });
    });
  }, intervalMs);
  if (typeof workerTimer.unref === 'function') workerTimer.unref();
  logger.info('Provisioning worker started', { interval_ms: intervalMs });
}

async function listProvisioningQueue() {
  const tenants = await prisma.tenant.findMany({
    where: { runtime_provision_status: { in: ['QUEUED', 'SYNC_PENDING', 'IN_PROGRESS', 'FAILED'] } },
    include: {
      owner: { select: { id: true, email: true, name: true } },
      config: true,
      subscriptions: { include: { plan: true }, orderBy: { created_at: 'desc' }, take: 1 }
    },
    orderBy: { updated_at: 'asc' }
  });

  return tenants.map((tenant) => ({
    id: tenant.id,
    display_name: tenant.display_name,
    lifecycle_status: tenant.lifecycle_status,
    onboarding_status: tenant.onboarding_status,
    runtime_provision_status: tenant.runtime_provision_status,
    runtime_company_id: tenant.runtime_company_id,
    runtime_owner_user_id: tenant.runtime_owner_user_id,
    runtime_last_synced_at: tenant.runtime_last_synced_at,
    owner: tenant.owner,
    latest_subscription: getLatestSubscription(tenant)
  }));
}

module.exports = {
  buildProvisioningVersion,
  queueProvisioning,
  runProvisioningJob,
  processProvisioningQueue,
  startProvisioningWorker,
  kickProvisioningWorker,
  listProvisioningQueue
};
