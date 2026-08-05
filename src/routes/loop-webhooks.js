const express = require('express');
const { pool } = require('../db');
const { verifyLoopWebhook, patchCustomAttributes } = require('../loop');
const { resolveRenewalDelivery, buildHdsAttributes } = require('../lib/renewal-date');

const router = express.Router();

// The attribute keys the checkout extension writes onto an order (visible under
// "Additional details" in the Shopify admin). Loop stamps subscription custom
// attributes onto the order it creates, so writing the SAME keys makes a renewal
// order indistinguishable from a checkout order — and the existing orders/create
// handler needs no Loop-specific branch.
const KEY_WINDOW = 'hds_delivery_window';
const KEY_POSTCODE = 'hds_postcode';

// Loop's order/upcoming webhook: fires ahead of a subscription charge, before
// the Shopify order exists. That window is the only chance to put a delivery
// date on the renewal.
router.post('/loop/order-upcoming', async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
  const header =
    req.get(process.env.LOOP_WEBHOOK_HEADER || 'X-Loop-Hmac-Sha256') ||
    req.get('X-Loop-Signature');

  if (!verifyLoopWebhook(rawBody, header)) {
    console.warn('[loop] webhook signature verification failed');
    return res.status(401).send('invalid signature');
  }

  // Acknowledge immediately; Loop shouldn't wait on the HDS lookup.
  res.status(200).send('ok');

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    console.warn('[loop] could not parse order/upcoming body');
    return;
  }

  try {
    await handleUpcoming(payload);
  } catch (err) {
    console.error('[loop] order/upcoming handling failed:', err.message);
  }
});

async function handleUpcoming(payload) {
  const parsed = parseUpcoming(payload);

  if (!parsed.subscriptionId) {
    // Payload shape isn't confirmed with Loop yet — log the body so the field
    // mapping in parseUpcoming() can be corrected against a real delivery.
    console.warn(
      '[loop] order/upcoming had no recognisable subscription id; payload:',
      JSON.stringify(payload).slice(0, 2000)
    );
    return;
  }

  const resolved = await resolveRenewalDelivery({
    postcode: parsed.postcode,
    suburb: parsed.suburb,
    chargeDateEpoch: parsed.chargeDateEpoch,
    chargeDateIso: parsed.chargeDateIso,
  });

  if (!resolved.ok) {
    await recordAttempt(parsed, payload, {
      status: 'failed',
      error: resolved.reason,
    });
    console.warn(
      `[loop] subscription ${parsed.subscriptionId}: could not resolve delivery date — ${resolved.reason}`
    );
    return;
  }

  const d = resolved.data;

  // The full hds_* set, exactly as the checkout extension writes it. PATCH
  // merges, so anything else Loop or another app stores on the subscription is
  // left untouched.
  const attributes = buildHdsAttributes(d, parsed.deliveryWindow);

  try {
    await patchCustomAttributes(parsed.subscriptionId, attributes);
  } catch (err) {
    await recordAttempt(parsed, payload, { status: 'failed', error: err.message, resolved: d });
    console.error(`[loop] subscription ${parsed.subscriptionId}: attribute write failed — ${err.message}`);
    return;
  }

  await recordAttempt(parsed, payload, { status: 'written', resolved: d });
  console.log(
    `[loop] subscription ${parsed.subscriptionId}: Delivery-Date ${d.delivery_date} written (charge ${d.charge_date})`
  );
}

// Audit row: what we chose, what we wrote, and whether it worked. Unique on
// (subscription_id, charge_date) so a redelivered webhook updates rather than
// duplicating.
async function recordAttempt(parsed, payload, { status, error = null, resolved = null }) {
  await pool.query(
    `INSERT INTO loop_subscription_deliveries
       (subscription_id, loop_order_id, charge_date, delivery_date, delivery_time,
        delivery_location_id, suburb, status, attempts, error_message, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10)
     ON CONFLICT (subscription_id, charge_date) DO UPDATE SET
       loop_order_id        = COALESCE(EXCLUDED.loop_order_id, loop_subscription_deliveries.loop_order_id),
       delivery_date        = EXCLUDED.delivery_date,
       delivery_time        = EXCLUDED.delivery_time,
       delivery_location_id = EXCLUDED.delivery_location_id,
       suburb               = EXCLUDED.suburb,
       status               = EXCLUDED.status,
       attempts             = loop_subscription_deliveries.attempts + 1,
       error_message        = EXCLUDED.error_message,
       payload              = EXCLUDED.payload,
       updated_at           = NOW()`,
    [
      parsed.subscriptionId,
      parsed.loopOrderId,
      resolved?.charge_date || parsed.chargeDateIso?.slice(0, 10) || null,
      resolved?.delivery_date || null,
      parsed.deliveryWindow,
      resolved?.postcode || parsed.postcode,
      resolved?.suburb || parsed.suburb,
      status,
      error,
      payload,
    ]
  );
}

// Field mapping for the order/upcoming payload.
//
// Loop have confirmed the webhook exists but not documented its body, so each
// field is read from the plausible spellings. Once a real payload is captured,
// narrow these to the actual keys.
function parseUpcoming(payload) {
  const p = payload || {};
  const sub = p.subscription || p.contract || p;
  const address = p.shippingAddress || p.shipping_address || sub.shippingAddress || sub.shipping_address || {};

  const customAttributes = normaliseAttributes(
    p.customAttributes || p.custom_attributes || sub.customAttributes || sub.custom_attributes
  );

  return {
    subscriptionId: firstNumber([
      p.subscriptionId,
      p.subscription_id,
      sub.subscriptionId,
      sub.subscription_id,
      sub.id,
    ]),
    loopOrderId: firstNumber([p.orderId, p.order_id, p.id]),
    chargeDateEpoch: first([
      p.nextBillingDateEpoch,
      p.next_billing_date_epoch,
      sub.nextBillingDateEpoch,
      sub.next_billing_date_epoch,
      p.billingDateEpoch,
    ]),
    chargeDateIso: first([
      p.nextBillingDate,
      p.next_billing_date,
      sub.nextBillingDate,
      sub.next_billing_date,
      p.billingDate,
    ]),
    postcode: first([
      customAttributes[KEY_POSTCODE],
      customAttributes['Delivery-Location-Id'],
      address.zip,
      address.postcode,
      address.postalCode,
      address.postal_code,
    ]),
    suburb: first([address.city, address.suburb, customAttributes.hds_suburb]),
    // Reuse the customer's existing window if the subscription already carries one.
    deliveryWindow: first([customAttributes[KEY_WINDOW], customAttributes['Delivery-Time']]),
  };
}

function normaliseAttributes(value) {
  const out = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      const key = item?.key ?? item?.name;
      if (key) out[key] = item.value;
    }
  } else if (value && typeof value === 'object') {
    Object.assign(out, value);
  }
  return out;
}

function first(values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function firstNumber(values) {
  const v = first(values);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = router;
module.exports.parseUpcoming = parseUpcoming;
module.exports.handleUpcoming = handleUpcoming;
