const express = require('express');
const accountAuthMiddleware = require('../middlewares/accountAuthMiddleware');
const controller = require('../controllers/runtimeController');

const router = express.Router();
router.use(accountAuthMiddleware);
router.post('/devices/register', controller.registerDevice);
router.get('/tenants/:tenantId/devices', controller.listDevices);
router.post('/tenants/:tenantId/devices/:deviceId/revoke', controller.revokeDevice);
router.get('/tenants/:tenantId/sessions', controller.listSessions);
router.post('/tenants/:tenantId/sessions/:sessionId/revoke', controller.revokeSession);
module.exports = router;
