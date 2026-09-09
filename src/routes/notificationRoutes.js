const express = require('express');
const accountAuthMiddleware = require('../middlewares/accountAuthMiddleware');
const controller = require('../controllers/notificationController');

const router = express.Router();

router.use(accountAuthMiddleware);
router.get('/', controller.listNotifications);
router.post('/read-all', controller.markAllNotificationsRead);
router.post('/:notificationId/read', controller.markNotificationRead);

module.exports = router;
