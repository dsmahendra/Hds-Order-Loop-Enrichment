// Email admin a periodic digest of orders that still have no pack date / HDS
// data — the same [ALERT] condition the webhook, retry job and sweep already
// log, surfaced somewhere that doesn't require watching Railway logs.
//
// A digest, not one email per order: a burst (a Loop renewal run, a schedule
// withdrawn for a suburb) can affect several orders in one pass, and one email
// per order would be the inbox equivalent of the log spam [ALERT] tagging was
// meant to fix. One email listing everything currently outstanding, on an
// interval independent of how often the sweep or retry job themselves run.
//
// Deliberately cheap, same reasoning as the sweep: this reads orders_to_enrich
// only, no Shopify or HDS calls, so a daily tick costs one query. It will list
// an order as "not available for delivery" verbatim even when the real cause
// turns out to be a bad stored postcode (see stuck-schedules.js's own fix for
// exactly that) — this is a "something needs a look" nudge, not a diagnosis;
// stuck-schedules.js and order:explain are still the tools for the real answer.
//
//   node src/scripts/alert-digest-now.js     run one pass immediately
//
// Needs DATABASE_URL. Needs SMTP_HOST/PORT/USER/PASS, ALERT_EMAIL_FROM and
// ALERT_EMAIL_TO to actually send — without them this logs what it would have
// sent and does nothing else, so turning the job on early is harmless.

const { sendMail, isConfigured } = require('../lib/mailer');

const INTERVAL_MS = Number(process.env.ALERT_DIGEST_INTERVAL_MS || 24 * 60 * 60 * 1000);

// How far back to look for candidates. Wide by default, same reasoning as
// stuck-schedules.js: a row that exhausted its retries stops updating from
// that point on, so "recently touched" is the wrong filter for "currently
// still broken" — an order that went quiet weeks ago and was never fixed
// should keep appearing in the digest, not age out of it.
const HOURS = Number(process.env.ALERT_DIGEST_HOURS || 24 * 30);

// A cap, not a target: if something systemic broke and hundreds of orders are
// affected, the digest names the count and the first MAX, rather than sending
// one email per row or a single email megabytes long.
const MAX_ROWS = Number(process.env.ALERT_DIGEST_MAX_ROWS || 25);

// pg returns DATE/TIMESTAMPTZ as JS Date objects, not strings.
function toISODate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// The Shopify admin URL for an order, built from SHOPIFY_STORE
// ("workoutmeals.myshopify.com" -> ".../store/workoutmeals/orders/<id>").
// Best-effort: an unusual store domain just means no link, not a crash.
function orderUrl(orderId) {
  const store = String(process.env.SHOPIFY_STORE || '');
  const handle = store.replace(/\.myshopify\.com$/, '');
  if (!handle || handle === store) return null;
  return `https://admin.shopify.com/store/${handle}/orders/${orderId}`;
}

// Pure and DB-free on purpose, so it's testable without a database or SMTP.
// rows: [{ order_id, subscription_id, status, attempts, error_message, updated_at }]
// Returns null when there's nothing worth emailing.
function buildDigestEmail(rows, { store = process.env.SHOPIFY_STORE || '(store not set)' } = {}) {
  if (!rows.length) return null;

  const shown = rows.slice(0, MAX_ROWS);
  const overflow = rows.length - shown.length;

  const lines = shown.map((row) => {
    const label = row.subscription_id ? `subscription ${row.subscription_id}, order ${row.order_id}` : `order ${row.order_id}`;
    const url = orderUrl(row.order_id);
    return (
      `  - ${label} — ${row.status}, ${row.attempts} attempt(s), last touched ${toISODate(row.updated_at)}\n` +
      `    ${row.error_message || '(no error message recorded)'}` +
      (url ? `\n    ${url}` : '')
    );
  });

  const subject = `[HDS] ${rows.length} order(s) still missing pack date / HDS data`;

  const text =
    `${store} — ${rows.length} order(s) have not received their HDS data (pack date, delivery schedule, etc.) ` +
    `as of this check.\n\n` +
    lines.join('\n\n') +
    (overflow > 0 ? `\n\n  ...and ${overflow} more not shown.` : '') +
    '\n\n' +
    'For the full picture (including whether each is a real schedule problem or something else):\n' +
    '  node src/scripts/stuck-schedules.js\n\n' +
    'To fix one order once you know what it needs:\n' +
    '  node src/scripts/order-fix.js --order <id> [--force | --recompute]\n';

  return { subject, text };
}

async function runDigest() {
  if (!process.env.DATABASE_URL) {
    console.log('[alert-digest] skipped: no DATABASE_URL');
    return { sent: false, count: 0 };
  }

  const { pool } = require('../db');
  const { rows } = await pool.query(
    `SELECT order_id, subscription_id, status, attempts, error_message, updated_at
       FROM orders_to_enrich
      WHERE (status = 'failed' OR hds_write_ok = FALSE)
        AND updated_at >= NOW() - ($1::int * INTERVAL '1 hour')
      ORDER BY updated_at DESC`,
    [HOURS]
  );

  const email = buildDigestEmail(rows);
  if (!email) {
    console.log(`[alert-digest] nothing outstanding in the last ${HOURS}h — no email sent`);
    return { sent: false, count: 0 };
  }

  if (!isConfigured()) {
    console.log(
      `[alert-digest] ${rows.length} order(s) outstanding, but SMTP is not configured — would have sent:\n` +
        `  subject: ${email.subject}`
    );
    return { sent: false, count: rows.length };
  }

  const result = await sendMail(email);
  console.log(`[alert-digest] ${rows.length} order(s) outstanding — emailed ${result.to.join(', ')}`);
  return { sent: true, count: rows.length };
}

function initAlertDigest() {
  if (String(process.env.ALERT_DIGEST_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('[alert-digest] disabled (ALERT_DIGEST_ENABLED=false)');
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.log('[alert-digest] disabled: no DATABASE_URL, so there is nothing to check');
    return;
  }

  console.log(
    `[alert-digest] started (every ${Math.round(INTERVAL_MS / 3600000)}h, looking back ${HOURS}h, ` +
      `${isConfigured() ? 'SMTP configured' : 'SMTP NOT configured — will log only'})`
  );

  setInterval(() => {
    runDigest().catch((err) => console.error('[alert-digest] pass failed:', err.message || err));
  }, INTERVAL_MS);
}

module.exports = { initAlertDigest, runDigest, buildDigestEmail };
