const crypto = require('crypto');
const axios = require('axios');
const { env } = require('../config/env');
const httpError = require('../utils/httpError');

const PAYTM_IV = '@@@@&&&&####$$$$';

function resolveGatewayMode(value) {
  const normalized = String(value || env.paymentGatewayDefault || 'MANUAL').trim().toUpperCase();
  return ['MANUAL', 'PAYTM'].includes(normalized) ? normalized : 'MANUAL';
}

function isZeroAmountCheckout(payment) {
  return Number(payment?.amount_minor || 0) <= 0;
}

function minorToMajorString(amountMinor) {
  return (Number(amountMinor || 0) / 100).toFixed(2);
}

function paytmEnvironmentBaseUrl() {
  return env.paytmEnvironment === 'PRODUCTION'
    ? 'https://secure.paytmpayments.com'
    : 'https://securestage.paytmpayments.com';
}

function encryptPaytmChecksum(input, merchantKey) {
  const key = Buffer.from(String(merchantKey || '').slice(0, 16), 'utf8');
  const iv = Buffer.from(PAYTM_IV, 'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(input, 'utf8'), cipher.final()]).toString('base64');
}

function generatePaytmSignature(bodyString, merchantKey) {
  const salt = crypto.randomBytes(4).toString('hex');
  const hash = crypto.createHash('sha256').update(`${bodyString}|${salt}`).digest('hex') + salt;
  return encryptPaytmChecksum(hash, merchantKey);
}

function buildPaytmCheckoutPayload({ payment, tenant, account }) {
  if (!env.paytmMid || !env.paytmMerchantKey || !env.paytmWebsite) {
    throw httpError(500, 'Paytm gateway is not configured');
  }

  const callbackUrl = env.paytmCallbackUrl || null;
  const body = {
    requestType: 'Payment',
    mid: env.paytmMid,
    websiteName: env.paytmWebsite,
    orderId: payment.gateway_order_ref,
    ...(callbackUrl ? { callbackUrl } : {}),
    txnAmount: {
      value: minorToMajorString(payment.amount_minor),
      currency: payment.currency || env.defaultCurrency
    },
    userInfo: {
      custId: account.id,
      mobile: account.phone ? String(account.phone).replace(/^\+/, '') : undefined,
      email: account.email,
      firstName: account.name
    }
  };

  const sanitizedBody = JSON.parse(JSON.stringify(body));
  const bodyString = JSON.stringify(sanitizedBody);
  const head = {
    version: 'v1',
    requestTimestamp: String(Math.floor(Date.now() / 1000)),
    signature: generatePaytmSignature(bodyString, env.paytmMerchantKey)
  };

  if (env.paytmClientId) {
    head.clientId = env.paytmClientId;
  }

  return {
    request_url: `${paytmEnvironmentBaseUrl()}/theia/api/v1/initiateTransaction?mid=${encodeURIComponent(env.paytmMid)}&orderId=${encodeURIComponent(payment.gateway_order_ref)}`,
    request_body: sanitizedBody,
    request_head: head,
    callback_url: callbackUrl
  };
}

async function initiatePaytmTransaction({ payment, tenant, account }) {
  const payload = buildPaytmCheckoutPayload({ payment, tenant, account });
  const client = axios.create({
    timeout: 12000,
    headers: {
      'Content-Type': 'application/json'
    }
  });

  const response = await client.post(payload.request_url, {
    body: payload.request_body,
    head: payload.request_head
  });

  const resultInfo = response?.data?.body?.resultInfo || {};
  if (String(resultInfo.resultStatus || '').toUpperCase() !== 'S') {
    throw httpError(502, resultInfo.resultMsg || 'Paytm initiate transaction failed');
  }

  return {
    gateway_mode: 'PAYTM',
    gateway: 'paytm',
    gateway_status: resultInfo.resultStatus || 'S',
    gateway_request_id: response?.data?.head?.requestId || null,
    checkout_payload_json: {
      gateway: 'paytm',
      txn_token: response?.data?.body?.txnToken || null,
      mid: env.paytmMid,
      order_id: payload.request_body.orderId,
      amount: payload.request_body.txnAmount,
      callback_url: payload.callback_url,
      is_redirect: Boolean(response?.data?.body?.isRedirect),
      result_info: resultInfo
    }
  };
}

function buildManualCheckout({ payment, gatewayMode }) {
  return {
    gateway_mode: gatewayMode,
    gateway: gatewayMode === 'PAYTM' ? 'paytm' : 'manual-test-gateway',
    gateway_status: 'PENDING',
    checkout_payload_json: {
      gateway: gatewayMode === 'PAYTM' ? 'paytm' : 'manual',
      instructions: gatewayMode === 'PAYTM'
        ? 'Paytm credentials are not configured yet. Complete setup to enable live checkout.'
        : 'Use the payment webhook endpoint to mark this payment as succeeded or failed during testing.',
      payment_id: payment.id,
      amount_minor: payment.amount_minor,
      currency: payment.currency
    }
  };
}

async function preparePaymentCheckout({ payment, tenant, account, gatewayMode }) {
  const resolvedGatewayMode = resolveGatewayMode(gatewayMode);
  if (isZeroAmountCheckout(payment)) {
    return {
      gateway_mode: resolvedGatewayMode,
      gateway: resolvedGatewayMode === 'PAYTM' ? 'paytm' : 'coupon-credit',
      gateway_status: 'SUCCEEDED',
      checkout_payload_json: {
        gateway: resolvedGatewayMode === 'PAYTM' ? 'paytm' : 'coupon-credit',
        waived: true,
        payment_id: payment.id,
        amount_minor: payment.amount_minor
      }
    };
  }

  if (resolvedGatewayMode !== 'PAYTM') {
    return buildManualCheckout({ payment, gatewayMode: resolvedGatewayMode });
  }

  if (!env.paytmMid || !env.paytmMerchantKey || !env.paytmWebsite) {
    return buildManualCheckout({ payment, gatewayMode: resolvedGatewayMode });
  }

  return initiatePaytmTransaction({ payment, tenant, account });
}

function normalizeExternalPaymentStatus({ gateway, status, paytm }) {
  if (status) {
    const normalized = String(status).trim().toUpperCase();
    if (['SUCCEEDED', 'FAILED', 'REFUNDED', 'PENDING'].includes(normalized)) return normalized;
  }

  if (String(gateway || '').toUpperCase() === 'PAYTM' && paytm?.body?.resultInfo) {
    const resultStatus = String(paytm.body.resultInfo.resultStatus || '').toUpperCase();
    if (resultStatus === 'S') return 'SUCCEEDED';
    if (resultStatus === 'F') return 'FAILED';
    return 'PENDING';
  }

  return 'PENDING';
}

module.exports = {
  resolveGatewayMode,
  isZeroAmountCheckout,
  preparePaymentCheckout,
  normalizeExternalPaymentStatus
};
