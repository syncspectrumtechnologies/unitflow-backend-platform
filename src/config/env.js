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

function parseDurationMs(value, fallbackMs) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d+)([smhd])?$/i);
  if (!match) return fallbackMs;
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) return fallbackMs;
  const unit = (match[2] || 's').toLowerCase();
  const multiplier =
    unit === 'd' ? 24 * 60 * 60 * 1000 :
    unit === 'h' ? 60 * 60 * 1000 :
    unit === 'm' ? 60 * 1000 :
    1000;
  return amount * multiplier;
}

function normalizeNodeEnv(value) {
  const v = String(value || 'development').toLowerCase().trim();
  return ['production', 'development', 'test'].includes(v) ? v : 'development';
}

const nodeEnv = normalizeNodeEnv(process.env.NODE_ENV);
const defaultPlatformSessionMs = 30 * 24 * 60 * 60 * 1000;
const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  serviceName: process.env.SERVICE_NAME || 'unitflow-platform-api',
  appName: process.env.APP_NAME || 'UnitFlow Platform',
  businessOwnerName: process.env.BUSINESS_OWNER_NAME || 'SYNC SPECTRUM TECHNOLOGIES',
  businessOperatorName: process.env.BUSINESS_OPERATOR_NAME || 'Edixity',
  port: parseIntEnv(process.env.PORT, 4100),
  corsAllowedOrigins: parseList(process.env.CORS_ALLOWED_ORIGINS),
  corsAllowNoOrigin: parseBool(process.env.CORS_ALLOW_NO_ORIGIN, true),
  jsonBodyLimit: process.env.JSON_BODY_LIMIT || '3mb',
  validateEnvOnBoot: parseBool(process.env.VALIDATE_ENV_ON_BOOT, true),
  requestIdHeader: process.env.REQUEST_ID_HEADER || 'x-request-id',
  logLevel: process.env.LOG_LEVEL || (nodeEnv === 'production' ? 'info' : 'debug'),
  redisUrl: process.env.REDIS_URL || null,
  redisRateLimitEnabled: parseBool(process.env.REDIS_RATE_LIMIT_ENABLED, false),
  redisRateLimitPrefix: process.env.REDIS_RATE_LIMIT_PREFIX || 'unitflow-platform-api',
  rateLimitMaxPerMin: parseIntEnv(process.env.RATE_LIMIT_MAX_PER_MIN, 300),
  authRateLimitMaxPer15Min: parseIntEnv(process.env.AUTH_RATE_LIMIT_MAX_PER_15_MIN, 50),
  jwtExpiresIn: process.env.ACCOUNT_JWT_EXPIRES_IN || process.env.PLATFORM_ACCOUNT_JWT_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '30d',
  accountTokenRefreshThresholdMs: parseDurationMs(process.env.ACCOUNT_TOKEN_REFRESH_THRESHOLD || '7d', 7 * 24 * 60 * 60 * 1000),
  platformSessionTouchIntervalMs: parseDurationMs(process.env.PLATFORM_SESSION_TOUCH_INTERVAL || '5m', 5 * 60 * 1000),
  platformSessionTtlMs: parseDurationMs(
    process.env.PLATFORM_SESSION_TTL ||
      process.env.PLATFORM_SESSION_EXPIRES_IN ||
      process.env.ACCOUNT_JWT_EXPIRES_IN ||
      process.env.PLATFORM_ACCOUNT_JWT_EXPIRES_IN ||
      process.env.JWT_EXPIRES_IN ||
      '30d',
    defaultPlatformSessionMs
  ),
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
  paymentGatewayDefault: (process.env.PAYMENT_GATEWAY_DEFAULT || 'RAZORPAY').toUpperCase(),
  demoCheckoutAutoSucceed: parseBool(process.env.DEMO_CHECKOUT_AUTO_SUCCEED, false),
  publicAppBaseUrl: process.env.PUBLIC_APP_BASE_URL || null,
  referralRewardMinor: parseIntEnv(process.env.DEFAULT_REFERRAL_REWARD_MINOR, 50000),
  couponReferralWelcomeMinor: parseIntEnv(process.env.DEFAULT_REFERRAL_WELCOME_COUPON_MINOR, 25000),
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || null,
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || null,
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || null,
  razorpayApiBaseUrl: process.env.RAZORPAY_API_BASE_URL || 'https://api.razorpay.com/v1',
  razorpayAllowedCurrencies: parseList(process.env.RAZORPAY_ALLOWED_CURRENCIES),
  razorpayInternationalMarkupBps: parseIntEnv(process.env.RAZORPAY_INTERNATIONAL_MARKUP_BPS, 1200),
  razorpayExchangeRatesJson: process.env.RAZORPAY_EXCHANGE_RATES_JSON || null,
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || null,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || null,
  twilioSmsFrom: process.env.TWILIO_SMS_FROM || null,
  requireSmtpForEmailVerification: parseBool(process.env.REQUIRE_SMTP_FOR_EMAIL_VERIFICATION, nodeEnv === 'production'),
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
  if (env.paymentGatewayDefault === 'RAZORPAY') {
    if (!env.razorpayKeyId || !env.razorpayKeySecret) {
      issues.push('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required when PAYMENT_GATEWAY_DEFAULT=RAZORPAY');
    }
    if (env.isProduction && !env.razorpayWebhookSecret) {
      issues.push('RAZORPAY_WEBHOOK_SECRET is required for production Razorpay webhooks');
    }
  }
  if (env.redisRateLimitEnabled && !env.redisUrl) issues.push('REDIS_URL is required when REDIS_RATE_LIMIT_ENABLED=true');
  if (env.requireSmtpForEmailVerification && (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS)) {
    issues.push('SMTP_HOST, SMTP_USER, and SMTP_PASS are required for production email verification');
  }
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
