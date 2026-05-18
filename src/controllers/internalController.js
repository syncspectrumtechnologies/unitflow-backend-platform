const { validateRuntimeSession } = require('../services/runtimeAccessService');

exports.validateRuntimeSession = async (req, res, next) => {
  try {
    const { jti, touch = true } = req.body || {};
    if (!jti) return res.status(400).json({ ok: false, message: 'jti is required' });
    const result = await validateRuntimeSession({ jti, touch });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
};
