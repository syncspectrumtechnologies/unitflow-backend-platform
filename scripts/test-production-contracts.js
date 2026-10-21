const assert = require('assert');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.PLATFORM_DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ||= crypto.randomBytes(32).toString('hex');
process.env.OPS_JWT_SECRET ||= crypto.randomBytes(32).toString('hex');
process.env.PLATFORM_RUNTIME_JWT_SECRET ||= crypto.randomBytes(32).toString('hex');
process.env.CORE_API_BASE_URL ||= 'http://127.0.0.1:4211';
process.env.PLATFORM_INTERNAL_API_KEY ||= crypto.randomBytes(32).toString('hex');
process.env.PAYMENT_GATEWAY_DEFAULT = 'NONE';
process.env.CORS_ALLOWED_ORIGINS = 'https://unitflow.in,https://core.unitflow.in';
process.env.CORS_ALLOW_NO_ORIGIN = 'false';

const { env, validate, isOriginAllowed } = require('../src/config/env');

assert.doesNotThrow(validate);
assert.strictEqual(isOriginAllowed('https://unitflow.in'), true);
assert.strictEqual(isOriginAllowed('https://core.unitflow.in'), true);
assert.strictEqual(isOriginAllowed('https://attacker.example'), false);
assert.strictEqual(isOriginAllowed(), false);
assert.ok(env.platformSessionTtlMs >= 24 * 60 * 60 * 1000);
assert.strictEqual(env.demoCheckoutAutoSucceed, false);

console.log('Production security contracts passed');
