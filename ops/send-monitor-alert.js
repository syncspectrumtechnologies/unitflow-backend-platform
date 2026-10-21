const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const message = String(process.argv[2] || 'UnitFlow production health check failed').slice(0, 4000);
const stateDir = process.env.UNITFLOW_MONITOR_STATE_DIR || '/tmp';
const stateFile = path.join(stateDir, 'unitflow-monitor-last-alert');
const cooldownMs = Number(process.env.UNITFLOW_MONITOR_ALERT_COOLDOWN_MS || 30 * 60 * 1000);

try {
  const lastAlert = Number(fs.readFileSync(stateFile, 'utf8'));
  if (Number.isFinite(lastAlert) && Date.now() - lastAlert < cooldownMs) process.exit(0);
} catch {}

const host = process.env.SMTP_HOST;
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const to = process.env.CONTACT_TO_EMAIL || process.env.SMTP_TO_EMAIL;
if (!host || !user || !pass || !to) process.exit(0);

const transport = nodemailer.createTransport({
  host,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
  auth: { user, pass },
  tls: { rejectUnauthorized: true }
});

transport.sendMail({
  from: process.env.CONTACT_FROM_EMAIL || process.env.SMTP_FROM_EMAIL || user,
  to,
  subject: '[UnitFlow] Production health alert',
  text: `UnitFlow monitoring detected a production failure.\n\n${message}\n\nTime: ${new Date().toISOString()}`
}).then(() => {
  fs.writeFileSync(stateFile, String(Date.now()), { mode: 0o600 });
}).catch((error) => {
  console.error('Unable to send monitoring alert:', error.message);
  process.exitCode = 1;
});
