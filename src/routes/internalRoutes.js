const express = require('express');
const internalServiceAuthMiddleware = require('../middlewares/internalServiceAuthMiddleware');
const controller = require('../controllers/internalController');

const router = express.Router();
router.use(internalServiceAuthMiddleware);
router.post('/runtime-sessions/validate', controller.validateRuntimeSession);
module.exports = router;
