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
// A genuinely persistent problem (nobody's fixed the subscription yet) would
// otherwise repeat in EVERY send — every day, and every one of several times
// a day if ALERT_DIGEST_TIMES_UTC configures more than one. alert_digest_
// notifications (see db/schema.sql) suppresses an order that already
// appeared in an email within ALERT_DIGEST_DEDUPE_HOURS, so it resurfaces as
// roughly one reminder per day rather than the same line every time.
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

// Fixed clock times, UTC (Railway's default unless TZ is set), to send at
// every day — one or more "HH:MM", comma-separated, e.g.
// ALERT_DIGEST_TIMES_UTC=03:05,07:05 for 1:05pm and 5:05pm AEST. Without
// this, "once a day" only ever meant "every ALERT_DIGEST_INTERVAL_MS counted
// from whenever the process last started", so a redeploy silently shifted
// what time of day it actually fires. Leave unset to keep that simpler
// boot-relative behavior instead.
//
// AEST is UTC+10 and only holds outside daylight saving (roughly Apr-Oct for
// NSW/VIC; QLD never observes it). During AEDT (UTC+11, Oct-Apr) these fixed
// UTC times land an hour later by AU east-coast clocks — adjust by -1 hour
// (subtract 60 from the minutes-of-day, i.e. an hour earlier in UTC) if that
// matters for your use, or accept the twice-yearly hour shift.
function parseHHMM(value) {
  const m = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

const DIGEST_TIMES_UTC = String(process.env.ALERT_DIGEST_TIMES_UTC || '')
  .split(',')
  .map(parseHHMM)
  .filter(Boolean);

// Milliseconds until the next occurrence of `hour:minute UTC` — today if it
// hasn't happened yet, otherwise tomorrow. Pure and testable: takes "now"
// explicitly rather than reading the clock itself. Exactly on the instant
// counts as already happened (rolls to tomorrow), not still pending.
function msUntilNextHour(hour, now = new Date(), minute = 0) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

// The soonest of several daily times — whichever of today's/tomorrow's
// occurrences comes first. Cycles through every configured time across a day
// (fire at 03:05, recompute, the next soonest is naturally today's 07:05; fire
// that, the next soonest is tomorrow's 03:05) without needing a separate timer
// per configured time.
function msUntilNextOccurrence(times, now = new Date()) {
  return Math.min(...times.map((t) => msUntilNextHour(t.hour, now, t.minute)));
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

// How long a "still stuck" order is suppressed after appearing in an email,
// before it's allowed to appear again. Sending several times a day
// (ALERT_DIGEST_TIMES_UTC) would otherwise repeat the identical still-broken
// order in every send; this keeps a persistent problem to roughly one
// reminder per day instead. Deliberately a little under 24h so a 1:05pm/5:05pm
// pair doesn't accidentally both land on the wrong side of an exact-24h
// boundary and either double up or skip a day.
const DEDUPE_HOURS = Number(process.env.ALERT_DIGEST_DEDUPE_HOURS || 20);

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

  // Drop anything already reported within the dedupe window — this run only
  // ever adds NEW ground to cover, not the same lines again.
  const newOrders = await filterAlreadyNotified(pool, stuckOrders);
  const suppressed = stuckOrders.length - newOrders.length;
  if (suppressed) {
    console.log(`[alert-digest] ${suppressed} of those already reported within the last ${DEDUPE_HOURS}h — not repeating`);
  }

  const email = buildDigestEmail(newOrders);
  if (!email) {
    console.log(`[alert-digest] nothing new to report in the last ${HOURS}h — no email sent`);
    return { sent: false, count: 0 };
  }

  if (!isConfigured()) {
    console.log(
      `[alert-digest] ${newOrders.length} order(s) stuck, but SMTP is not configured — would have sent:\n` +
        `  subject: ${email.subject}`
    );
    return { sent: false, count: newOrders.length };
  }

  const result = await sendMail(email);
  console.log(`[alert-digest] ${newOrders.length} order(s) stuck — emailed ${result.to.join(', ')}`);
  // Recorded only once actually reported, so a failed send (thrown above,
  // never reaching here) gets a genuine retry next pass instead of being
  // silently suppressed for having "already" been sent.
  await markNotified(pool, newOrders);
  return { sent: true, count: newOrders.length };
}

// Of these stuck orders, which have NOT already been reported within
// DEDUPE_HOURS. Best-effort: a lookup failure means nothing is suppressed
// (fails open) rather than silently dropping a genuine problem from the email.
async function filterAlreadyNotified(pool, stuckOrders) {
  if (!stuckOrders.length) return stuckOrders;
  try {
    const { rows } = await pool.query(
      `SELECT order_id FROM alert_digest_notifications
        WHERE order_id = ANY($1::bigint[])
          AND last_notified_at >= NOW() - ($2::int * INTERVAL '1 hour')`,
      [stuckOrders.map((o) => o.orderId), DEDUPE_HOURS]
    );
    const recent = new Set(rows.map((r) => String(r.order_id)));
    return stuckOrders.filter((o) => !recent.has(String(o.orderId)));
  } catch (err) {
    console.warn('[alert-digest] could not check dedupe history, reporting all of them:', err.message);
    return stuckOrders;
  }
}

// Best-effort: a write failure here just means a future pass may repeat one
// of these — annoying, never silent data loss the way suppressing a genuine
// problem would be.
async function markNotified(pool, stuckOrders) {
  if (!stuckOrders.length) return;
  try {
    await pool.query(
      `INSERT INTO alert_digest_notifications (order_id, last_notified_at)
         SELECT unnest($1::bigint[]), NOW()
       ON CONFLICT (order_id) DO UPDATE SET last_notified_at = NOW()`,
      [stuckOrders.map((o) => o.orderId)]
    );
  } catch (err) {
    console.warn('[alert-digest] could not record dedupe history:', err.message);
  }
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

  if (DIGEST_TIMES_UTC.length) {
    const label = DIGEST_TIMES_UTC.map((t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`).join(
      ', '
    );
    const delay = msUntilNextOccurrence(DIGEST_TIMES_UTC);
    console.log(
      `[alert-digest] started (daily at ${label} UTC, first run in ${Math.round(delay / 60000)}m, ` +
        `looking back ${HOURS}h, ${smtpNote})`
    );
    // Re-scheduled after each run rather than fixed setIntervals, so a
    // long-running process can't drift off the target times, and so several
    // times in the same day are handled by one recurring timer instead of one
    // per configured time.
    const tick = () => {
      runOnce();
      setTimeout(tick, msUntilNextOccurrence(DIGEST_TIMES_UTC, new Date(Date.now() + 60000)));
    };
    setTimeout(tick, delay);
  } else {
    console.log(
      `[alert-digest] started (every ${Math.round(INTERVAL_MS / 3600000)}h from boot — set ` +
        `ALERT_DIGEST_TIMES_UTC for fixed daily times instead, looking back ${HOURS}h, ${smtpNote})`
    );
    setInterval(runOnce, INTERVAL_MS);
  }
}

module.exports = { initAlertDigest, runDigest, buildDigestEmail, msUntilNextHour, msUntilNextOccurrence, parseHHMM };
