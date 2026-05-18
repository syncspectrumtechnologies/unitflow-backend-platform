const express = require('express');
const accountAuthMiddleware = require('../middlewares/accountAuthMiddleware');
const controller = require('../controllers/authController');

const router = express.Router();
router.post('/signup', controller.signup);
router.post('/request-verification', controller.requestVerification);
router.post('/verify', controller.verify);
router.post('/login', controller.login);
router.post('/runtime-login', controller.runtimeLogin);
router.get('/me', accountAuthMiddleware, controller.me);
router.post('/logout', accountAuthMiddleware, controller.logout);
module.exports = router;
