const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { env } = require('../config/env');
const { getPlanByCode, listActivePlans } = require('../services/planService');
const { activatePaidSubscription, createCheckoutPayment } = require('../services/subscriptionService');
const { createAudit } = require('../services/auditService');

exports.listPlans = async (req, res, next) => {
  try {
    const plans = await listActivePlans();
    res.json({
      ok: true,
      currency: env.defaultCurrency,
      plans: plans.map((plan) => ({
        id: plan.id,
        code: plan.code,
        name: plan.name,
        description: plan.description,
        plan_type: plan.plan_type,
        seat_limit: plan.seat_limit,
        monthly_price_minor: plan.monthly_price_minor,
        yearly_price_minor: plan.yearly_price_minor,
        feature_limits_json: plan.feature_limits_json
      }))
    });
  } catch (error) { next(error); }
};

exports.createCheckoutIntent = async (req, res, next) => {
  try {
    const { tenant_id, plan_code, billing_cycle } = req.body || {};
    if (!tenant_id || !plan_code || !billing_cycle) throw httpError(400, 'tenant_id, plan_code, billing_cycle are required');
    const tenant = await prisma.tenant.findFirst({
      where: { id: tenant_id, owner_account_id: req.account.id },
      include: { subscriptions: { where: { status: { in: ['ACTIVE', 'GRACE'] } }, take: 1 } }
    });
    if (!tenant) throw httpError(404, 'Tenant not found');

    const normalizedBillingCycle = String(billing_cycle).toUpperCase();
    if (!['MONTHLY', 'YEARLY'].includes(normalizedBillingCycle)) throw httpError(400, 'billing_cycle must be MONTHLY or YEARLY');

    const plan = await getPlanByCode(String(plan_code).toUpperCase());
    if (!plan) throw httpError(404, 'Plan not found');

    const payment = await createCheckoutPayment(prisma, {
      tenantId: tenant_id,
      accountId: req.account.id,
      plan,
      billingCycle: normalizedBillingCycle,
      currency: env.defaultCurrency,
      metadata: { source: 'checkout_intent' }
    });

    res.status(201).json({ ok: true, payment_id: payment.id, amount_minor: payment.amount_minor, currency: payment.currency, plan_code: plan.code, billing_cycle: normalizedBillingCycle });
  } catch (error) { next(error); }
};

exports.paymentWebhook = async (req, res, next) => {
  try {
    const secret = req.headers['x-payment-webhook-secret'];
    if (!secret || secret !== env.paymentWebhookSecret) throw httpError(401, 'Invalid webhook secret');

    const { payment_id, tenant_id, plan_code, billing_cycle, gateway, gateway_order_ref, gateway_payment_ref, status, invoice_ref, receipt_url, metadata } = req.body || {};
    if (!payment_id || !tenant_id || !plan_code || !billing_cycle || !status) throw httpError(400, 'payment_id, tenant_id, plan_code, billing_cycle, status are required');

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenant_id },
      include: {
        owner: true,
        config: true,
        locations: true,
        subscriptions: { include: { plan: true }, orderBy: { created_at: 'desc' }, take: 1 }
      }
    });
    if (!tenant) throw httpError(404, 'Tenant not found');

    let payment = await prisma.payment.findUnique({ where: { id: payment_id } });
    if (!payment) throw httpError(404, 'Payment not found');

    payment = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        gateway,
        gateway_order_ref,
        gateway_payment_ref,
        status,
        invoice_ref,
        receipt_url,
        paid_at: status === 'SUCCEEDED' ? new Date() : null,
        metadata_json: metadata || payment.metadata_json || undefined,
        audit_trail_json: { last_webhook_at: new Date().toISOString(), status }
      }
    });

    if (status === 'SUCCEEDED') {
      const plan = await getPlanByCode(String(plan_code).toUpperCase());
      if (!plan) throw httpError(404, 'Plan not found');
      const sub = await activatePaidSubscription({ tenant, plan, billingCycle: String(billing_cycle).toUpperCase(), payment });
      await createAudit({ actorType: 'SYSTEM', tenantId: tenant.id, entityType: 'payment', entityId: payment.id, action: 'payment.succeeded', metadata: { subscription_id: sub.id } });
      res.json({ ok: true, provisioning: 'queued', subscription_id: sub.id });
      return;
    }

    await createAudit({ actorType: 'SYSTEM', tenantId: tenant.id, entityType: 'payment', entityId: payment.id, action: 'payment.updated', metadata: { status } });
    res.json({ ok: true });
  } catch (error) { next(error); }
};

exports.listPayments = async (req, res, next) => {
  try {
    const payments = await prisma.payment.findMany({
      where: { tenant: { owner_account_id: req.account.id } },
      orderBy: { created_at: 'desc' }
    });
    res.json({ ok: true, payments });
  } catch (error) { next(error); }
};
