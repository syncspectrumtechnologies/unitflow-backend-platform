const prisma = require('../config/db');
const { createAudit } = require('./auditService');
const { activatePaidSubscription } = require('./subscriptionService');
const { consumeCouponRedemption } = require('./couponService');
const { rewardReferrerForSuccessfulPayment } = require('./referralService');
const { preparePaymentCheckout } = require('./paymentGatewayService');

function buildGatewayOrderRef(payment) {
  const paymentId = String(payment?.id || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return `UF${paymentId.slice(0, 24) || Date.now().toString(36).toUpperCase()}`;
}

async function prepareCheckoutResponse({ payment, tenant, account, gatewayMode }) {
  const paymentWithGatewayRef = payment.gateway_order_ref
    ? payment
    : await prisma.payment.update({
        where: { id: payment.id },
        data: { gateway_order_ref: buildGatewayOrderRef(payment) }
      });

  const checkoutData = await preparePaymentCheckout({
    payment: paymentWithGatewayRef,
    tenant,
    account,
    gatewayMode
  });

  const updatedPayment = await prisma.payment.update({
    where: { id: payment.id },
    data: {
      gateway: checkoutData.gateway,
      gateway_mode: checkoutData.gateway_mode,
      gateway_status: checkoutData.gateway_status,
      gateway_order_ref: checkoutData.gateway_order_ref || paymentWithGatewayRef.gateway_order_ref,
      gateway_request_id: checkoutData.gateway_request_id || undefined,
      checkout_payload_json: checkoutData.checkout_payload_json || undefined
    }
  });

  return { payment: updatedPayment, checkout: checkoutData.checkout_payload_json };
}

async function finalizeSuccessfulPayment({ tenant, plan, billingCycle, payment, metadata = {} }) {
  const subscription = await activatePaidSubscription({
    tenant,
    plan,
    billingCycle,
    payment
  });
  await consumeCouponRedemption({
    payment,
    accountId: tenant.owner_account_id,
    tenantId: tenant.id
  });
  await rewardReferrerForSuccessfulPayment({ tenant, payment });
  await createAudit({
    actorType: 'SYSTEM',
    tenantId: tenant.id,
    entityType: 'payment',
    entityId: payment.id,
    action: 'payment.succeeded',
    metadata: {
      subscription_id: subscription.id,
      ...metadata
    }
  });

  return subscription;
}

async function completeSuccessfulCheckout({ tenant, plan, billingCycle, payment, metadata = {} }) {
  const now = new Date();
  const referencePrefix = metadata.payment_reference_prefix || 'AUTO';
  const receiptRef = payment.invoice_ref || `UF-${String(payment.id).replace(/[^a-zA-Z0-9]/g, '').slice(-10).toUpperCase()}`;
  const succeededPayment = await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: 'SUCCEEDED',
      paid_at: now,
      gateway_status: 'SUCCEEDED',
      gateway_payment_ref: payment.gateway_payment_ref || `${referencePrefix}-${String(payment.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 28)}`,
      invoice_ref: receiptRef,
      metadata_json: {
        ...(payment.metadata_json || {}),
        ...(metadata.payment_metadata || {})
      },
      audit_trail_json: {
        ...(payment.audit_trail_json || {}),
        succeeded_at: now.toISOString(),
        ...(metadata.audit_trail || {})
      }
    }
  });

  const subscription = await finalizeSuccessfulPayment({
    tenant,
    plan,
    billingCycle,
    payment: succeededPayment,
    metadata
  });

  return { payment: succeededPayment, subscription };
}

module.exports = {
  prepareCheckoutResponse,
  finalizeSuccessfulPayment,
  completeSuccessfulCheckout
};
