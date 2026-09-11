// Email admin a periodic digest of orders genuinely still missing pack date /
// HDS data — the same [ALERT] condition the webhook, retry job and sweep
// already log, surfaced somewhere that doesn't require watching Railway logs.
//
// A digest, not one email per order: a burst (a Loop renewal run, a schedule
// withdrawn for a suburb) can affect several orders in one pass, and one email
// per order would be the inbox equivalent of the log spam [ALERT] tagging was
// meant to fix. One email listing everything currently outstanding, on an
// interval independent of how often the sweep or retry job themselves run.
//
// Every candidate order id (found cheaply from orders_to_enrich) is verified
// live via checkOrder() (src/lib/stuck-order-check.js), shared with
// stuck-schedules.js — NOT just read off the historical DB row. That row's
// recorded postcode/suburb is often wrong (see locationCandidatesFor) and its
// failure may already be fixed by the time the digest runs; reporting it
// verbatim produced a 268-row email that was mostly stale noise. This costs a
// Shopify + HDS call per candidate (same cost stuck-schedules.js already
// pays), which is why this defaults to running once a day rather than on the
// sweep's own tighter interval.
//
//   node src/scripts/alert-digest-now.js     run one pass immediately
//
// Needs DATABASE_URL, SHOPIFY_STORE + SHOPIFY_ADMIN_TOKEN, and HDS_API_BASE to
// verify candidates. Needs SMTP_HOST/PORT/USER/PASS, ALERT_EMAIL_FROM and
// ALERT_EMAIL_TO to actually send — without them this logs what it would have
// sent and does nothing else, so turning the job on early is harmless.

const { sendMail, isConfigured } = require('../lib/mailer');
const { checkOrder } = require('../lib/stuck-order-check');

const INTERVAL_MS = Number(process.env.ALERT_DIGEST_INTERVAL_MS || 24 * 60 * 60 * 1000);

// Fixed clock time, UTC (Railway's default unless TZ is set), to send at
// every day — e.g. ALERT_DIGEST_HOUR_UTC=22 for 8am AEST. Without this,
// "once a day" only ever meant "every 24h counted from whenever the process
// last started", so a redeploy silently shifted what time of day it actually
// fires. Leave unset to keep that simpler boot-relative behavior instead.
const DIGEST_HOUR_UTC =
  process.env.ALERT_DIGEST_HOUR_UTC !== undefined ? Number(process.env.ALERT_DIGEST_HOUR_UTC) : null;
const hasFixedHour = Number.isInteger(DIGEST_HOUR_UTC) && DIGEST_HOUR_UTC >= 0 && DIGEST_HOUR_UTC <= 23;

// Milliseconds until the next occurrence of `hour:00 UTC` — today if it
// hasn't happened yet, otherwise tomorrow. Pure and testable: takes "now"
// explicitly rather than reading the clock itself.
function msUntilNextHour(hour, now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

// How far back to look for CANDIDATES. Wide by default, same reasoning as
// stuck-schedules.js: a row that exhausted its retries stops updating from
// that point on, so "recently touched" is the wrong filter for "currently
// still broken" — an order that went quiet weeks ago and was never fixed
// should keep appearing as a candidate, not age out of consideration. Every
// candidate still gets verified live, so a wide window costs API calls, not
// stale answers.
const HOURS = Number(process.env.ALERT_DIGEST_HOURS || 24 * 30);

// A cap, not a target: if something systemic broke and hundreds of orders are
// affected, the digest names the count and the first MAX, rather than a
// single email long enough to be unreadable.
const MAX_ROWS = Number(process.env.ALERT_DIGEST_MAX_ROWS || 25);

// The Shopify admin URL for an order, built from SHOPIFY_STORE
// ("workoutmeals.myshopify.com" -> ".../store/workoutmeals/orders/<id>").
// Best-effort: an unusual store domain just means no link, not a crash.
function orderUrl(orderId) {
  const store = String(process.env.SHOPIFY_STORE || '');
  const handle = store.replace(/\.myshopify\.com$/, '');
  if (!handle || handle === store) return null;
  return `https://admin.shopify.com/store/${handle}/orders/${orderId}`;
}

// Pure and side-effect-free on purpose, so it's testable without a database,
// Shopify, or SMTP.
// stuckOrders: [{ orderId, orderName, subscriptionId, detail }]
// Returns null when there's nothing worth emailing.
function buildDigestEmail(stuckOrders, { store = process.env.SHOPIFY_STORE || '(store not set)' } = {}) {
  if (!stuckOrders.length) return null;

  const shown = stuckOrders.slice(0, MAX_ROWS);
  const overflow = stuckOrders.length - shown.length;

  const lines = shown.map((o) => {
    const label = o.subscriptionId
      ? `subscription ${o.subscriptionId}, order ${o.orderName || o.orderId}`
      : `order ${o.orderName || o.orderId}`;
    const url = orderUrl(o.orderId);
    return `  - ${label}\n    ${o.detail}` + (url ? `\n    ${url}` : '');
  });

  const subject = `[HDS] ${stuckOrders.length} order(s) still missing pack date / HDS data`;

  const text =
    `${store} — ${stuckOrders.length} order(s) checked live just now and confirmed still missing their ` +
    `HDS data (pack date, delivery schedule, etc.). These do not self-heal on their own; each needs a ` +
    `human decision.\n\n` +
    lines.join('\n\n') +
    (overflow > 0 ? `\n\n  ...and ${overflow} more not shown.` : '') +
    '\n\n' +
    'For the full picture with every category (stuck / already fixed / other cause):\n' +
    '  node src/scripts/stuck-schedules.js\n\n' +
    'To fix one order once you know which day to move it to:\n' +
    '  RENEWAL_DELIVERY_SELECTION=earliest node src/scripts/order-fix.js --order <id> --force\n';

  return { subject, text };
}

async function runDigest() {
  if (!process.env.DATABASE_URL) {
    console.log('[alert-digest] skipped: no DATABASE_URL');
    return { sent: false, count: 0 };
  }

  const { pool } = require('../db');
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (COALESCE(subscription_id::text, order_id::text))
        order_id, subscription_id
       FROM orders_to_enrich
      WHERE (status = 'failed' OR hds_write_ok = FALSE)
        AND updated_at >= NOW() - ($1::int * INTERVAL '1 hour')
      ORDER BY COALESCE(subscription_id::text, order_id::text), updated_at DESC`,
    [HOURS]
  );

  console.log(`[alert-digest] verifying ${rows.length} candidate(s) against Shopify + HDS...`);

  const stuckOrders = [];
  let fixed = 0;
  let other = 0;
  let skipped = 0;

  for (const row of rows) {
    const result = await checkOrder(row.order_id);
    if (result.verdict === 'stuck') {
      stuckOrders.push({
        orderId: row.order_id,
        orderName: result.order?.name,
        subscriptionId: row.subscription_id,
        detail: result.detail,
      });
    } else if (result.verdict === 'fixed') {
      fixed += 1;
    } else if (result.verdict === 'other') {
      other += 1;
    } else {
      skipped += 1;
    }
  }

  console.log(
    `[alert-digest] ${stuckOrders.length} genuinely stuck, ${fixed} already fixed, ${other} other cause, ${skipped} skipped`
  );

  const email = buildDigestEmail(stuckOrders);
  if (!email) {
    console.log(`[alert-digest] nothing genuinely stuck in the last ${HOURS}h — no email sent`);
    return { sent: false, count: 0 };
  }

  if (!isConfigured()) {
    console.log(
      `[alert-digest] ${stuckOrders.length} order(s) stuck, but SMTP is not configured — would have sent:\n` +
        `  subject: ${email.subject}`
    );
    return { sent: false, count: stuckOrders.length };
  }

  const result = await sendMail(email);
  console.log(`[alert-digest] ${stuckOrders.length} order(s) stuck — emailed ${result.to.join(', ')}`);
  return { sent: true, count: stuckOrders.length };
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

  const smtpNote = isConfigured() ? 'SMTP configured' : 'SMTP NOT configured — will log only';
  const runOnce = () => runDigest().catch((err) => console.error('[alert-digest] pass failed:', err.message || err));

  if (hasFixedHour) {
    const delay = msUntilNextHour(DIGEST_HOUR_UTC);
    console.log(
      `[alert-digest] started (daily at ${String(DIGEST_HOUR_UTC).padStart(2, '0')}:00 UTC, ` +
        `first run in ${Math.round(delay / 60000)}m, looking back ${HOURS}h, ${smtpNote})`
    );
    // Re-scheduled after each run rather than a single 24h setInterval, so a
    // long-running process doesn't quietly drift off the target hour.
    const tick = () => {
      runOnce();
      setTimeout(tick, msUntilNextHour(DIGEST_HOUR_UTC, new Date(Date.now() + 60000)));
    };
    setTimeout(tick, delay);
  } else {
    console.log(
      `[alert-digest] started (every ${Math.round(INTERVAL_MS / 3600000)}h from boot — set ` +
        `ALERT_DIGEST_HOUR_UTC for a fixed daily time instead, looking back ${HOURS}h, ${smtpNote})`
    );
    setInterval(runOnce, INTERVAL_MS);
  }
}

module.exports = { initAlertDigest, runDigest, buildDigestEmail, msUntilNextHour };
