const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const prisma = require('./config/db');
const { env, isOriginAllowed } = require('./config/env');
const logger = require('./utils/logger');
const requestContextMiddleware = require('./middlewares/requestContextMiddleware');
const secureBodyMiddleware = require('./middlewares/secureBodyMiddleware');
const notFoundHandler = require('./middlewares/notFoundHandler');
const errorHandler = require('./middlewares/errorHandler');

const authRoutes = require('./routes/authRoutes');
const tenantRoutes = require('./routes/tenantRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const releaseRoutes = require('./routes/releaseRoutes');
const opsRoutes = require('./routes/opsRoutes');
const runtimeRoutes = require('./routes/runtimeRoutes');
const internalRoutes = require('./routes/internalRoutes');
const notificationRoutes = require('./routes/notificationRoutes');

const app = express();

function buildRateLimitOptions(baseOptions, redisPrefix) {
  const opts = { ...baseOptions };
  if (!env.redisRateLimitEnabled || !env.redisUrl) return opts;

  try {
    const { RedisStore } = require('rate-limit-redis');
    const { createClient } = require('redis');
    const client = createClient({ url: env.redisUrl });
    client.on('error', (err) => logger.warn('Redis rate-limit error', { error: err?.message || 'Redis error' }));
    client.connect().catch((err) => logger.warn('Redis rate-limit connect failed', { error: err?.message || 'Redis connect failed' }));
    opts.store = new RedisStore({
      prefix: `${env.redisRateLimitPrefix}:${redisPrefix}:`,
      sendCommand: (...args) => client.sendCommand(args)
    });
  } catch (err) {
    logger.warn('Redis rate-limit store unavailable; using memory limiter', { error: err?.message || 'Redis unavailable' });
  }

  return opts;
}

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || 1);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (isOriginAllowed(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS policy'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Payment-Webhook-Secret', 'X-Razorpay-Signature', 'X-Platform-Api-Key'],
  exposedHeaders: ['Authorization', 'X-Request-Id', 'X-Login-Required', 'X-Access-Token', 'X-Token-Refreshed', 'X-Token-Expires-In', 'X-Token-Expires-At']
}));
app.use(requestContextMiddleware);
app.use(express.json({
  limit: env.jsonBodyLimit,
  verify: (req, res, buf) => {
    if (String(req.originalUrl || '').startsWith('/subscriptions/webhooks/razorpay')) {
      req.rawBody = Buffer.from(buf);
    }
  }
}));
app.use(express.urlencoded({ extended: false, limit: env.jsonBodyLimit }));
app.use(secureBodyMiddleware);
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    logger.info('Platform request completed', { request_id: req.request_id, method: req.method, path: req.path, status: res.statusCode, duration_ms: Date.now() - startedAt });
  });
  next();
});
app.use(rateLimit(buildRateLimitOptions({
  windowMs: 60 * 1000,
  max: env.rateLimitMaxPerMin,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health' || req.path === '/ready'
}, 'global')));
const authLimiter = rateLimit(buildRateLimitOptions({
  windowMs: 15 * 60 * 1000,
  max: env.authRateLimitMaxPer15Min,
  standardHeaders: true,
  legacyHeaders: false
}, 'auth'));

app.get('/health', (req, res) => res.json({ ok: true, service: env.serviceName, app: env.appName, request_id: req.request_id, uptime_sec: Math.round(process.uptime()) }));
app.get('/ready', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: 'ready', build_fingerprint: env.buildFingerprint, request_id: req.request_id });
  } catch (error) {
    res.status(503).json({ ok: false, db: 'not_ready', request_id: req.request_id });
  }
});

app.use('/auth', authLimiter, authRoutes);
app.use('/tenants', tenantRoutes);
app.use('/subscriptions', subscriptionRoutes);
app.use('/notifications', notificationRoutes);
app.use('/releases', releaseRoutes);
app.use('/runtime', runtimeRoutes);
app.use('/ops', opsRoutes);
app.use('/internal', internalRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
