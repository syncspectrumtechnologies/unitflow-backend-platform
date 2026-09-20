const crypto = require('crypto');
const axios = require('axios');
const { env } = require('../config/env');
const httpError = require('../utils/httpError');

function resolveGatewayMode() {
  return 'RAZORPAY';
}

function isZeroAmountCheckout(payment) {
  return Number(payment?.amount_minor || 0) <= 0;
}

function isRazorpayConfigured() {
  return Boolean(env.razorpayKeyId && env.razorpayKeySecret);
}

function razorpayClient() {
  if (!isRazorpayConfigured()) throw httpError(503, 'Payment gateway is not configured');
  return axios.create({
    baseURL: env.razorpayApiBaseUrl,
    timeout: 15000,
    auth: {
      username: env.razorpayKeyId,
      password: env.razorpayKeySecret
    },
    headers: { 'Content-Type': 'application/json' }
  });
}

function publicPolicyUrls() {
  const base = String(env.publicAppBaseUrl || '').replace(/\/+$/, '');
  return {
    terms_url: base ? `${base}/terms-and-conditions` : null,
    refund_policy_url: base ? `${base}/refund-policy` : null,
    privacy_policy_url: base ? `${base}/privacy-policy` : null
  };
}

function safeEqualHex(left, right) {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(value, secret = env.razorpayKeySecret) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function verifyRazorpayOrderSignature({ orderId, paymentId, signature }) {
  if (!orderId || !paymentId || !signature) return false;
  return safeEqualHex(sign(`${orderId}|${paymentId}`), signature);
}

function verifyRazorpayWebhookSignature(rawBody, signature) {
  if (!env.razorpayWebhookSecret) throw httpError(503, 'Payment webhook is not configured');
  if (!rawBody || !signature) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const expected = crypto.createHmac('sha256', env.razorpayWebhookSecret).update(body).digest('hex');
  return safeEqualHex(expected, signature);
}

async function createRazorpayOrder({ payment, tenant, account }) {
  const notes = {
    payment_id: payment.id,
    tenant_id: payment.tenant_id,
    account_id: account.id,
    plan_code: String(payment.metadata_json?.plan_code || ''),
    billing_cycle: String(payment.metadata_json?.billing_cycle || ''),
    billing_model: 'PREPAID_SAAS_RENEWAL',
    owner: env.businessOwnerName,
    operator: env.businessOperatorName
  };

  const response = await razorpayClient().post('/orders', {
    amount: Number(payment.amount_minor),
    currency: payment.currency,
    receipt: String(payment.gateway_order_ref || payment.id).slice(0, 40),
    notes,
    partial_payment: false
  });

  const order = response.data || {};
  if (!order.id || Number(order.amount) !== Number(payment.amount_minor) || String(order.currency || '').toUpperCase() !== String(payment.currency || '').toUpperCase()) {
    throw httpError(502, 'Payment gateway returned an invalid order');
  }

  return order;
}

async function fetchRazorpayPayment(paymentId) {
  if (!paymentId) throw httpError(400, 'razorpay_payment_id is required');
  const response = await razorpayClient().get(`/payments/${encodeURIComponent(paymentId)}`);
  return response.data || null;
}

async function preparePaymentCheckout({ payment, tenant, account }) {
  if (isZeroAmountCheckout(payment)) {
    return {
      gateway_mode: 'RAZORPAY',
      gateway: 'coupon-credit',
      gateway_status: 'SUCCEEDED',
      checkout_payload_json: {
        gateway: 'coupon-credit',
        waived: true,
        payment_id: payment.id,
        amount_minor: payment.amount_minor,
        currency: payment.currency
      }
    };
  }

  const order = await createRazorpayOrder({ payment, tenant, account });
  return {
    gateway_mode: 'RAZORPAY',
    gateway: 'razorpay',
    gateway_status: order.status || 'created',
    gateway_order_ref: order.id,
    gateway_request_id: order.id,
    checkout_payload_json: {
      gateway: 'razorpay',
      key: env.razorpayKeyId,
      order_id: order.id,
      payment_id: payment.id,
      amount_minor: Number(order.amount),
      currency: order.currency,
      name: env.appName || 'UnitFlow',
      description: `${payment.metadata_json?.plan_code || 'UnitFlow'} ${payment.metadata_json?.billing_cycle || ''}`.trim(),
      business: {
        owner: env.businessOwnerName,
        operator: env.businessOperatorName
      },
      prefill: {
        name: account.name || '',
        email: account.email || '',
        contact: account.phone || ''
      },
      notes: {
        ...(order.notes || {}),
        ...publicPolicyUrls()
      },
      theme: {
        color: tenant?.config?.theme_color || '#1f6f5b'
      }
    }
  };
}

function normalizeExternalPaymentStatus({ status, razorpay }) {
  if (status) {
    const normalized = String(status).trim().toUpperCase();
    if (['SUCCEEDED', 'FAILED', 'REFUNDED', 'PENDING'].includes(normalized)) return normalized;
  }

  const gatewayStatus = String(razorpay?.status || '').toLowerCase();
  if (['captured', 'paid'].includes(gatewayStatus)) return 'SUCCEEDED';
  if (['failed', 'cancelled'].includes(gatewayStatus)) return 'FAILED';
  if (gatewayStatus === 'refunded') return 'REFUNDED';
  return 'PENDING';
}

module.exports = {
  fetchRazorpayPayment,
  isRazorpayConfigured,
  isZeroAmountCheckout,
  normalizeExternalPaymentStatus,
  preparePaymentCheckout,
  resolveGatewayMode,
  verifyRazorpayOrderSignature,
  verifyRazorpayWebhookSignature
};
