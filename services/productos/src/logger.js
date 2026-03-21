'use strict';

// Structured JSON logger — CloudWatch captures stdout and parses JSON fields.
// Using { level, message, ... } lets CloudWatch Logs metric filters match on
// { $.level = "error" } to power the high-error-rate alarm in observability.tf.

const log = (level, message, extra = {}) => {
  process.stdout.write(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      service: process.env.SERVICE_NAME || 'svc-productos',
      message,
      ...extra,
    }) + '\n'
  );
};

module.exports = {
  info:  (msg, extra) => log('info',  msg, extra),
  warn:  (msg, extra) => log('warn',  msg, extra),
  error: (msg, extra) => log('error', msg, extra),
};
