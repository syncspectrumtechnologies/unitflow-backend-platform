const crypto = require('crypto');
const { env } = require('../config/env');

function safeEqual(a, b) {
  const aBuf = Buffer.from(String(a || ''));
  const bBuf = Buffer.from(String(b || ''));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

module.exports = function internalServiceAuthMiddleware(req, res, next) {
  const provided = req.headers['x-platform-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!provided || !safeEqual(provided, env.platformInternalApiKey)) {
    return res.status(401).json({ ok: false, message: 'Unauthorized internal request' });
  }
  return next();
};
