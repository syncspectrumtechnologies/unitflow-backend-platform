const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { env } = require('../config/env');

function newJti() {
  return crypto.randomBytes(16).toString('hex');
}

function signAccountToken(payload, expiresIn) {
  const jti = newJti();
  const token = jwt.sign({ ...payload, jti, token_type: 'account' }, process.env.JWT_SECRET, { expiresIn });
  return { token, jti };
}

function signOpsToken(payload, expiresIn) {
  const jti = newJti();
  const token = jwt.sign({ ...payload, jti, token_type: 'ops' }, process.env.OPS_JWT_SECRET, { expiresIn });
  return { token, jti };
}

function signRuntimeToken(payload, expiresIn) {
  const jti = newJti();
  const signOptions = { expiresIn };
  if (env.runtimeJwtIssuer) signOptions.issuer = env.runtimeJwtIssuer;
  if (env.runtimeJwtAudience) signOptions.audience = env.runtimeJwtAudience;

  const token = jwt.sign({ ...payload, jti, token_type: 'runtime' }, env.runtimeJwtSecret, signOptions);
  return { token, jti };
}

function verifyAccountToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

function verifyOpsToken(token) {
  return jwt.verify(token, process.env.OPS_JWT_SECRET);
}

function generateNumericCode(length = 6) {
  let value = '';
  for (let i = 0; i < length; i += 1) value += crypto.randomInt(0, 10);
  return value;
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hashDeviceFingerprint(value) {
  return hashValue(value);
}

function safeSlug(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

module.exports = {
  signAccountToken,
  signOpsToken,
  signRuntimeToken,
  verifyAccountToken,
  verifyOpsToken,
  generateNumericCode,
  hashValue,
  hashDeviceFingerprint,
  safeSlug
};
