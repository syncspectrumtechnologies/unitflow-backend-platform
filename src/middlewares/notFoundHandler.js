module.exports = function notFoundHandler(req, res) {
  res.status(404).json({ ok: false, message: 'Route not found', request_id: req.request_id });
};
