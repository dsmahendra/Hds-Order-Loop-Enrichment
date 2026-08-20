// Rewriting a Loop renewal order's delivery dates — the job Arigato Automation
// was doing.
//
// Loop stamps the SUBSCRIPTION's custom attributes onto every order it creates,
// verbatim. Those attributes hold the delivery date chosen at checkout, so every
// renewal arrives carrying the FIRST cycle's dates. Observed on a real renewal:
// order dated 19 Aug 2026 carrying Delivery-Date 2026/08/10, pack 2026/08/09,
// production 2026/08/08 — all before the order existed.
//
// Worse than a wrong label: the stale set is COMPLETE, so enrichFromAttributes()
// accepts it as authoritative and never re-checks the API, and the bad dates land
// in order_enrichments and drive the kitchen schedule.
//
// So for a renewal we recompute from the order's own date and write the result
// back onto the order, replacing Arigato in the pipeline.

const { getNoteAttribute, normalizeDate, updateOrderAttributes } = require('../shopify');
const { chooseDeliveryWindow, resolveRenewalDelivery } = require('./renewal-date');

const DAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

// ISO (2026-08-24) -> the yyyy/mm/dd spelling the checkout extension writes and
// the downstream integration reads.
function toSlashDate(value) {
  if (!value) return null;
  return String(value).slice(0, 10).replace(/-/g, '/');
}

// HDS states the cutoff as a weekday ("Friday 11 PM"), not a date. The cutoff is
// the last occurrence of that weekday strictly before the delivery date, and the
// gap between them IS the charge offset: 3 days in NSW (Mon delivery / Fri
// cutoff), 4 in VIC (Fri delivery / Mon cutoff). Deriving it keeps Charge Offset
// consistent with the rewritten delivery date instead of leaving the checkout's
// value behind.
function cutoffFor(option) {
  const delivery = option?.delivery_date;
  const name = String(option?.cutoff_info || '').trim().split(/\s+/)[0] || '';
  const target = DAY_INDEX[name.toLowerCase()];

  if (!delivery || target === undefined) {
    return { cutoff_date: null, cutoff_day: null, charge_offset_days: null };
  }

  const d = new Date(`${String(delivery).slice(0, 10)}T00:00:00Z`);
  let back = (d.getUTCDay() - target + 7) % 7;
  if (back === 0) back = 7; // cutoff is never the delivery day itself
  d.setUTCDate(d.getUTCDate() - back);

  return {
    cutoff_date: d.toISOString().slice(0, 10),
    cutoff_day: name.charAt(0).toUpperCase() + name.slice(1).toLowerCase(),
    charge_offset_days: back,
  };
}

// Should this order's dates be recomputed?
//
// A renewal whose Delivery-Date predates the order itself is stale by definition
// — no customer picks a delivery before they order. Missing entirely counts too.
function needsRewrite(order) {
  const raw =
    getNoteAttribute(order, 'Delivery-Date') ||
    getNoteAttribute(order, 'HDS Delivery Date') ||
    getNoteAttribute(order, 'hds_delivery_date');

  const orderDate = String(order?.created_at || '').slice(0, 10);
  if (!raw) return { stale: true, reason: 'order carries no Delivery-Date' };
  if (!orderDate) return { stale: false, reason: 'order has no created_at to compare against' };

  const delivery = normalizeDate(raw);
  if (delivery < orderDate) {
    return {
      stale: true,
      reason: `Delivery-Date ${delivery} is before the order date ${orderDate}`,
      current: delivery,
    };
  }
  return { stale: false, reason: `Delivery-Date ${delivery} is on/after the order date ${orderDate}`, current: delivery };
}

// The note attributes to write back, in the exact spellings already on the order.
//
// Deliberately NOT included: Delivery-Time, Delivery-Location-Id, Delivery-Slot-Id,
// Checkout-Method, Custom-Attribute-*, _amp_sc, sp_*. Those come from checkout or
// other apps — HDS has no authority over them, and the write merges rather than
// replaces so they survive untouched.
function buildOrderAttributes(resolved, { preferredWindow = null } = {}) {
  const cutoff = cutoffFor(resolved.option);
  const window = chooseDeliveryWindow(resolved, preferredWindow);

  const out = {
    // What the downstream integration reads.
    'Delivery-Date': toSlashDate(resolved.delivery_date),
    'Pick-Pack-Date': toSlashDate(resolved.pack_date),
    // The labelled HDS set, as the checkout extension writes it.
    'HDS Delivery Date': toSlashDate(resolved.delivery_date),
    'HDS Delivery Formatted': resolved.formatted_date,
    'HDS Delivery Day': resolved.delivery_day,
    'HDS Delivery Window': window,
    'HDS Schedule ID': resolved.schedule_id,
    'HDS Cutoff Day': cutoff.cutoff_day,
    'HDS Cutoff Date': toSlashDate(cutoff.cutoff_date),
    'Charge Offset': cutoff.charge_offset_days == null ? null : `${cutoff.charge_offset_days} Days`,
    'HDS Pack Date': toSlashDate(resolved.pack_date),
    'HDS Production Date': toSlashDate(resolved.production_date),
    'HDS Region': resolved.region,
    'HDS Suburb': resolved.suburb,
    'HDS Postcode': resolved.postcode,
  };

  for (const [k, v] of Object.entries(out)) {
    if (v === null || v === undefined || v === '') delete out[k];
  }
  return out;
}

// Arigato also tagged the order with the pick-pack date; fulfilment filters on it.
// ISO 2026-08-22 -> "Pick-Pack-Date-22-08-2026".
function packDateTag(packDate) {
  if (!packDate) return null;
  const [y, m, d] = String(packDate).slice(0, 10).split('-');
  if (!y || !m || !d) return null;
  return `Pick-Pack-Date-${d}-${m}-${y}`;
}

const PACK_TAG_PREFIX = 'Pick-Pack-Date-';

// Where to read the suburb/postcode for the HDS lookup.
//
// NOT from Delivery-Location-Id: on a real renewal that field held
// "NSW Sydney Metro" (a region name) rather than a postcode, so trusting it would
// send garbage to the API. The labelled HDS keys, then the shipping address.
function locationFor(order) {
  const postcode =
    getNoteAttribute(order, 'HDS Postcode') ||
    getNoteAttribute(order, 'hds_postcode') ||
    order?.shipping_address?.zip ||
    null;

  const suburb =
    getNoteAttribute(order, 'HDS Suburb') ||
    getNoteAttribute(order, 'hds_suburb') ||
    order?.shipping_address?.city ||
    null;

  return { postcode, suburb };
}

// Recompute a renewal's dates from the ORDER's own date and write them back.
//
// This is the whole Arigato replacement: resolve against HDS using the order date
// as the reference (not the stale checkout value), then merge the result onto the
// order's note attributes and refresh the pick-pack tag.
async function rewriteRenewalOrder(order, { dryRun = false } = {}) {
  const orderId = order?.id;
  if (!orderId) return { ok: false, reason: 'order payload has no id' };

  const { postcode, suburb } = locationFor(order);
  if (!postcode) return { ok: false, reason: 'no postcode on the order (HDS Postcode / shipping address)' };
  // The HDS API requires both; a postcode alone returns 400.
  if (!suburb) return { ok: false, reason: 'no suburb on the order (HDS Suburb / shipping city)' };

  const orderDate = String(order.created_at || '').slice(0, 10);
  if (!orderDate) return { ok: false, reason: 'order has no created_at to resolve against' };

  const result = await resolveRenewalDelivery({
    postcode,
    suburb,
    chargeDateIso: order.created_at,
  });
  if (!result.ok) return { ok: false, reason: result.reason };

  const resolved = result.data;
  const attributes = buildOrderAttributes(resolved, {
    preferredWindow: getNoteAttribute(order, 'HDS Delivery Window'),
  });
  const tag = packDateTag(resolved.pack_date);

  if (dryRun) return { ok: true, dryRun: true, resolved, attributes, tag, orderDate };

  await updateOrderAttributes(orderId, {
    attributes,
    addTags: tag ? [tag] : [],
    removeTagPrefixes: [PACK_TAG_PREFIX],
    order,
  });

  return { ok: true, resolved, attributes, tag, orderDate };
}

module.exports = {
  needsRewrite,
  rewriteRenewalOrder,
  buildOrderAttributes,
  packDateTag,
  cutoffFor,
  toSlashDate,
  locationFor,
  PACK_TAG_PREFIX,
};
