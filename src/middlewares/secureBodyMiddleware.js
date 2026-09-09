const httpError = require('../utils/httpError');

const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor', '__definegetter__', '__definesetter__']);

function assertSafeBody(value, path = 'body', depth = 0) {
  if (value === null || value === undefined || typeof value !== 'object') return;
  if (depth > 20) throw httpError(400, 'Request body is too deeply nested');

  if (Array.isArray(value)) {
    if (value.length > 1000) throw httpError(400, `${path} has too many items`);
    value.forEach((item, index) => assertSafeBody(item, `${path}[${index}]`, depth + 1));
    return;
  }

  const keys = Object.keys(value);
  if (keys.length > 250) throw httpError(400, `${path} has too many fields`);

  for (const key of keys) {
    if (BLOCKED_KEYS.has(String(key).toLowerCase())) {
      throw httpError(400, 'Request body contains unsafe object keys');
    }
    assertSafeBody(value[key], `${path}.${key}`, depth + 1);
  }
}

module.exports = function secureBodyMiddleware(req, res, next) {
  try {
    assertSafeBody(req.body);
    next();
  } catch (error) {
    next(error);
  }
};
