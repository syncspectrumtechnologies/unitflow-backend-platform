const express = require('express');
const accountAuthMiddleware = require('../middlewares/accountAuthMiddleware');
const controller = require('../controllers/subscriptionController');

const router = express.Router();
router.get('/plans', controller.listPlans);
router.post('/coupons/validate', accountAuthMiddleware, controller.validateCoupon);
router.post('/checkout-intent', accountAuthMiddleware, controller.createCheckoutIntent);
router.post('/checkout/verify', accountAuthMiddleware, controller.verifyRazorpayCheckout);
router.post('/webhooks/payment', controller.paymentWebhook);
router.post('/webhooks/razorpay', controller.razorpayWebhook);
router.get('/billing-summary', accountAuthMiddleware, controller.getBillingSummary);
router.get('/access-health', accountAuthMiddleware, controller.getAccessHealth);
router.get('/payments', accountAuthMiddleware, controller.listPayments);
router.post('/payments/:paymentId/demo-complete', accountAuthMiddleware, controller.completeDemoPayment);
module.exports = router;
