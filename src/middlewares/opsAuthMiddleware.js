const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { verifyOpsToken } = require('../utils/security');

module.exports = async function opsAuthMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) throw httpError(401, 'Unauthorized');
    const token = authHeader.slice(7).trim();
    const decoded = verifyOpsToken(token);
    const opsUser = await prisma.opsUser.findFirst({ where: { id: decoded.ops_user_id, status: 'ACTIVE' } });
    if (!opsUser) throw httpError(401, 'Ops user is inactive');
    req.opsUser = opsUser;
    next();
  } catch (error) {
    next(error.statusCode ? error : httpError(401, 'Ops authentication failed'));
  }
};
