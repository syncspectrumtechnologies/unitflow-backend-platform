const prisma = require('../config/db');
const { syncTenantStatus } = require('./coreSyncService');
const { createAudit } = require('./auditService');
const { createNotification } = require('./notificationService');
const { queueProvisioning, kickProvisioningWorker } = require('./provisioningService');
const { revokeTenantRuntimeAccess } = require('./runtimeAccessService');

function computeRenewalDate(baseDate, billingCycle) {
  const date = new Date(baseDate);
  if (billingCycle === 'YEARLY') {
    date.setFullYear(date.getFullYear() + 1);
  } else {
    date.setMonth(date.getMonth() + 1);
  }
  return date;
}

async function createCheckoutPayment(db, { tenantId, accountId, plan, billingCycle, currency = 'INR', metadata = null }) {
  const amountMinor = billingCycle === 'YEARLY' ? plan.yearly_price_minor : plan.monthly_price_minor;

  return db.payment.create({
    data: {
      tenant_id: tenantId,
      amount_minor: amountMinor,
      currency,
      status: 'PENDING',
      gateway: 'manual-test-gateway',
      metadata_json: {
        plan_code: plan.code,
        plan_type: plan.plan_type,
        billing_cycle: billingCycle,
        account_id: accountId,
        ...(metadata || {})
      },
      audit_trail_json: {
        created_at: new Date().toISOString(),
        source: 'checkout_intent'
      }
    }
  });
}

async function activatePaidSubscription({ tenant, plan, billingCycle, payment }) {
  if (payment?.subscription_id) {
    const existing = await prisma.tenantSubscription.findUnique({ where: { id: payment.subscription_id }, include: { plan: true } });
    if (existing) return existing;
  }

  const normalizedBillingCycle = String(billingCycle).toUpperCase();
  const now = new Date();
  const renewsAt = computeRenewalDate(now, normalizedBillingCycle);
  const runtimeWasReady = tenant.runtime_provision_status === 'READY' && Boolean(tenant.runtime_company_id);

  const subscription = await prisma.$transaction(async (tx) => {
    await tx.tenantSubscription.updateMany({
      where: { tenant_id: tenant.id, status: { in: ['ACTIVE', 'GRACE'] } },
      data: { status: 'CANCELLED', cancelled_at: now }
    });

    const created = await tx.tenantSubscription.create({
      data: {
        tenant_id: tenant.id,
        plan_id: plan.id,
        billing_cycle: normalizedBillingCycle,
        status: 'ACTIVE',
        seat_limit: plan.seat_limit,
        plan_snapshot_json: {
          code: plan.code,
          name: plan.name,
          plan_type: plan.plan_type,
          monthly_price_minor: plan.monthly_price_minor,
          yearly_price_minor: plan.yearly_price_minor,
          feature_limits_json: plan.feature_limits_json
        },
        started_at: now,
        renews_at: renewsAt,
        ends_at: renewsAt
      }
    });

    if (payment?.id) {
      await tx.payment.update({ where: { id: payment.id }, data: { subscription_id: created.id } });
    }

    await tx.tenant.update({
      where: { id: tenant.id },
      data: {
        lifecycle_status: runtimeWasReady ? 'ACTIVE' : 'SUSPENDED',
        onboarding_status: 'PROVISIONING',
        runtime_provision_status: runtimeWasReady ? 'SYNC_PENDING' : 'QUEUED'
      }
    });

    return created;
  });

  await queueProvisioning({ tenantId: tenant.id, reason: runtimeWasReady ? 'subscription_sync' : 'initial_paid_activation', actorType: 'SYSTEM' });
  kickProvisioningWorker();

  await createAudit({
    actorType: 'SYSTEM',
    tenantId: tenant.id,
    entityType: 'tenant_subscription',
    entityId: subscription.id,
    action: 'subscription.activated',
    metadata: {
      plan_code: plan.code,
      billing_cycle: normalizedBillingCycle,
      runtime_sync_required: true
    }
  });

  await createNotification({
    tenantId: tenant.id,
    accountId: tenant.owner_account_id,
    type: 'subscription.activated',
    title: 'Subscription activated',
    body: runtimeWasReady
      ? `${plan.name} (${normalizedBillingCycle.toLowerCase()}) is active and sync is queued.`
      : `${plan.name} (${normalizedBillingCycle.toLowerCase()}) payment is confirmed. Workspace provisioning is now in progress.`
  });

  return subscription;
}

async function applyLifecycleMaintenance() {
  const now = new Date();
  const subscriptions = await prisma.tenantSubscription.findMany({
    where: { status: { in: ['ACTIVE', 'GRACE'] } },
    include: { tenant: true, plan: true }
  });

  for (const sub of subscriptions) {
    if (sub.status === 'ACTIVE' && sub.renews_at && sub.renews_at < now) {
      await prisma.tenantSubscription.update({
        where: { id: sub.id },
        data: { status: 'GRACE', grace_until: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) }
      });
      await prisma.tenant.update({ where: { id: sub.tenant_id }, data: { lifecycle_status: 'GRACE' } });
      await syncTenantStatus(sub.tenant_id, { is_active: true, subscription_status: 'grace' });
    }

    if (sub.status === 'GRACE' && sub.grace_until && sub.grace_until < now) {
      await prisma.tenantSubscription.update({ where: { id: sub.id }, data: { status: 'EXPIRED' } });
      await prisma.tenant.update({ where: { id: sub.tenant_id }, data: { lifecycle_status: 'SUSPENDED' } });
      await revokeTenantRuntimeAccess(sub.tenant_id, 'subscription_expired');
      await syncTenantStatus(sub.tenant_id, { is_active: false, subscription_status: 'expired' });
    }
  }
}

module.exports = { createCheckoutPayment, activatePaidSubscription, applyLifecycleMaintenance };
