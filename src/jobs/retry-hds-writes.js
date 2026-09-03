// Retry the orders whose HDS write did not land.
//
// The webhook gets one attempt. If it fails — HDS unreachable, a wrong
// HDS_API_BASE, a Shopify write rejected, the suburb momentarily unserviceable —
// nothing ever tried again, and that order simply had no pack date until someone
// noticed and ran the backfill by hand. The enrichment queue does not cover this:
// it fills our own tables, not the order in Shopify.
//
// So the rows the webhook could not complete are re-attempted here, on a slow
// interval, with a bounded number of tries so a genuinely impossible order (a
// suburb HDS does not serve) stops consuming API calls instead of being retried
// forever.

const { pool } = require('../db');
const { getOrder } = require('../shopify');
const { applyHdsToOrder } = require('../lib/apply-hds');

// Slow on purpose: this is a safety net, not the main path. The webhook handles
// the normal case within a second of the order existing.
const INTERVAL_MS = Number(process.env.HDS_RETRY_INTERVAL_MS || 15 * 60 * 1000);
const BATCH = Number(process.env.HDS_RETRY_BATCH || 10);
const MAX_ATTEMPTS = Number(process.env.HDS_RETRY_MAX_ATTEMPTS || 6);

let running = false;

// Rows the webhook left incomplete. 'skipped' covers a held order and one whose
// rewrite failed; 'failed' covers an exhausted enrichment. Oldest first, so a
// backlog drains in the order it accumulated.
const SELECT_PENDING = `
  SELECT order_id, status, attempts, error_message
    FROM orders_to_enrich
   WHERE status IN ('skipped', 'failed')
     AND attempts < $1
   ORDER BY id ASC
   LIMIT $2
`;

async function retryOne(row) {
  const orderId = row.order_id;

  // Read the order fresh: it may have been corrected by hand since, in which case
  // applyHdsToOrder finds nothing to do and the row is closed out.
  const order = (await getOrder(orderId))?.order;
  if (!order) throw new Error('order not found in Shopify');

  const out = await applyHdsToOrder(order, { atCreation: false });

  if (!out.ok) {
    await pool.query(
      `UPDATE orders_to_enrich
          SET attempts = attempts + 1, error_message = $2, updated_at = NOW()
        WHERE order_id = $1`,
      [orderId, `retry: ${out.reason}`]
    );
    console.warn(`[retry] order ${orderId}: still failing — ${out.reason}`);
    return false;
  }

  // It worked. Hand the row back to the enrichment queue so the derived data is
  // rebuilt from the corrected attributes.
  await pool.query(
    `UPDATE orders_to_enrich
        SET status = 'pending', attempts = 0, error_message = NULL, updated_at = NOW()
      WHERE order_id = $1`,
    [orderId]
  );

  const pack = out.wrote?.['Pick-Pack-Date'];
  console.log(
    `[retry] order ${orderId}: ${out.action}` +
      (pack ? `, pack ${pack}` : '') +
      (out.tagsAdded.length ? `, tags ${out.tagsAdded.join(', ')}` : '')
  );
  return true;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const { rows } = await pool.query(SELECT_PENDING, [MAX_ATTEMPTS, BATCH]);
    if (!rows.length) return;

    console.log(`[retry] ${rows.length} order(s) to re-attempt`);
    for (const row of rows) {
      try {
        await retryOne(row);
      } catch (err) {
        const reason = (err.message || String(err)).split('\n')[0];
        await pool
          .query(
            `UPDATE orders_to_enrich
                SET attempts = attempts + 1, error_message = $2, updated_at = NOW()
              WHERE order_id = $1`,
            [row.order_id, `retry: ${reason}`]
          )
          .catch(() => {});
        console.warn(`[retry] order ${row.order_id}: ${reason}`);

        // A credentials or scope problem fails identically for every row, so stop
        // rather than burn the whole batch discovering that.
        if (/failed 40[13]|not set|no Admin API token/i.test(err.message || '')) {
          console.error('[retry] stopping this pass: the Admin API is not usable');
          break;
        }
      }
    }
  } catch (err) {
    console.error('[retry] pass failed:', err.message || err);
  } finally {
    running = false;
  }
}

function initHdsRetry() {
  if (String(process.env.HDS_RETRY_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('[retry] disabled (HDS_RETRY_ENABLED=false)');
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.log('[retry] disabled: no DATABASE_URL, so there is no record of what to retry');
    return;
  }

  console.log(
    `[retry] started (every ${INTERVAL_MS < 60000 ? Math.round(INTERVAL_MS / 1000) + 's' : Math.round(INTERVAL_MS / 60000) + 'm'}, ` +
      `batch ${BATCH}, up to ${MAX_ATTEMPTS} attempts)`
  );
  setInterval(tick, INTERVAL_MS);
}

module.exports = { initHdsRetry, tick };
