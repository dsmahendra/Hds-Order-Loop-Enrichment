const express = require('express');
const { pool } = require('../db');
const {
  verifyWebhook,
  webhookDigest,
  getNoteAttribute,
  getHdsAttributes,
  normalizeDate,
} = require('../shopify');
const { editChargeOffsetRetrying, subscriptionIdForOrderRetrying } = require('../loop');
const { needsRewrite, rewriteRenewalOrder, cutoffFor } = require('../lib/renewal-rewrite');
const { buildHdsAttributes } = require('../lib/renewal-date');

// Recompute stale renewal dates and write them back onto the order — the job
// Arigato Automation was doing. Set REWRITE_RENEWAL_DATES=false to stand this
// down without a deploy (e.g. while Arigato is still live, so the two don't both
// write to the same order).
const REWRITE_RENEWALS =
  String(process.env.REWRITE_RENEWAL_DATES || 'true').toLowerCase() !== 'false';

const router = express.Router();

// Shopify "Order creation" webhook.
// IMPORTANT: mounted with a RAW body parser (see index.js) so HMAC can be
// verified against the exact bytes Shopify sent.
router.post('/shopify/orders/create', async (req, res) => {
  const rawBody = req.body; // Buffer, from express.raw
  const hmac = req.get('X-Shopify-Hmac-Sha256');

  if (!verifyWebhook(rawBody, hmac)) {
    // A bare "verification failed" can't distinguish a missing secret from a
    // wrong one, and that was costing whole debugging cycles. Digest prefixes
    // are safe to log — the secret itself never appears.
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    const expected = webhookDigest(rawBody);
    console.warn(
      '[webhook] HMAC verification failed — ' +
        `SHOPIFY_WEBHOOK_SECRET ${secret ? `set (${secret.length} chars)` : 'MISSING'}, ` +
        `X-Shopify-Hmac-Sha256 ${hmac ? 'present' : 'MISSING'}, ` +
        `body ${rawBody?.length ?? 0} bytes` +
        (expected && hmac
          ? `, computed ${expected.slice(0, 10)}… vs received ${String(hmac).slice(0, 10)}…` +
            ' (different ⇒ wrong secret: use the value Shopify shows on the webhook page,' +
            ' or the app API secret key if the webhook was created by a custom app)'
          : '')
    );
    return res.status(401).send('invalid hmac');
  }

  // Acknowledge fast; do the work in the background queue.
  res.status(200).send('ok');

  let order;
  try {
    order = JSON.parse(rawBody.toString('utf8'));
  } catch {
    console.warn('[webhook] could not parse body');
    return;
  }

  const orderId = order?.id;
  if (!orderId) {
    console.warn('[webhook] payload had no order id');
    return;
  }

  // Accept the labelled keys the checkout extension writes ("HDS Delivery Date"),
  // the legacy snake_case, and the Delivery-* contract keys. Dates arrive as
  // yyyy/mm/dd, so normalise to ISO for the DATE column and API matching.
  const rawDeliveryDate = firstAttribute(order, [
    'HDS Delivery Date',
    'hds_delivery_date',
    'Delivery-Date',
  ]);
  const deliveryDate = rawDeliveryDate ? normalizeDate(rawDeliveryDate) : null;

  const source = isLoopOrder(order) ? 'loop' : 'checkout';

  const postcode =
    firstAttribute(order, ['HDS Postcode', 'hds_postcode', 'Delivery-Location-Id']) ||
    order?.shipping_address?.zip ||
    null;
  const suburb =
    firstAttribute(order, ['HDS Suburb', 'hds_suburb']) ||
    order?.shipping_address?.city ||
    null;
  const deliveryTime = firstAttribute(order, [
    'HDS Delivery Window',
    'hds_delivery_window',
    'Delivery-Time',
  ]);

  // The checkout extension writes the HDS cutoff-days value as "Charge Offset"
  // (e.g. "3 Days"). We push this to Loop as the subscription's chargeOffset.
  let chargeOffset = parseChargeOffset(order);

  // What the rest of the handler works from. A Loop renewal's attributes are a
  // verbatim copy of the subscription's — i.e. the FIRST cycle's dates — so these
  // may be replaced below.
  let effectiveDeliveryDate = deliveryDate;
  let effectiveWindow = deliveryTime;
  let effectiveSuburb = suburb;
  let effectivePostcode = postcode;
  let effectiveAttributes = getHdsAttributes(order);

  // Done BEFORE the INSERT deliberately: the stale attribute set is COMPLETE, so
  // enrichFromAttributes() would accept it as authoritative, skip the HDS API and
  // write the wrong pack/production dates into order_enrichments. The queue must
  // never see it.
  if (source === 'loop' && REWRITE_RENEWALS) {
    const state = needsRewrite(order);
    if (!state.stale) {
      console.log(`[webhook] order ${orderId}: ${state.reason} — no date rewrite needed`);
    } else {
      console.log(`[webhook] order ${orderId}: ${state.reason} — recomputing from the order date`);
      try {
        const out = await rewriteRenewalOrder(order);
        if (!out.ok) {
          console.warn(`[webhook] order ${orderId}: date rewrite skipped — ${out.reason}`);
        } else {
          const r = out.resolved;
          const window = out.attributes['HDS Delivery Window'] || null;
          effectiveDeliveryDate = r.delivery_date;
          effectiveWindow = window || effectiveWindow;
          effectiveSuburb = r.suburb || effectiveSuburb;
          effectivePostcode = r.postcode || effectivePostcode;
          effectiveAttributes = buildHdsAttributes(r, window);

          // Push the offset for the REWRITTEN date, not the checkout's leftover
          // value: it's region-specific (3 days in NSW, 4 in VIC).
          const derivedOffset = cutoffFor(r.option).charge_offset_days;
          if (derivedOffset != null) chargeOffset = derivedOffset;

          console.log(
            `[webhook] order ${orderId}: dates rewritten — delivery ${r.delivery_date}, ` +
              `pack ${r.pack_date}, production ${r.production_date}` +
              (out.tag ? `, tag ${out.tag}` : '')
          );
        }
      } catch (err) {
        console.error(`[webhook] order ${orderId}: date rewrite failed — ${err.message}`);
      }
    }
  }

  // No Delivery-Date means nothing to enrich — a Loop renewal whose subscription
  // attributes weren't written in time, or a non-delivery order. Record it as
  // 'skipped' rather than dropping it silently, so the gap is visible and the
  // row can be requeued once a date is known.
  const status = effectiveDeliveryDate ? 'pending' : 'skipped';
  const errorMessage = effectiveDeliveryDate
    ? null
    : source === 'loop'
      ? 'Loop renewal arrived without Delivery-Date (subscription attribute not set before charge)'
      : 'order has no Delivery-Date';

  // Queue the order BEFORE touching Loop. The subscription lookup below waits on
  // Loop's ingest lag (up to ~18s), and a restart inside that window must not
  // lose the order. subscription_id is nullable and backfilled once resolved.
  try {
    await pool.query(
      `INSERT INTO orders_to_enrich
         (order_id, delivery_date, delivery_location_id, delivery_time, suburb,
          status, error_message, source, source_attributes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (order_id) DO NOTHING`,
      [
        orderId,
        effectiveDeliveryDate,
        effectivePostcode,
        effectiveWindow,
        effectiveSuburb,
        status,
        errorMessage,
        source,
        effectiveAttributes,
      ]
    );

    if (status === 'pending') {
      console.log(`[webhook] queued order ${orderId} (${source}) for enrichment`);
    } else {
      console.log(`[webhook] order ${orderId} (${source}) has no Delivery-Date — recorded as skipped`);
    }
  } catch (err) {
    console.error(`[webhook] failed to queue order ${orderId}:`, err.message);
  }

  // Resolve the subscription via Loop's order lookup (returns the
  // "shopify-{contractId}" id the Loop API expects). Worth doing whenever the
  // order looks subscription-related OR carries a charge offset to push.
  // loopSubscriptionId → Loop API calls; subscriptionId → our BIGINT column.
  let loopSubscriptionId = null;
  if (effectiveDeliveryDate || source === 'loop' || chargeOffset != null) {
    try {
      loopSubscriptionId = await subscriptionIdForOrderRetrying(orderId, {
        onRetry: (attempt, wait, err) =>
          console.warn(
            `[webhook] order ${orderId}: Loop lookup attempt ${attempt} failed (${err.message}) — retrying in ${wait}ms`
          ),
      });
    } catch (err) {
      console.warn(`[webhook] Loop subscription lookup failed for order ${orderId}:`, err.message);
    }
  } else {
    console.log(
      `[webhook] order ${orderId}: no Delivery-Date, not a Loop order and no Charge Offset — skipping Loop lookup`
    );
  }

  const subscriptionId = loopSubscriptionId
    ? loopSubscriptionId.replace(/^shopify-/, '')
    : null;

  if (subscriptionId) {
    try {
      await pool.query(
        `UPDATE orders_to_enrich SET subscription_id = $2, updated_at = NOW()
          WHERE order_id = $1 AND subscription_id IS NULL`,
        [orderId, subscriptionId]
      );
    } catch (err) {
      console.warn(`[webhook] could not store subscription id for order ${orderId}:`, err.message);
    }
  }

  // Push the charge offset (HDS cutoff days) onto the Loop subscription so future
  // renewals are charged at the HDS cutoff. Every branch logs, so a silent
  // no-op is never mistaken for a successful write.
  if (loopSubscriptionId && chargeOffset != null) {
    try {
      const res = await editChargeOffsetRetrying(loopSubscriptionId, chargeOffset, {
        onRetry: (attempt, wait, err) =>
          console.warn(
            `[webhook] order ${orderId}: chargeOffset attempt ${attempt} failed (${err.message}) — retrying in ${wait}ms`
          ),
      });
      console.log(
        `[webhook] Loop chargeOffset=${chargeOffset} set on ${loopSubscriptionId} (order ${orderId}) — response:`,
        JSON.stringify(res)
      );
    } catch (err) {
      console.warn(
        `[webhook] failed to set Loop chargeOffset for ${loopSubscriptionId}:`,
        err.message
      );
    }
  } else if (chargeOffset == null) {
    console.log(
      `[webhook] order ${orderId} carries no "Charge Offset" note attribute — nothing to push to Loop`
    );
  } else {
    console.log(
      `[webhook] order ${orderId} has chargeOffset=${chargeOffset} but no subscription — skipping Loop update`
    );
  }

  // A Loop renewal that DID carry a date closes the loop on our pre-charge write.
  if (source === 'loop' && subscriptionId && effectiveDeliveryDate) {
    try {
      await pool.query(
        `UPDATE loop_subscription_deliveries
            SET shopify_order_id = $2, updated_at = NOW()
          WHERE subscription_id = $1 AND delivery_date = $3`,
        [subscriptionId, orderId, effectiveDeliveryDate]
      );
    } catch (err) {
      console.warn(`[webhook] could not link order ${orderId} to subscription:`, err.message);
    }
  }
});

// The checkout extension writes hds_* note attributes (visible as "Additional
// details" on the order). Older orders may carry the Delivery-* spelling, so
// accept either and take the first that's present.
function firstAttribute(order, names) {
  for (const name of names) {
    const value = getNoteAttribute(order, name);
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

// The extension writes "Charge Offset" as "3 Days"; older orders may use
// "HDS Cutoff Days" / "hds_cutoff_days". Extract the leading integer (→ 3).
function parseChargeOffset(order) {
  const raw = firstAttribute(order, [
    'Charge Offset',
    'HDS Cutoff Days',
    'hds_cutoff_days',
  ]);
  if (raw == null) return null;
  const match = String(raw).match(/\d+/);
  return match ? Number(match[0]) : null;
}

// Shopify stamps app_id with the app that created the order, so Loop renewals
// are identifiable even when they carry no delivery attributes. Set
// LOOP_SHOPIFY_APP_ID to Loop's app id (read it off a known renewal order).
function isLoopOrder(order) {
  const configured = process.env.LOOP_SHOPIFY_APP_ID;
  if (configured && String(order?.app_id) === String(configured)) return true;

  // Fallback while the app id is unconfirmed: Shopify tags subscription orders.
  const tags = String(order?.tags || '').toLowerCase();
  return tags.includes('subscription') || tags.includes('loop');
}

module.exports = router;
