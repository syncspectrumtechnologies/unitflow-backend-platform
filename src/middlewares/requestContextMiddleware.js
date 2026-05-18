const crypto = require('crypto');
const { env } = require('../config/env');

module.exports = function requestContextMiddleware(req, res, next) {
  req.request_id = req.headers[env.requestIdHeader] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.request_id);
  next();
};
