const { env } = require('../config/env');

function write(level, message, meta = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    service: env.serviceName,
    message,
    ...meta
  };
  console.log(JSON.stringify(payload));
}

module.exports = {
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
  debug: (message, meta) => {
    if (env.logLevel === 'debug') write('debug', message, meta);
  }
};
