const express = require('express');
const accountAuthMiddleware = require('../middlewares/accountAuthMiddleware');
const controller = require('../controllers/subscriptionController');

const router = express.Router();
router.get('/plans', controller.listPlans);
router.post('/checkout-intent', accountAuthMiddleware, controller.createCheckoutIntent);
router.post('/webhooks/payment', controller.paymentWebhook);
router.get('/payments', accountAuthMiddleware, controller.listPayments);
module.exports = router;
