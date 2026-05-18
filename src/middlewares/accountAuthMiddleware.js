const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { verifyAccountToken } = require('../utils/security');

module.exports = async function accountAuthMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) throw httpError(401, 'Unauthorized');
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
    if (!session) throw httpError(401, 'Session is invalid or expired');
    const account = await prisma.account.findFirst({ where: { id: decoded.account_id, status: 'ACTIVE' } });
    if (!account) throw httpError(401, 'Account is inactive');
    req.account = account;
    req.session = session;
    next();
  } catch (error) {
    next(error.statusCode ? error : httpError(401, 'Authentication failed'));
  }
};
