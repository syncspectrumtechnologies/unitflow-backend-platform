const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { env } = require('../config/env');
const { getPlanByCode, listActivePlans } = require('../services/planService');
const { createCheckoutPayment } = require('../services/subscriptionService');
const { createAudit } = require('../services/auditService');
const { validateCouponForCheckout } = require('../services/couponService');
const {
  fetchRazorpayPayment,
  isZeroAmountCheckout,
  normalizeExternalPaymentStatus,
  resolveGatewayMode,
  verifyRazorpayOrderSignature,
  verifyRazorpayWebhookSignature
} = require('../services/paymentGatewayService');
const { prepareCheckoutResponse, finalizeSuccessfulPayment, completeSuccessfulCheckout } = require('../services/checkoutService');
const { allowedCurrencies, detectCountry, detectCurrency, planPriceMinor, serializePlanPrice } = require('../services/pricingService');
const { paymentBillingCycle, paymentPlan, serializePayment, summarizePayments } = require('../utils/billingSerializer');

const PAYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function selectAccountPayment(paymentId, accountId) {
  return prisma.payment.findFirst({
    where: {
      ...(paymentId ? { id: paymentId } : {}),
      tenant: { owner_account_id: accountId }
    },
    include: {
      tenant: true,
      subscription: { include: { plan: true } },
      coupon: { select: { id: true, code: true, name: true, discount_type: true } }
    },
    orderBy: paymentId ? undefined : { created_at: 'desc' }
  });
}

function listAccountPayments(accountId) {
  return prisma.payment.findMany({
    where: { tenant: { owner_account_id: accountId } },
    include: {
      tenant: { select: { id: true, display_name: true, legal_name: true, slug: true } },
      subscription: { include: { plan: true } },
      coupon: { select: { id: true, code: true, name: true, discount_type: true } }
    },
    orderBy: { created_at: 'desc' }
  });
}

function daysUntil(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.ceil((date.getTime() - Date.now()) / DAY_MS);
}

function isRuntimeReady(tenant) {
  return Boolean(tenant?.runtime_company_id) && ['READY', 'SYNC_PENDING'].includes(String(tenant?.runtime_provision_status || ''));
}

function planLabel(subscription) {
  const plan = subscription?.plan || {};
  const snapshot = subscription?.plan_snapshot_json || {};
  return plan.name || snapshot.name || plan.code || snapshot.code || null;
}

function buildAccessHealthRow(tenant) {
  const subscription = tenant.subscriptions?.[0] || null;
  const pendingPayment = tenant.payments?.[0] || null;
  const status = subscription?.status || null;
  const runtimeReady = isRuntimeReady(tenant);
  const accessAllowed = runtimeReady && ['ACTIVE', 'GRACE'].includes(String(tenant.lifecycle_status || '')) && ['ACTIVE', 'GRACE'].includes(String(status || ''));
  const relevantDate = status === 'GRACE'
    ? subscription?.grace_until || subscription?.ends_at
    : subscription?.renews_at || subscription?.ends_at || tenant.trial_ends_at;
  const remainingDays = daysUntil(relevantDate);

  let severity = 'OK';
  let action = accessAllowed ? 'No action needed' : 'Complete setup';
  let reason = null;

  if (!runtimeReady) {
    severity = 'BLOCKED';
    action = tenant.runtime_provision_status === 'FAILED' ? 'Retry provisioning' : 'Wait for provisioning';
    reason = 'Runtime provisioning is not ready';
  } else if (!subscription) {
    severity = 'BLOCKED';
    action = pendingPayment ? 'Complete pending payment' : 'Choose a plan';
    reason = 'No active subscription found';
  } else if (!['ACTIVE', 'GRACE'].includes(String(status || ''))) {
    severity = 'BLOCKED';
    action = pendingPayment ? 'Complete pending payment' : 'Renew plan';
    reason = 'Subscription is not active';
  } else if (String(status) === 'GRACE' || (remainingDays !== null && remainingDays < 0)) {
    severity = 'DANGER';
    action = pendingPayment ? 'Complete pending payment' : 'Renew now';
    reason = 'Workspace is in grace period';
  } else if (pendingPayment || (remainingDays !== null && remainingDays <= 7)) {
    severity = 'WARN';
    action = pendingPayment ? 'Complete pending payment' : 'Renew soon';
    reason = pendingPayment ? 'Pending payment exists' : 'Renewal is due soon';
  }

  return {
    tenant_id: tenant.id,
    tenant_name: tenant.display_name || tenant.legal_name || tenant.slug,
    lifecycle_status: tenant.lifecycle_status,
    runtime_provision_status: tenant.runtime_provision_status,
    runtime_access_ready: runtimeReady,
    access_allowed: accessAllowed,
    severity,
    reason,
    action,
    plan: subscription ? {
      id: subscription.id,
      name: planLabel(subscription),
      code: subscription.plan?.code || subscription.plan_snapshot_json?.code || null,
      type: subscription.plan?.plan_type || subscription.plan_snapshot_json?.plan_type || null,
      billing_cycle: subscription.billing_cycle,
      status: subscription.status,
      seat_limit: subscription.seat_limit,
      renews_at: subscription.renews_at,
      ends_at: subscription.ends_at,
      grace_until: subscription.grace_until,
      days_until_action: remainingDays
    } : null,
    pending_payment: pendingPayment ? serializePayment(pendingPayment) : null
  };
}

function validateGatewayMatch(payment, gatewayEntity = {}) {
  const orderId = gatewayEntity.order_id || gatewayEntity.id;
  if (orderId && payment.gateway_order_ref && String(orderId) !== String(payment.gateway_order_ref)) {
    throw httpError(400, 'Payment order mismatch');
  }
  if (Number(gatewayEntity.amount) !== Number(payment.amount_minor)) {
    throw httpError(400, 'Payment amount mismatch');
  }
  if (String(gatewayEntity.currency || '').toUpperCase() !== String(payment.currency || '').toUpperCase()) {
    throw httpError(400, 'Payment currency mismatch');
  }
}

async function settleVerifiedPayment({ payment, gatewayEntity, source }) {
  if (payment.status === 'SUCCEEDED') {
    if (payment.subscription_id && payment.subscription) {
      return { payment, subscription: payment.subscription, already_completed: true };
    }

    validateGatewayMatch(payment, gatewayEntity);
    const normalizedStatus = normalizeExternalPaymentStatus({ razorpay: gatewayEntity });
    if (normalizedStatus !== 'SUCCEEDED') throw httpError(409, 'Payment is not captured yet');

    const planCode = paymentPlan(payment);
    const billingCycle = String(paymentBillingCycle(payment) || '').toUpperCase();
    if (!planCode || !['MONTHLY', 'YEARLY'].includes(billingCycle)) {
      throw httpError(409, 'Payment is missing plan or billing cycle metadata');
    }
    const plan = await getPlanByCode(String(planCode).toUpperCase());
    if (!plan) throw httpError(404, 'Plan not found');

    const subscription = await finalizeSuccessfulPayment({
      tenant: payment.tenant,
      plan,
      billingCycle,
      payment,
      metadata: { source, recovered_completed_payment: true }
    });

    const recovered = await prisma.payment.findUnique({
      where: { id: payment.id },
      include: {
        tenant: true,
        subscription: { include: { plan: true } },
        coupon: { select: { id: true, code: true, name: true, discount_type: true } }
      }
    });
    return { payment: recovered || payment, subscription, already_completed: true };
  }
  if (payment.status !== 'PENDING') throw httpError(409, `Payment cannot be completed from ${payment.status}`);

  validateGatewayMatch(payment, gatewayEntity);
  const normalizedStatus = normalizeExternalPaymentStatus({ razorpay: gatewayEntity });
  if (normalizedStatus !== 'SUCCEEDED') throw httpError(409, 'Payment is not captured yet');

  const planCode = paymentPlan(payment);
  const billingCycle = String(paymentBillingCycle(payment) || '').toUpperCase();
  if (!planCode || !['MONTHLY', 'YEARLY'].includes(billingCycle)) {
    throw httpError(409, 'Payment is missing plan or billing cycle metadata');
  }
  const plan = await getPlanByCode(String(planCode).toUpperCase());
  if (!plan) throw httpError(404, 'Plan not found');

  const now = new Date();
  const result = await prisma.payment.updateMany({
    where: { id: payment.id, status: 'PENDING' },
    data: {
      status: 'SUCCEEDED',
      paid_at: now,
      gateway: 'razorpay',
      gateway_mode: 'RAZORPAY',
      gateway_status: gatewayEntity.status || 'captured',
      gateway_payment_ref: gatewayEntity.payment_id || (String(gatewayEntity.id || '').startsWith('pay_') ? gatewayEntity.id : payment.gateway_payment_ref),
      invoice_ref: payment.invoice_ref || `UF-${String(payment.id).replace(/[^a-zA-Z0-9]/g, '').slice(-10).toUpperCase()}`,
      receipt_url: gatewayEntity.receipt || payment.receipt_url,
      metadata_json: {
        ...(payment.metadata_json || {}),
        razorpay_order_id: gatewayEntity.order_id || gatewayEntity.id || payment.gateway_order_ref,
        razorpay_payment_id: gatewayEntity.payment_id || gatewayEntity.id || null,
        razorpay_method: gatewayEntity.method || null
      },
      audit_trail_json: {
        ...(payment.audit_trail_json || {}),
        succeeded_at: now.toISOString(),
        verified_by: source
      }
    }
  });

  const updated = await prisma.payment.findUnique({
    where: { id: payment.id },
    include: {
      tenant: true,
      subscription: { include: { plan: true } },
      coupon: { select: { id: true, code: true, name: true, discount_type: true } }
    }
  });

  if (result.count === 0) {
    if (updated?.status === 'SUCCEEDED') return { payment: updated, subscription: updated.subscription || null, already_completed: true };
    throw httpError(409, `Payment cannot be completed from ${updated?.status || payment.status}`);
  }

  const subscription = await finalizeSuccessfulPayment({
    tenant: updated.tenant,
    plan,
    billingCycle,
    payment: updated,
    metadata: { webhook_gateway: 'razorpay', source }
  });

  const refreshed = await prisma.payment.findUnique({
    where: { id: payment.id },
    include: {
      tenant: true,
      subscription: { include: { plan: true } },
      coupon: { select: { id: true, code: true, name: true, discount_type: true } }
    }
  });
  return { payment: refreshed || updated, subscription, already_completed: false };
}

exports.listPlans = async (req, res, next) => {
  try {
    const plans = await listActivePlans();
    const currency = detectCurrency(req);
    res.json({
      ok: true,
      currency,
      country: detectCountry(req),
      supported_currencies: allowedCurrencies(),
      plans: plans.map((plan) => serializePlanPrice(plan, currency))
    });
  } catch (error) { next(error); }
};

exports.createCheckoutIntent = async (req, res, next) => {
  try {
    const { tenant_id, plan_code, billing_cycle, coupon_code, gateway_mode } = req.body || {};
    if (!tenant_id || !plan_code || !billing_cycle) throw httpError(400, 'tenant_id, plan_code, billing_cycle are required');
    const tenant = await prisma.tenant.findFirst({
      where: { id: tenant_id, owner_account_id: req.account.id },
      include: {
        config: true,
        subscriptions: { where: { status: { in: ['ACTIVE', 'GRACE'] } }, take: 1 }
      }
    });
    if (!tenant) throw httpError(404, 'Tenant not found');

    const normalizedBillingCycle = String(billing_cycle).toUpperCase();
    if (!['MONTHLY', 'YEARLY'].includes(normalizedBillingCycle)) throw httpError(400, 'billing_cycle must be MONTHLY or YEARLY');

    const plan = await getPlanByCode(String(plan_code).toUpperCase());
    if (!plan) throw httpError(404, 'Plan not found');
    const currency = detectCurrency(req);
    const baseAmountMinor = planPriceMinor(plan, normalizedBillingCycle, currency);

    const payment = await createCheckoutPayment(prisma, {
      tenantId: tenant_id,
      accountId: req.account.id,
      plan,
      billingCycle: normalizedBillingCycle,
      currency,
      baseAmountMinor,
      metadata: {
        source: 'checkout_intent',
        country: detectCountry(req),
        base_currency: env.defaultCurrency
      },
      couponCode: coupon_code,
      gatewayMode: resolveGatewayMode(gateway_mode)
    });
    const { payment: preparedPayment, checkout } = await prepareCheckoutResponse({
      payment,
      tenant,
      account: req.account,
      gatewayMode: gateway_mode
    });

    const shouldCompleteImmediately = isZeroAmountCheckout(preparedPayment);
    if (shouldCompleteImmediately) {
      const { payment: succeededPayment, subscription } = await completeSuccessfulCheckout({
        tenant,
        plan,
        billingCycle: normalizedBillingCycle,
        payment: preparedPayment,
        metadata: {
          zero_amount_checkout: true,
          payment_reference_prefix: 'ZERO',
          audit_trail: { zero_amount_checkout: true }
        }
      });
      return res.status(201).json({
        ok: true,
        message: 'Checkout completed with zero payable amount. Your plan is active and workspace provisioning has been queued.',
        payment_id: succeededPayment.id,
        amount_minor: succeededPayment.amount_minor,
        currency: succeededPayment.currency,
        status: succeededPayment.status,
        plan_code: plan.code,
        billing_cycle: normalizedBillingCycle,
        checkout,
        auto_activated: true,
        demo_checkout: false,
        provisioning: 'queued',
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
  next(httpError(410, 'Legacy payment webhook is disabled; use the Razorpay webhook endpoint'));
};

exports.verifyRazorpayCheckout = async (req, res, next) => {
  try {
    const paymentId = String(req.body?.payment_id || '').trim();
    const razorpayOrderId = String(req.body?.razorpay_order_id || '').trim();
    const razorpayPaymentId = String(req.body?.razorpay_payment_id || '').trim();
    const razorpaySignature = String(req.body?.razorpay_signature || '').trim();
    if (!PAYMENT_ID_PATTERN.test(paymentId) || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      throw httpError(400, 'payment_id, razorpay_order_id, razorpay_payment_id, and razorpay_signature are required');
    }

    const payment = await selectAccountPayment(paymentId, req.account.id);
    if (!payment) throw httpError(404, 'Payment not found');
    if (String(payment.gateway || '').toLowerCase() !== 'razorpay') throw httpError(409, 'Payment was not created for Razorpay');
    if (String(payment.gateway_order_ref || '') !== razorpayOrderId) throw httpError(400, 'Payment order mismatch');
    if (!verifyRazorpayOrderSignature({ orderId: razorpayOrderId, paymentId: razorpayPaymentId, signature: razorpaySignature })) {
      throw httpError(401, 'Invalid payment signature');
    }

    const gatewayPayment = await fetchRazorpayPayment(razorpayPaymentId);
    if (String(gatewayPayment?.status || '').toLowerCase() !== 'captured') {
      throw httpError(409, 'Payment is not captured yet');
    }

    const { payment: settledPayment, subscription, already_completed } = await settleVerifiedPayment({
      payment,
      gatewayEntity: gatewayPayment,
      source: 'checkout_signature'
    });

    res.json({
      ok: true,
      message: already_completed ? 'Payment was already verified.' : 'Payment verified. Your subscription is active.',
      payment: serializePayment(settledPayment),
      subscription_id: subscription?.id || settledPayment.subscription_id || null,
      provisioning: already_completed ? undefined : 'queued'
    });
  } catch (error) { next(error); }
};

exports.razorpayWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    if (!verifyRazorpayWebhookSignature(req.rawBody, signature)) throw httpError(401, 'Invalid webhook signature');

    const event = req.body || {};
    const eventName = String(event.event || '').toLowerCase();
    const paymentEntity = event.payload?.payment?.entity || null;
    const orderEntity = event.payload?.order?.entity || null;
    const gatewayPaymentId = paymentEntity?.id || null;
    const gatewayOrderId = paymentEntity?.order_id || orderEntity?.id || null;
    if (!gatewayOrderId && !gatewayPaymentId) return res.json({ ok: true, ignored: true });

    const or = [];
    if (gatewayOrderId) or.push({ gateway_order_ref: gatewayOrderId });
    if (gatewayPaymentId) or.push({ gateway_payment_ref: gatewayPaymentId });
    const payment = await prisma.payment.findFirst({
      where: { OR: or },
      include: {
        tenant: true,
        subscription: { include: { plan: true } },
        coupon: { select: { id: true, code: true, name: true, discount_type: true } }
      }
    });
    if (!payment) return res.json({ ok: true, ignored: true });

    if (eventName === 'payment.failed') {
      const updated = await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: payment.status === 'PENDING' ? 'FAILED' : payment.status,
          gateway_status: paymentEntity?.status || 'failed',
          gateway_payment_ref: gatewayPaymentId || payment.gateway_payment_ref,
          audit_trail_json: {
            ...(payment.audit_trail_json || {}),
            last_webhook_at: new Date().toISOString(),
            webhook_event: eventName
          }
        }
      });
      await createAudit({
        actorType: 'SYSTEM',
        tenantId: payment.tenant_id,
        entityType: 'payment',
        entityId: payment.id,
        action: 'payment.failed',
        metadata: { event: eventName, status: updated.status }
      });
      return res.json({ ok: true });
    }

    const entity = paymentEntity || orderEntity;
    const succeeded = eventName === 'payment.captured' || eventName === 'order.paid' || ['captured', 'paid'].includes(String(entity?.status || '').toLowerCase());
    if (!succeeded) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          gateway_status: entity?.status || eventName,
          audit_trail_json: {
            ...(payment.audit_trail_json || {}),
            last_webhook_at: new Date().toISOString(),
            webhook_event: eventName
          }
        }
      });
      return res.json({ ok: true, pending: true });
    }

    const { subscription } = await settleVerifiedPayment({
      payment,
      gatewayEntity: {
        ...entity,
        id: gatewayPaymentId || entity.id,
        payment_id: gatewayPaymentId,
        order_id: gatewayOrderId || entity.order_id || entity.id,
        status: paymentEntity ? paymentEntity.status : 'paid'
      },
      source: 'razorpay_webhook'
    });

    res.json({ ok: true, provisioning: 'queued', subscription_id: subscription?.id || null });
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
    if (!['MONTHLY', 'YEARLY'].includes(normalizedBillingCycle)) throw httpError(400, 'billing_cycle must be MONTHLY or YEARLY');
    const plan = await getPlanByCode(String(plan_code).toUpperCase());
    if (!plan) throw httpError(404, 'Plan not found');
    const currency = detectCurrency(req);
    const baseAmountMinor = planPriceMinor(plan, normalizedBillingCycle, currency);

    const { coupon, pricing } = await validateCouponForCheckout({
      accountId: req.account.id,
      tenantId: tenant.id,
      plan,
      couponCode: coupon_code,
      baseAmountMinor,
      currency
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
    const payments = await listAccountPayments(req.account.id);
    res.json({
      ok: true,
      payments: payments.map((payment) => serializePayment(payment))
    });
  } catch (error) { next(error); }
};

exports.getBillingSummary = async (req, res, next) => {
  try {
    const [payments, tenantCount, activeSubscriptionCount] = await Promise.all([
      listAccountPayments(req.account.id),
      prisma.tenant.count({ where: { owner_account_id: req.account.id } }),
      prisma.tenantSubscription.count({
        where: {
          status: { in: ['ACTIVE', 'GRACE'] },
          tenant: { owner_account_id: req.account.id }
        }
      })
    ]);
    const summary = summarizePayments(payments);
    res.json({
      ok: true,
      demo_checkout_enabled: false,
      tenant_count: tenantCount,
      active_subscription_count: activeSubscriptionCount,
      billing: {
        ...summary,
        payments: summary.payments.slice(0, 10),
        pending_payments: summary.payments.filter((payment) => payment.status === 'PENDING').slice(0, 10)
      }
    });
  } catch (error) { next(error); }
};

exports.getAccessHealth = async (req, res, next) => {
  try {
    const tenants = await prisma.tenant.findMany({
      where: { owner_account_id: req.account.id },
      include: {
        subscriptions: { include: { plan: true }, orderBy: { created_at: 'desc' }, take: 1 },
        payments: {
          where: { status: 'PENDING' },
          include: {
            tenant: { select: { id: true, display_name: true, legal_name: true, slug: true } },
            subscription: { include: { plan: true } },
            coupon: { select: { id: true, code: true, name: true, discount_type: true } }
          },
          orderBy: { created_at: 'desc' },
          take: 1
        }
      },
      orderBy: { updated_at: 'desc' }
    });

    const items = tenants.map(buildAccessHealthRow);
    const summary = items.reduce((acc, item) => {
      acc.total += 1;
      if (item.access_allowed) acc.access_allowed += 1;
      if (item.severity === 'BLOCKED') acc.blocked += 1;
      if (item.severity === 'DANGER') acc.danger += 1;
      if (item.severity === 'WARN') acc.warn += 1;
      if (item.pending_payment) acc.pending_payment += 1;
      return acc;
    }, { total: 0, access_allowed: 0, blocked: 0, danger: 0, warn: 0, pending_payment: 0 });

    res.json({ ok: true, summary, items });
  } catch (error) { next(error); }
};

exports.completeDemoPayment = async (req, res, next) => {
  next(httpError(410, 'Demo payment completion is disabled'));
};
