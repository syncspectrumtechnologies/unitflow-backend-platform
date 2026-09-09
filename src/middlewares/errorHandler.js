const logger = require('../utils/logger');
const { clientSafeDetails, redactError } = require('../utils/redact');

module.exports = function errorHandler(err, req, res, next) {
  const status = err.statusCode || 500;
  const isServerError = status >= 500;
  const details = clientSafeDetails(err.details);
  logger.error('Platform request failed', {
    request_id: req.request_id,
    path: req.path,
    method: req.method,
    status,
    error: redactError(err)
  });

  res.status(status).json({
    ok: false,
    message: isServerError ? 'Internal server error' : (err.message || 'Request failed'),
    code: err.details?.code || err.code || undefined,
    login_required: err.details?.login_required || undefined,
    details: !isServerError ? details : undefined,
    request_id: req.request_id
  });
};
