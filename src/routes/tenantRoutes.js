const express = require('express');
const accountAuthMiddleware = require('../middlewares/accountAuthMiddleware');
const controller = require('../controllers/tenantController');

const router = express.Router();
router.use(accountAuthMiddleware);
router.post('/onboarding/draft', controller.saveOnboardingDraft);
router.post('/onboard', controller.onboardPaidTenant);
router.get('/', controller.listMine);
router.get('/:tenantId/dashboard', controller.getDashboard);
router.get('/:tenantId/referrals', controller.getReferralPage);
router.get('/:tenantId', controller.getOne);
router.put('/:tenantId/config', controller.updateConfig);
router.post('/:tenantId/provisioning/retry', controller.retryProvisioning);
module.exports = router;
