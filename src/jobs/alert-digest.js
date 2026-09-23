// Email admin a periodic status report — ALWAYS sent, whether every order is
// fine or not, so a quiet inbox never has to be trusted as "no news is good
// news". Two sections:
//
//   1. Every Loop subscription order since the last report, each with its own
//      status line (order:label) — done, missing its pack date, missing OTHER
//      HDS fields, or present-but-wrong. Sent even when every single one is
//      fine, so admin can see the checker is actually running.
//   2. Anything from a wider historical scan that's genuinely stuck on a
//      weekday HDS has withdrawn for its suburb — these don't self-heal, so
//      they're deduped (alert_digest_notifications) rather than repeated in
//      every send.
//
//   node src/scripts/alert-digest-now.js     run one pass immediately
//
// Needs DATABASE_URL, SHOPIFY_STORE + SHOPIFY_ADMIN_TOKEN, and HDS_API_BASE to
// verify candidates. Needs SMTP_HOST/PORT/USER/PASS, ALERT_EMAIL_FROM and
// ALERT_EMAIL_TO to actually send — without them this logs the full report
// and does nothing else, so turning the job on early is harmless.

const { sendMail, isConfigured } = require('../lib/mailer');
const { checkOrder } = require('../lib/stuck-order-check');
const { classifyOrderWithReason } = require('../lib/order-status');
const { getOrder } = require('../shopify');

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

// How far back the very FIRST report (ever, or after alert_digest_runs is
// cleared) looks for Loop orders, since there's no previous run to measure
// "since last time" from.
const FIRST_RUN_HOURS = Number(process.env.ALERT_DIGEST_FIRST_RUN_HOURS || 24);

// How far back to look for STUCK-schedule CANDIDATES (section 2 — a much
// wider window than section 1's "since last report", same reasoning as
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

// How long a "still stuck" order (section 2 only — section 1 never repeats an
// order because its window never overlaps the previous report) is suppressed
// after appearing in an email, before it's allowed to appear again. A
// persistent problem would otherwise repeat in EVERY send. Deliberately a
// little under 24h so a 1:05pm/5:05pm pair doesn't accidentally both land on
// the wrong side of an exact-24h boundary and either double up or skip a day.
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
// Shopify, or SMTP. NEVER returns null — always sent, "all clear" included.
//
// orderStatuses: [{ orderId, orderName, status, label }] — status 'done'
//                counts as OK, anything else needs a look.
// stuckOrders:   [{ orderId, orderName, subscriptionId, detail }]
function buildReportEmail(orderStatuses, stuckOrders, { store = process.env.SHOPIFY_STORE || '(store not set)' } = {}) {
  const problems = orderStatuses.filter((o) => o.status !== 'done');

  const shownOrders = orderStatuses.slice(0, MAX_ROWS);
  const overflowOrders = orderStatuses.length - shownOrders.length;
  const orderLines = shownOrders.map((o) => `  Order ${o.orderName || o.orderId} = ${o.label}`);

  const shownStuck = stuckOrders.slice(0, MAX_ROWS);
  const overflowStuck = stuckOrders.length - shownStuck.length;
  const stuckLines = shownStuck.map((o) => {
    const label = o.subscriptionId
      ? `subscription ${o.subscriptionId}, order ${o.orderName || o.orderId}`
      : `order ${o.orderName || o.orderId}`;
    const url = orderUrl(o.orderId);
    return `  - ${label}\n    ${o.detail}` + (url ? `\n    ${url}` : '');
  });

  const subject = !orderStatuses.length
    ? `[HDS] Order status report — no new Loop orders since last check`
    : !problems.length
      ? `[HDS] Order status report — all ${orderStatuses.length} order(s) OK`
      : `[HDS] Order status report — ${problems.length} of ${orderStatuses.length} order(s) need attention`;

  let text = `${store} — Loop subscription order status report.\n\n`;

  if (!orderStatuses.length) {
    text += 'No new Loop subscription orders since the last report.\n';
  } else {
    text += `${orderStatuses.length} Loop subscription order(s) since the last report`;
    text += problems.length ? `, ${problems.length} need attention:\n\n` : ', all fine:\n\n';
    text += orderLines.join('\n');
    if (overflowOrders > 0) text += `\n  ...and ${overflowOrders} more not shown.`;
    text += '\n';
  }

  if (stuckOrders.length) {
    text +=
      `\n${stuckOrders.length} order(s) from earlier are stuck on a weekday HDS no longer offers for their ` +
      `suburb (these do NOT self-heal — each needs a human decision on which day to move it to):\n\n` +
      stuckLines.join('\n\n') +
      (overflowStuck > 0 ? `\n\n  ...and ${overflowStuck} more not shown.` : '') +
      '\n';
  }

  text +=
    '\nFor the full picture (including whether each is a real schedule problem or something else):\n' +
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

  // --- Section 1: every Loop order since the last report --------------------
  const { rows: lastRun } = await pool.query('SELECT MAX(ran_at) AS last_run FROM alert_digest_runs');
  const since = lastRun[0]?.last_run || null;

  const orderRows = since
    ? await pool.query(
        `SELECT DISTINCT order_id FROM orders_to_enrich
          WHERE source = 'loop' AND created_at >= $1
          ORDER BY order_id`,
        [since]
      )
    : await pool.query(
        `SELECT DISTINCT order_id FROM orders_to_enrich
          WHERE source = 'loop' AND created_at >= NOW() - ($1::int * INTERVAL '1 hour')
          ORDER BY order_id`,
        [FIRST_RUN_HOURS]
      );

  console.log(
    `[alert-digest] checking ${orderRows.rows.length} Loop order(s) since ` +
      (since ? new Date(since).toISOString() : `${FIRST_RUN_HOURS}h ago (first run)`)
  );

  const orderStatuses = [];
  for (const row of orderRows.rows) {
    let order;
    try {
      order = (await getOrder(row.order_id))?.order;
    } catch (err) {
      orderStatuses.push({
        orderId: row.order_id,
        orderName: null,
        status: 'error',
        label: `could not check — ${err.message.split('\n')[0]}`,
      });
      continue;
    }
    if (!order) continue; // deleted since being queued — nothing to report

    // The WHY, not just the category — a live dry-run through the same
    // decision order:fix/the sweep would make, so "pack date not updated"
    // comes with "Kingston 2604: no Thursday schedule (offers ...)" attached
    // rather than leaving that to a separate order:explain lookup.
    const c = await classifyOrderWithReason(order);
    orderStatuses.push({
      orderId: row.order_id,
      orderName: order.name,
      status: c.status,
      label: c.reason ? `${c.label} — ${c.reason}` : c.label,
    });
  }

  const byStatus = orderStatuses.reduce((acc, o) => {
    acc[o.status] = (acc[o.status] || 0) + 1;
    return acc;
  }, {});
  console.log(`[alert-digest] section 1: ${JSON.stringify(byStatus)}`);

  // --- Section 2: genuinely stuck on a withdrawn weekday (wider window) -----
  const { rows: stuckCandidates } = await pool.query(
    `SELECT DISTINCT ON (COALESCE(subscription_id::text, order_id::text))
        order_id, subscription_id
       FROM orders_to_enrich
      WHERE (status = 'failed' OR hds_write_ok = FALSE)
        AND updated_at >= NOW() - ($1::int * INTERVAL '1 hour')
      ORDER BY COALESCE(subscription_id::text, order_id::text), updated_at DESC`,
    [HOURS]
  );

  console.log(`[alert-digest] section 2: verifying ${stuckCandidates.length} candidate(s) against Shopify + HDS...`);

  const stuckOrders = [];
  for (const row of stuckCandidates) {
    const result = await checkOrder(row.order_id);
    if (result.verdict === 'stuck') {
      stuckOrders.push({
        orderId: row.order_id,
        orderName: result.order?.name,
        subscriptionId: row.subscription_id,
        detail: result.detail,
      });
    }
  }

  const newStuck = await filterAlreadyNotified(pool, stuckOrders);
  const suppressed = stuckOrders.length - newStuck.length;
  console.log(
    `[alert-digest] section 2: ${stuckOrders.length} genuinely stuck` +
      (suppressed ? `, ${suppressed} already reported within ${DEDUPE_HOURS}h — not repeating` : '')
  );

  // --- Always send, "all clear" included -------------------------------------
  const email = buildReportEmail(orderStatuses, newStuck);

  if (!isConfigured()) {
    console.log(`[alert-digest] SMTP is not configured — would have sent:\n  subject: ${email.subject}\n\n${email.text}`);
  } else {
    const result = await sendMail(email);
    console.log(
      `[alert-digest] emailed ${result.to.join(', ')}` +
        (result.bcc?.length ? ` (bcc ${result.bcc.join(', ')})` : '') +
        ` — ${email.subject}`
    );
  }

  if (newStuck.length) await markNotified(pool, newStuck);
  await pool.query('INSERT INTO alert_digest_runs (ran_at) VALUES (NOW())');

  return { sent: isConfigured(), orderCount: orderStatuses.length, stuckCount: newStuck.length };
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
        `looking back ${HOURS}h for section 2, ${smtpNote})`
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
        `ALERT_DIGEST_TIMES_UTC for fixed daily times instead, looking back ${HOURS}h for section 2, ${smtpNote})`
    );
    setInterval(runOnce, INTERVAL_MS);
  }
}

module.exports = {
  initAlertDigest,
  runDigest,
  buildReportEmail,
  msUntilNextHour,
  msUntilNextOccurrence,
  parseHHMM,
};
