const crypto = require('crypto');

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'y'].includes(String(value).trim().toLowerCase());
}

function parseIntEnv(value, fallback) {
  const num = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(num) ? num : fallback;
}

function parseList(value) {
  if (!value) return [];
  return String(value).split(',').map((v) => v.trim()).filter(Boolean);
}

function normalizeNodeEnv(value) {
  const v = String(value || 'development').toLowerCase().trim();
  return ['production', 'development', 'test'].includes(v) ? v : 'development';
}

const nodeEnv = normalizeNodeEnv(process.env.NODE_ENV);
const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  serviceName: process.env.SERVICE_NAME || 'unitflow-platform-api',
  appName: process.env.APP_NAME || 'UnitFlow Platform',
  port: parseIntEnv(process.env.PORT, 4100),
  corsAllowedOrigins: parseList(process.env.CORS_ALLOWED_ORIGINS),
  corsAllowNoOrigin: parseBool(process.env.CORS_ALLOW_NO_ORIGIN, true),
  jsonBodyLimit: process.env.JSON_BODY_LIMIT || '3mb',
  validateEnvOnBoot: parseBool(process.env.VALIDATE_ENV_ON_BOOT, true),
  requestIdHeader: process.env.REQUEST_ID_HEADER || 'x-request-id',
  logLevel: process.env.LOG_LEVEL || (nodeEnv === 'production' ? 'info' : 'debug'),
  rateLimitMaxPerMin: parseIntEnv(process.env.RATE_LIMIT_MAX_PER_MIN, 300),
  authRateLimitMaxPer15Min: parseIntEnv(process.env.AUTH_RATE_LIMIT_MAX_PER_15_MIN, 50),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  opsJwtExpiresIn: process.env.OPS_JWT_EXPIRES_IN || '12h',
  runtimeJwtExpiresIn: process.env.RUNTIME_JWT_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '12h',
  runtimeJwtSecret: process.env.PLATFORM_RUNTIME_JWT_SECRET,
  runtimeJwtIssuer: process.env.PLATFORM_RUNTIME_JWT_ISSUER || 'unitflow-platform-api',
  runtimeJwtAudience: process.env.PLATFORM_RUNTIME_JWT_AUDIENCE || 'unitflow-core-api',
  defaultCurrency: process.env.DEFAULT_CURRENCY || 'INR',
  singleMonthlyMinor: parseIntEnv(process.env.DEFAULT_SINGLE_USER_MONTHLY_PRICE_MINOR, 99900),
  singleYearlyMinor: parseIntEnv(process.env.DEFAULT_SINGLE_USER_YEARLY_PRICE_MINOR, 999900),
  multiMonthlyMinor: parseIntEnv(process.env.DEFAULT_MULTI_USER_MONTHLY_PRICE_MINOR, 299900),
  multiYearlyMinor: parseIntEnv(process.env.DEFAULT_MULTI_USER_YEARLY_PRICE_MINOR, 2999900),
  multiSeatLimit: parseIntEnv(process.env.DEFAULT_MULTI_USER_SEAT_LIMIT, 5),
  verificationCodeTtlMinutes: parseIntEnv(process.env.VERIFICATION_CODE_TTL_MINUTES, 15),
  coreApiBaseUrl: process.env.CORE_API_BASE_URL,
  platformInternalApiKey: process.env.PLATFORM_INTERNAL_API_KEY,
  paymentWebhookSecret: process.env.PAYMENT_WEBHOOK_SECRET,
  buildFingerprint: process.env.BUILD_FINGERPRINT || crypto.createHash('sha256').update('unitflow-platform-api').digest('hex').slice(0, 12),
  provisioningWorkerEnabled: parseBool(process.env.PROVISIONING_WORKER_ENABLED, true),
  provisioningWorkerIntervalMs: parseIntEnv(process.env.PROVISIONING_WORKER_INTERVAL_MS, 5000),
  provisioningWorkerBatchSize: parseIntEnv(process.env.PROVISIONING_WORKER_BATCH_SIZE, 5)
};

function validate() {
  const issues = [];
  if (!process.env.PLATFORM_DATABASE_URL) issues.push('PLATFORM_DATABASE_URL is required');
  if (!process.env.JWT_SECRET || String(process.env.JWT_SECRET).length < 32) issues.push('JWT_SECRET must be at least 32 characters');
  if (!process.env.OPS_JWT_SECRET || String(process.env.OPS_JWT_SECRET).length < 32) issues.push('OPS_JWT_SECRET must be at least 32 characters');
  if (!env.runtimeJwtSecret || String(env.runtimeJwtSecret).length < 32) issues.push('PLATFORM_RUNTIME_JWT_SECRET must be at least 32 characters');
  if (!process.env.CORE_API_BASE_URL) issues.push('CORE_API_BASE_URL is required');
  if (!process.env.PLATFORM_INTERNAL_API_KEY) issues.push('PLATFORM_INTERNAL_API_KEY is required');
  if (issues.length) {
    const error = new Error(`Invalid platform environment: ${issues.join('; ')}`);
    error.name = 'EnvValidationError';
    throw error;
  }
}

function isOriginAllowed(origin) {
  if (!origin) return env.corsAllowNoOrigin;
  return env.corsAllowedOrigins.includes(origin);
}

module.exports = { env, validate, parseBool, parseIntEnv, parseList, isOriginAllowed };
