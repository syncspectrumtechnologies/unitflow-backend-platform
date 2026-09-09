function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function paymentPlan(payment) {
  const metadata = jsonObject(payment.metadata_json);
  return payment.subscription?.plan?.code || metadata.plan_code || null;
}

function paymentBillingCycle(payment) {
  const metadata = jsonObject(payment.metadata_json);
  return payment.subscription?.billing_cycle || metadata.billing_cycle || null;
}

function serializePayment(payment, options = {}) {
  const metadata = jsonObject(payment.metadata_json);
  const auditTrail = jsonObject(payment.audit_trail_json);
  const plan = payment.subscription?.plan || null;
  const succeeded = payment.status === 'SUCCEEDED';
  const receiptNumber = payment.invoice_ref || payment.gateway_payment_ref || (succeeded ? `UF-${String(payment.id || '').slice(-8).toUpperCase()}` : null);

  return {
    id: payment.id,
    tenant_id: payment.tenant_id,
    tenant_name: payment.tenant?.display_name || payment.tenant?.legal_name || payment.tenant?.slug || null,
    subscription_id: payment.subscription_id || null,
    plan_code: paymentPlan(payment),
    plan_name: plan?.name || null,
    billing_cycle: paymentBillingCycle(payment),
    coupon: payment.coupon ? {
      id: payment.coupon.id,
      code: payment.coupon.code,
      name: payment.coupon.name,
      discount_type: payment.coupon.discount_type
    } : null,
    gateway: payment.gateway || null,
    gateway_mode: payment.gateway_mode || null,
    status: payment.status,
    original_amount_minor: payment.original_amount_minor,
    discount_minor: payment.discount_minor || 0,
    amount_minor: payment.amount_minor,
    currency: payment.currency,
    invoice_ref: payment.invoice_ref || null,
    receipt_number: receiptNumber,
    receipt_url: payment.receipt_url || null,
    paid_at: payment.paid_at,
    created_at: payment.created_at,
    updated_at: payment.updated_at,
    timeline: [
      { label: 'Checkout created', at: payment.created_at, done: Boolean(payment.created_at) },
      { label: 'Payment succeeded', at: payment.paid_at, done: succeeded },
      { label: 'Subscription activated', at: payment.subscription?.started_at || payment.paid_at, done: succeeded && Boolean(payment.subscription_id) }
    ],
    demo_checkout: Boolean(metadata.demo_checkout || auditTrail.demo_checkout),
    zero_amount_checkout: Boolean(auditTrail.zero_amount_checkout),
    can_demo_complete: Boolean(
      options.demoCheckoutEnabled &&
      payment.status === 'PENDING' &&
      paymentPlan(payment) &&
      paymentBillingCycle(payment)
    )
  };
}

function summarizePayments(payments, options = {}) {
  const serialized = payments.map((payment) => serializePayment(payment, options));
  const byStatus = {};
  const totals = {
    succeeded_amount_minor: 0,
    pending_amount_minor: 0,
    failed_amount_minor: 0,
    refunded_amount_minor: 0
  };

  for (const payment of serialized) {
    const status = payment.status || 'UNKNOWN';
    byStatus[status] = {
      count: (byStatus[status]?.count || 0) + 1,
      amount_minor: (byStatus[status]?.amount_minor || 0) + Number(payment.amount_minor || 0)
    };
    if (status === 'SUCCEEDED') totals.succeeded_amount_minor += Number(payment.amount_minor || 0);
    if (status === 'PENDING') totals.pending_amount_minor += Number(payment.amount_minor || 0);
    if (status === 'FAILED') totals.failed_amount_minor += Number(payment.amount_minor || 0);
    if (status === 'REFUNDED') totals.refunded_amount_minor += Number(payment.amount_minor || 0);
  }

  return {
    payments: serialized,
    by_status: byStatus,
    totals,
    pending_count: byStatus.PENDING?.count || 0,
    succeeded_count: byStatus.SUCCEEDED?.count || 0,
    failed_count: byStatus.FAILED?.count || 0,
    refunded_count: byStatus.REFUNDED?.count || 0
  };
}

module.exports = { paymentBillingCycle, paymentPlan, serializePayment, summarizePayments };
