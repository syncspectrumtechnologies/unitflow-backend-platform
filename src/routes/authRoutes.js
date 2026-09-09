const express = require('express');
const accountAuthMiddleware = require('../middlewares/accountAuthMiddleware');
const controller = require('../controllers/authController');
const {
  validateSignup,
  validateLogin,
  validateVerificationRequest,
  validateVerificationSubmit,
  validateRuntimeLogin
} = require('../middlewares/platformValidationMiddleware');

const router = express.Router();
router.post('/signup', validateSignup, controller.signup);
router.post('/request-verification', validateVerificationRequest, controller.requestVerification);
router.post('/verify', validateVerificationSubmit, controller.verify);
router.post('/login', validateLogin, controller.login);
router.post('/runtime-login', validateRuntimeLogin, controller.runtimeLogin);
router.get('/me', accountAuthMiddleware, controller.me);
router.post('/logout', accountAuthMiddleware, controller.logout);
module.exports = router;
