// Thin SMTP wrapper, used only by the alert digest.
//
// Deliberately optional: a store running without SMTP configured must not
// crash or spam its logs on every tick — isConfigured()/sendMail() degrade to
// "nothing to do" rather than throwing, so email is purely additive to
// whatever [ALERT] logging already does.

let cachedTransport;
let cachedConfigKey;

function config() {
  return {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER || '',
    to: String(process.env.ALERT_EMAIL_TO || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.host && c.user && c.pass && c.from && c.to.length);
}

// Recreated only when the relevant env vars actually change, so a long-running
// process picks up a corrected SMTP password without a restart.
function transport() {
  const c = config();
  const key = JSON.stringify([c.host, c.port, c.secure, c.user, c.pass]);
  if (cachedTransport && cachedConfigKey === key) return cachedTransport;

  // Required lazily: a store with no SMTP configured should never pay for
  // loading nodemailer at all, and isConfigured() already gates every caller.
  const nodemailer = require('nodemailer');
  cachedTransport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: { user: c.user, pass: c.pass },
  });
  cachedConfigKey = key;
  return cachedTransport;
}

// { subject, text }. Silently does nothing when SMTP isn't configured — the
// caller decides whether that's worth its own log line.
async function sendMail({ subject, text }) {
  if (!isConfigured()) return { sent: false, reason: 'SMTP not configured' };

  const c = config();
  await transport().sendMail({
    from: c.from,
    to: c.to.join(', '),
    subject,
    text,
  });
  return { sent: true, to: c.to };
}

module.exports = { isConfigured, sendMail, config };
