const bcrypt = require('bcrypt');
const prisma = require('../config/db');
const httpError = require('../utils/httpError');
const { env } = require('../config/env');
const { signOpsToken } = require('../utils/security');

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) throw httpError(400, 'email and password are required');
    const opsUser = await prisma.opsUser.findUnique({ where: { email: String(email).toLowerCase().trim() } });
    if (!opsUser) throw httpError(401, 'Invalid credentials');
    if (opsUser.status !== 'ACTIVE') throw httpError(403, 'Ops user is disabled');
    const ok = await bcrypt.compare(String(password), opsUser.password_hash);
    if (!ok) throw httpError(401, 'Invalid credentials');
    const { token } = signOpsToken({ ops_user_id: opsUser.id, role: opsUser.role }, env.opsJwtExpiresIn);
    await prisma.opsUser.update({ where: { id: opsUser.id }, data: { last_login_at: new Date() } });
    res.json({ ok: true, token, ops_user: { id: opsUser.id, email: opsUser.email, name: opsUser.name, role: opsUser.role } });
  } catch (error) { next(error); }
};
