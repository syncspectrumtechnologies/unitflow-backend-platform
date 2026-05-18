module.exports = function httpError(status, message, details) {
  const error = new Error(message);
  error.statusCode = status;
  if (details !== undefined) error.details = details;
  return error;
};
