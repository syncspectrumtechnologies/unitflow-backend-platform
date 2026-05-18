const logger = require('../utils/logger');

module.exports = function errorHandler(err, req, res, next) {
  const status = err.statusCode || 500;
  logger.error('Platform request failed', {
    request_id: req.request_id,
    path: req.path,
    method: req.method,
    status,
    error_message: err.message,
    details: err.details || null
  });
  res.status(status).json({
    ok: false,
    message: err.message || 'Internal server error',
    details: err.details || undefined,
    request_id: req.request_id
  });
};
