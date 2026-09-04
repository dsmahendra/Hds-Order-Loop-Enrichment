// The backstop: find recent orders missing their HDS data and fix them.
//
// Everything else in this service hangs off the webhook. That is one delivery
// attempt for one order, and there are failure modes no amount of retrying
// inside the handler can cover:
//
//   - Shopify never delivered the webhook (it retries a while, then gives up)
//   - the HMAC did not verify, so the handler returned 401 and never ran
//   - the process restarted mid-handling — a deploy during a Loop renewal run
//   - the queue row was never written, so the retry job has nothing to find
//
// In every one of those the order simply has no pack date, and nothing in our own
// tables says so. The retry job cannot help: it reads rows, and there is no row.
//
// So this asks Shopify instead. It walks the orders created in the last few hours
// and, for any whose HDS data is incomplete, runs the same applyHdsToOrder the
// webhook does. Independent of the webhook and of our queue, which makes it the
// one check that can actually answer "does every order have a pack date".
//
// Deliberately cheap: deciding what needs work costs no API calls at all — both
// planFor and the date tags are computed from the order payload already in hand —
// so a quiet pass is one or two page reads and nothing else.

const { listOrders, getNoteAttribute } = require('../shopify');
const { applyHdsToOrder, planFor } = require('../lib/apply-hds');
const { HELD_TAG } = require('../lib/renewal-rewrite');
const { missingTags, taggingEnabled } = require('../lib/order-tags');

const INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 30 * 60 * 1000);
const WINDOW_HOURS = Number(process.env.SWEEP_HOURS || 24);

// An order created seconds ago is probably still in the webhook handler. Fixing
// it here too would double every write during a burst — exactly when the API
// budget matters most — so give the handler first go.
const MIN_AGE_MINUTES = Number(process.env.SWEEP_MIN_AGE_MINUTES || 10);

// A bound on one pass. If something systemic broke and hundreds of orders need
// fixing, repairing them over several passes is better than spending the whole
// rate limit at once and starving the live webhooks.
const MAX_FIXES = Number(process.env.SWEEP_MAX_FIXES || 25);

let running = false;

const isHeld = (order) =>
  String(order?.tags || '')
    .split(',')
    .some((t) => t.trim() === HELD_TAG);

// Why this order needs attention, or null if it does not. Makes no API calls.
function needsWork(order) {
  const plan = planFor(order);

  if (plan.action === 'rewrite' || plan.action === 'fill') return { plan, why: plan.reason };
  if (plan.action === 'hold') return null; // visible by its tag; not ours to force

  // Dates are complete. The date tags derive from the order itself, so a missing
  // one is detectable without asking Loop anything — and a missing date tag is
  // the signature of a webhook that never ran.
  if (taggingEnabled()) {
    const missing = missingTags(order, null);
    if (missing.length) return { plan, why: `missing tag(s) ${missing.join(', ')}` };
  }
  return null;
}

const packDateOf = (order) =>
  getNoteAttribute(order, 'Pick-Pack-Date') ||
  getNoteAttribute(order, 'HDS Ship Date') ||
  getNoteAttribute(order, 'HDS Pack Date');

// Best effort. The sweep's whole value is that it works without our tables, so a
// DB problem must not stop it — it records the outcome only when it can, to save
// the retry job repeating work already done.
async function clearRetryFlag(orderId) {
  if (!process.env.DATABASE_URL) return;
  try {
    const { pool } = require('../db');
    await pool.query(
      `UPDATE orders_to_enrich
          SET hds_write_ok = TRUE, updated_at = NOW()
        WHERE order_id = $1 AND hds_write_ok = FALSE`,
      [orderId]
    );
  } catch {
    // Nothing useful to do here, and the sweep itself already succeeded.
  }
}

async function sweep() {
  const now = Date.now();
  const since = new Date(now - WINDOW_HOURS * 3600 * 1000).toISOString();
  const newestAllowed = now - MIN_AGE_MINUTES * 60 * 1000;

  let pageInfo = null;
  let scanned = 0;
  let tooNew = 0;
  let held = 0;
  const candidates = [];

  do {
    const res = await listOrders({
      limit: 250,
      pageInfo,
      createdAtMin: pageInfo ? null : since,
      fields: pageInfo
        ? null
        : 'id,name,created_at,tags,note_attributes,shipping_address,line_items',
    });
    pageInfo = res.pageInfo;
    if (!res.orders.length) break;

    for (const order of res.orders) {
      scanned += 1;

      if (new Date(order.created_at).getTime() > newestAllowed) {
        tooNew += 1;
        continue;
      }
      if (isHeld(order)) {
        held += 1;
        continue;
      }

      const work = needsWork(order);
      if (work) candidates.push({ order, ...work });
    }
  } while (pageInfo);

  if (!candidates.length) {
    console.log(
      `[sweep] ${scanned} order(s) in the last ${WINDOW_HOURS}h — all complete` +
        (tooNew ? `, ${tooNew} too new to judge` : '') +
        (held ? `, ${held} held` : '')
    );
    return { scanned, fixed: 0, failed: 0, candidates: 0 };
  }

  console.warn(
    `[sweep] ${candidates.length} of ${scanned} order(s) in the last ${WINDOW_HOURS}h are incomplete` +
      (candidates.length > MAX_FIXES ? ` — fixing ${MAX_FIXES} this pass` : '')
  );

  let fixed = 0;
  let failed = 0;

  for (const { order, why } of candidates.slice(0, MAX_FIXES)) {
    const label = order.name || order.id;
    try {
      // atCreation false: this runs long after the charge, so the subscription's
      // completed count no longer describes this order and a billing-cycle tag
      // taken from it would be wrong.
      const out = await applyHdsToOrder(order, { atCreation: false });

      if (!out.ok) {
        failed += 1;
        console.warn(`[sweep] ${label}: ${out.action} failed — ${out.reason} (was: ${why})`);
        continue;
      }

      fixed += 1;
      const pack = out.wrote?.['Pick-Pack-Date'] || packDateOf(order) || null;
      console.log(
        `[sweep] ${label}: ${out.action} — ${why}` +
          (pack ? `, pack ${pack}` : '') +
          (out.tagsAdded.length ? `, tags ${out.tagsAdded.join(', ')}` : '')
      );
      await clearRetryFlag(order.id);
    } catch (err) {
      failed += 1;
      const reason = (err.message || String(err)).split('\n')[0];
      console.warn(`[sweep] ${label}: ${reason}`);

      // Credentials or scopes fail identically for every remaining order, so stop
      // rather than spend the rest of the pass rediscovering that.
      if (/failed 40[13]|not set|no Admin API token/i.test(err.message || '')) {
        console.error('[sweep] stopping this pass: the Admin API is not usable');
        break;
      }
    }
  }

  console.log(`[sweep] pass done: ${fixed} fixed, ${failed} failed.`);
  return { scanned, fixed, failed, candidates: candidates.length };
}

async function tick() {
  if (running) return; // a slow pass must not overlap the next
  running = true;
  try {
    await sweep();
  } catch (err) {
    console.error('[sweep] pass failed:', err.message || err);
  } finally {
    running = false;
  }
}

function initPackDateSweep() {
  if (String(process.env.SWEEP_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('[sweep] disabled (SWEEP_ENABLED=false)');
    return;
  }

  console.log(
    `[sweep] started (every ${Math.round(INTERVAL_MS / 60000)}m over the last ${WINDOW_HOURS}h, ` +
      `ignoring orders under ${MIN_AGE_MINUTES}m old, up to ${MAX_FIXES} fixes per pass)`
  );

  // Not on boot: a restart is exactly when a webhook backlog is being delivered,
  // and sweeping into that duplicates the work. One interval later the picture
  // has settled.
  setInterval(tick, INTERVAL_MS);
}

module.exports = { initPackDateSweep, sweep, tick, needsWork };
