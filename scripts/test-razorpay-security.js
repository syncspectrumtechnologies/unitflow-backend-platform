const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.RAZORPAY_KEY_SECRET = 'test_secret_for_signature';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret';

const {
  verifyRazorpayOrderSignature,
  verifyRazorpayWebhookSignature
} = require('../src/services/paymentGatewayService');

const orderId = 'order_test_123';
const paymentId = 'pay_test_123';
const goodSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

assert.equal(verifyRazorpayOrderSignature({ orderId, paymentId, signature: goodSignature }), true);
assert.equal(verifyRazorpayOrderSignature({ orderId, paymentId, signature: 'bad' }), false);

const rawBody = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: paymentId } } } }));
const webhookSignature = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');

assert.equal(verifyRazorpayWebhookSignature(rawBody, webhookSignature), true);
assert.equal(verifyRazorpayWebhookSignature(rawBody, goodSignature), false);

console.log('Razorpay security fixture passed');
