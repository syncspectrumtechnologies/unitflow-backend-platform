const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { env } = require('../config/env');
const { signAccountToken, verifyAccountToken } = require('../utils/security');

function applyRefreshHeaders(res, refreshedToken) {
  if (!refreshedToken?.token) return;
  res.setHeader('Authorization', `Bearer ${refreshedToken.token}`);
  res.setHeader('X-Access-Token', refreshedToken.token);
  res.setHeader('X-Token-Refreshed', 'true');
  res.setHeader('X-Token-Expires-In', env.jwtExpiresIn);
  res.setHeader('X-Token-Expires-At', refreshedToken.expires_at);
}

module.exports = async function accountAuthMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      throw httpError(401, 'Unauthorized', { code: 'AUTH_LOGIN_REQUIRED', login_required: true });
    }
    const token = authHeader.slice(7).trim();
    const decoded = verifyAccountToken(token);
    const session = await prisma.platformSession.findFirst({
      where: {
        account_id: decoded.account_id,
        jti: decoded.jti,
        revoked_at: null,
        expires_at: { gt: new Date() }
      }
    });
    if (!session) throw httpError(401, 'Session is invalid or expired', { code: 'AUTH_TOKEN_EXPIRED', login_required: true });
    const account = await prisma.account.findFirst({ where: { id: decoded.account_id, status: 'ACTIVE' } });
    if (!account) throw httpError(401, 'Account is inactive', { code: 'AUTH_LOGIN_REQUIRED', login_required: true });

    const now = new Date();
    const sessionExpiresAt = new Date(Date.now() + env.platformSessionTtlMs);
    let refreshedToken = null;
    const shouldRefreshToken = decoded.exp && decoded.exp * 1000 - Date.now() <= env.accountTokenRefreshThresholdMs;
    if (shouldRefreshToken) {
      const signed = signAccountToken(
        { account_id: account.id, email: account.email, is_super_admin: account.is_super_admin },
        env.jwtExpiresIn,
        decoded.jti
      );
      refreshedToken = { token: signed.token, expires_at: sessionExpiresAt.toISOString() };
    }
    const shouldTouchSession = shouldRefreshToken || !session.last_seen_at || now.getTime() - session.last_seen_at.getTime() >= env.platformSessionTouchIntervalMs;
    if (shouldTouchSession) {
      await prisma.platformSession.update({
        where: { id: session.id },
        data: { last_seen_at: now, expires_at: sessionExpiresAt }
      });
    }
    applyRefreshHeaders(res, refreshedToken);

    req.account = account;
    req.session = shouldTouchSession ? { ...session, last_seen_at: now, expires_at: sessionExpiresAt } : session;
    next();
  } catch (error) {
    if (error?.name === 'TokenExpiredError') {
      return next(httpError(401, 'Session has expired', { code: 'AUTH_TOKEN_EXPIRED', login_required: true }));
    }
    next(error.statusCode ? error : httpError(401, 'Authentication failed', { code: 'AUTH_LOGIN_REQUIRED', login_required: true }));
  }
};
