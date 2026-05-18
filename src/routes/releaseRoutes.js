const express = require('express');
const controller = require('../controllers/releaseController');

const router = express.Router();
router.get('/latest', controller.latest);
module.exports = router;
