const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { env } = require('../config/env');
const { getPlanByCode, listActivePlans } = require('../services/planService');
const { createCheckoutPayment } = require('../services/subscriptionService');
const { createAudit } = require('../services/auditService');
const { validateCouponForCheckout } = require('../services/couponService');
const { isZeroAmountCheckout, normalizeExternalPaymentStatus, resolveGatewayMode } = require('../services/paymentGatewayService');
const { prepareCheckoutResponse, finalizeSuccessfulPayment } = require('../services/checkoutService');

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
    const { tenant_id, plan_code, billing_cycle, coupon_code, gateway_mode } = req.body || {};
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
      metadata: { source: 'checkout_intent' },
      couponCode: coupon_code,
      gatewayMode: resolveGatewayMode(gateway_mode)
    });
    const { payment: preparedPayment, checkout } = await prepareCheckoutResponse({
      payment,
      tenant,
      account: req.account,
      gatewayMode: gateway_mode
    });

    if (isZeroAmountCheckout(preparedPayment)) {
      const succeededPayment = await prisma.payment.update({
        where: { id: preparedPayment.id },
        data: {
          status: 'SUCCEEDED',
          paid_at: new Date(),
          gateway_status: 'SUCCEEDED'
        }
      });
      const subscription = await finalizeSuccessfulPayment({
        tenant,
        plan,
        billingCycle: normalizedBillingCycle,
        payment: succeededPayment,
        metadata: { zero_amount_checkout: true }
      });
      return res.status(201).json({
        ok: true,
        payment_id: succeededPayment.id,
        amount_minor: succeededPayment.amount_minor,
        currency: succeededPayment.currency,
        plan_code: plan.code,
        billing_cycle: normalizedBillingCycle,
        checkout,
        auto_activated: true,
        subscription_id: subscription.id
      });
    }

    res.status(201).json({
      ok: true,
      payment_id: preparedPayment.id,
      amount_minor: preparedPayment.amount_minor,
      original_amount_minor: preparedPayment.original_amount_minor,
      discount_minor: preparedPayment.discount_minor,
      currency: preparedPayment.currency,
      plan_code: plan.code,
      billing_cycle: normalizedBillingCycle,
      coupon_code: coupon_code || null,
      gateway: preparedPayment.gateway,
      gateway_mode: preparedPayment.gateway_mode,
      checkout
    });
  } catch (error) { next(error); }
};

exports.paymentWebhook = async (req, res, next) => {
  try {
    const secret = req.headers['x-payment-webhook-secret'];
    if (!secret || secret !== env.paymentWebhookSecret) throw httpError(401, 'Invalid webhook secret');

    const {
      payment_id,
      tenant_id,
      plan_code,
      billing_cycle,
      gateway,
      gateway_order_ref,
      gateway_payment_ref,
      status,
      invoice_ref,
      receipt_url,
      metadata,
      paytm
    } = req.body || {};
    if (!payment_id || !tenant_id || !plan_code || !billing_cycle) throw httpError(400, 'payment_id, tenant_id, plan_code, billing_cycle are required');

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
    const normalizedStatus = normalizeExternalPaymentStatus({ gateway, status, paytm });

    payment = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        gateway: gateway?.toString().toLowerCase() || payment.gateway,
        gateway_order_ref,
        gateway_payment_ref,
        gateway_status: normalizedStatus,
        status: normalizedStatus,
        invoice_ref,
        receipt_url,
        paid_at: normalizedStatus === 'SUCCEEDED' ? new Date() : null,
        metadata_json: {
          ...(payment.metadata_json || {}),
          ...(metadata || {})
        },
        audit_trail_json: {
          ...(payment.audit_trail_json || {}),
          last_webhook_at: new Date().toISOString(),
          status: normalizedStatus,
          paytm: paytm || undefined
        }
      }
    });

    if (normalizedStatus === 'SUCCEEDED') {
      const plan = await getPlanByCode(String(plan_code).toUpperCase());
      if (!plan) throw httpError(404, 'Plan not found');
      const sub = await finalizeSuccessfulPayment({
        tenant,
        plan,
        billingCycle: String(billing_cycle).toUpperCase(),
        payment,
        metadata: {
          webhook_gateway: gateway || payment.gateway
        }
      });
      res.json({ ok: true, provisioning: 'queued', subscription_id: sub.id });
      return;
    }

    await createAudit({
      actorType: 'SYSTEM',
      tenantId: tenant.id,
      entityType: 'payment',
      entityId: payment.id,
      action: 'payment.updated',
      metadata: { status: normalizedStatus, gateway: gateway || payment.gateway }
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
};

exports.validateCoupon = async (req, res, next) => {
  try {
    const { tenant_id, plan_code, billing_cycle, coupon_code } = req.body || {};
    if (!tenant_id || !plan_code || !billing_cycle || !coupon_code) {
      throw httpError(400, 'tenant_id, plan_code, billing_cycle, and coupon_code are required');
    }

    const tenant = await prisma.tenant.findFirst({
      where: { id: tenant_id, owner_account_id: req.account.id }
    });
    if (!tenant) throw httpError(404, 'Tenant not found');

    const normalizedBillingCycle = String(billing_cycle).toUpperCase();
    const plan = await getPlanByCode(String(plan_code).toUpperCase());
    if (!plan) throw httpError(404, 'Plan not found');

    const baseAmountMinor = normalizedBillingCycle === 'YEARLY' ? plan.yearly_price_minor : plan.monthly_price_minor;
    const { coupon, pricing } = await validateCouponForCheckout({
      accountId: req.account.id,
      tenantId: tenant.id,
      plan,
      couponCode: coupon_code,
      baseAmountMinor,
      currency: env.defaultCurrency
    });

    res.json({
      ok: true,
      coupon: coupon ? {
        id: coupon.id,
        code: coupon.code,
        name: coupon.name,
        description: coupon.description,
        discount_type: coupon.discount_type,
        amount_minor: coupon.amount_minor,
        percentage_off: coupon.percentage_off,
        max_discount_minor: coupon.max_discount_minor,
        first_payment_only: coupon.first_payment_only,
        expires_at: coupon.expires_at
      } : null,
      pricing,
      plan_code: plan.code,
      billing_cycle: normalizedBillingCycle
    });
  } catch (error) {
    next(error);
  }
};

exports.listPayments = async (req, res, next) => {
  try {
    const payments = await prisma.payment.findMany({
      where: { tenant: { owner_account_id: req.account.id } },
      include: {
        coupon: {
          select: { id: true, code: true, name: true, discount_type: true }
        }
      },
      orderBy: { created_at: 'desc' }
    });
    res.json({ ok: true, payments });
  } catch (error) { next(error); }
};
