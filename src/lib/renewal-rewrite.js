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
const {
  calculateNextDeliveryDate,
  formatLongDate,
  daysBetween,
  subtractDays,
} = require('./next-delivery');

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

// Delivery-Time is a clock range ("12:00 AM - 7:00 AM"), but HDS only knows window
// NAMES ("AM", "Business Hours") — the range lives in the checkout extension. So
// the mapping is configuration, not something to infer: supply it as JSON in
// DELIVERY_WINDOW_TIMES and the rewrite keeps Delivery-Time in step with the
// window. Left unset, the order keeps whatever it already carries, which stays
// correct because the window itself is preserved wherever the schedule offers it.
let windowTimesCache;
let windowTimesWarned = false;

function windowTimes() {
  const raw = process.env.DELIVERY_WINDOW_TIMES || '';
  if (windowTimesCache && windowTimesCache.raw === raw) return windowTimesCache.map;

  let map = {};
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') map = parsed;
    } catch (err) {
      if (!windowTimesWarned) {
        console.warn(`[rewrite] DELIVERY_WINDOW_TIMES is not valid JSON, ignoring it: ${err.message}`);
        windowTimesWarned = true;
      }
    }
  }
  windowTimesCache = { raw, map };
  return map;
}

function timeRangeForWindow(window) {
  if (!window) return null;
  const map = windowTimes();
  if (map[window]) return map[window];
  // Tolerate casing drift between the schedule and the configured keys.
  const hit = Object.keys(map).find((k) => k.toLowerCase() === String(window).toLowerCase());
  return hit ? map[hit] : null;
}

// The note attributes to write back, in the exact spellings already on the order.
//
// Deliberately NOT included: Delivery-Time, Delivery-Location-Id, Delivery-Slot-Id,
// Checkout-Method, Custom-Attribute-*, _amp_sc, sp_*. Those come from checkout or
// other apps — HDS has no authority over them, and the write merges rather than
// replaces so they survive untouched.
function buildOrderAttributes(resolved, { preferredWindow = null } = {}) {
  const cutoff = resolved.cutoff_override || cutoffFor(resolved.option);
  const window = chooseDeliveryWindow(resolved, preferredWindow);

  const out = {
    // What the downstream integration reads.
    'Delivery-Date': toSlashDate(resolved.delivery_date),
    'Pick-Pack-Date': toSlashDate(resolved.pack_date),
    // Only when DELIVERY_WINDOW_TIMES maps this window; otherwise left untouched.
    'Delivery-Time': timeRangeForWindow(window),
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

// DAY_INDEX read backwards — one day table, not two.
function weekdayOf(isoDate) {
  if (!isoDate) return null;
  const d = new Date(String(isoDate).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  const name = Object.keys(DAY_INDEX).find((k) => DAY_INDEX[k] === d.getUTCDay());
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}

// Which schedule must the renewal stay on?
//
// A Monday delivery stays a Monday delivery, so the previous cycle's schedule is
// the constraint. HDS Schedule ID pins both the weekday and the window (one
// weekday can have several schedules); the weekday alone is the fallback. When
// neither label is present the weekday is derived from the PREVIOUS delivery
// date, which every renewal carries by definition — that staleness is exactly
// why these orders need rewriting in the first place.
function scheduleFor(order) {
  const scheduleId =
    getNoteAttribute(order, 'HDS Schedule ID') || getNoteAttribute(order, 'hds_schedule_id');

  const labelledDay =
    getNoteAttribute(order, 'HDS Delivery Day') || getNoteAttribute(order, 'hds_delivery_day');

  const previousRaw =
    getNoteAttribute(order, 'Delivery-Date') ||
    getNoteAttribute(order, 'HDS Delivery Date') ||
    getNoteAttribute(order, 'hds_delivery_date');
  const previous = previousRaw ? normalizeDate(previousRaw) : null;

  const deliveryDay = labelledDay || weekdayOf(previous);

  return {
    scheduleId: scheduleId || null,
    deliveryDay: deliveryDay || null,
    derivedFrom: labelledDay
      ? 'HDS Delivery Day'
      : previous
        ? 'previous delivery ' + previous
        : 'nothing',
  };
}

// The previous cycle's tuple, and the gaps between its dates.
//
// The stale attributes are the one thing every renewal is guaranteed to carry, so
// they are a usable source for the SHAPE of the schedule even though the dates
// themselves are expired: delivery->pack was 1 day in NSW and 2 in VIC, so
// carrying that gap forward is region-correct by construction rather than by a
// hardcoded rule.
function previousTuple(order) {
  const read = (...names) => {
    for (const n of names) {
      const v = getNoteAttribute(order, n);
      if (v) return normalizeDate(v);
    }
    return null;
  };

  const delivery = read('Delivery-Date', 'HDS Delivery Date', 'hds_delivery_date');
  const pack = read('Pick-Pack-Date', 'HDS Pack Date', 'hds_pack_date');
  const production = read('HDS Production Date', 'hds_production_date');

  return {
    delivery,
    pack,
    production,
    packGap: daysBetween(delivery, pack),
    productionGap: daysBetween(delivery, production),
    chargeOffset: parseOffsetDays(getNoteAttribute(order, 'Charge Offset')),
  };
}

function parseOffsetDays(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/\d+/);
  return m ? Number(m[0]) : null;
}

// Weekday arithmetic instead of an HDS lookup: next occurrence of the customer's
// delivery weekday on or after the order date, with pack/production carried
// forward at the same gaps as their previous cycle and the cutoff derived from
// their Charge Offset.
//
// Opt-in (FALLBACK_WEEKDAY_MATH), and off by default for a real reason: HDS omits
// options whose production cutoff has already passed, and this does not. Asked
// for a Friday on 2026-08-19 it returns 2026-08-21, whose Tuesday cutoff was
// already gone — HDS correctly answers 2026-08-28. So this can promise the
// kitchen something it cannot make, and is only worth using when HDS has no
// schedule for that weekday at all.
function fallbackFromWeekdayMath(order, schedule) {
  if (String(process.env.FALLBACK_WEEKDAY_MATH || 'false').toLowerCase() !== 'true') {
    return { ok: false, reason: 'weekday-math fallback is disabled (FALLBACK_WEEKDAY_MATH)' };
  }
  if (!schedule.deliveryDay) {
    return { ok: false, reason: 'no delivery weekday to compute from' };
  }

  const previous = previousTuple(order);
  const orderDate = String(order.created_at || '').slice(0, 10);
  const next = calculateNextDeliveryDate(schedule.deliveryDay, previous.chargeOffset, {
    from: orderDate,
  });
  if (!next.ok) return next;

  const packGap = previous.packGap == null ? null : previous.packGap;
  const productionGap = previous.productionGap == null ? null : previous.productionGap;

  return {
    ok: true,
    data: {
      charge_date: next.charge_date,
      matched_by: `${schedule.deliveryDay} by weekday arithmetic (HDS had no option)`,
      delivery_date: next.delivery_date,
      pack_date: packGap == null ? null : subtractDays(next.delivery_date, packGap),
      production_date: productionGap == null ? null : subtractDays(next.delivery_date, productionGap),
      region: getNoteAttribute(order, 'HDS Region'),
      suburb: getNoteAttribute(order, 'HDS Suburb') || order?.shipping_address?.city || null,
      postcode: getNoteAttribute(order, 'HDS Postcode') || order?.shipping_address?.zip || null,
      schedule_id: schedule.scheduleId,
      delivery_day: next.delivery_day,
      delivery_window: getNoteAttribute(order, 'HDS Delivery Window'),
      formatted_date: formatLongDate(next.delivery_date),
      // No HDS option, so cutoff_info is unavailable; cutoffFor() falls back to
      // the offset-derived charge date below.
      option: {},
      cutoff_override: {
        cutoff_date: next.charge_date,
        cutoff_day: next.charge_day,
        charge_offset_days: previous.chargeOffset,
      },
    },
  };
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

  const schedule = scheduleFor(order);
  let result = await resolveRenewalDelivery({
    postcode,
    suburb,
    chargeDateIso: order.created_at,
    scheduleId: schedule.scheduleId,
    deliveryDay: schedule.deliveryDay,
  });

  // HDS is authoritative. Weekday arithmetic only stands in when HDS has no
  // option for this weekday at all, and only when explicitly enabled, because it
  // cannot see production cutoffs.
  let usedFallback = false;
  if (!result.ok) {
    const fallback = fallbackFromWeekdayMath(order, schedule);
    if (!fallback.ok) {
      return { ok: false, reason: `${result.reason}; fallback: ${fallback.reason}`, schedule };
    }
    result = fallback;
    usedFallback = true;
  }

  const resolved = result.data;
  const attributes = buildOrderAttributes(resolved, {
    preferredWindow: getNoteAttribute(order, 'HDS Delivery Window'),
  });
  const tag = packDateTag(resolved.pack_date);

  if (dryRun) return { ok: true, dryRun: true, resolved, attributes, tag, orderDate, schedule, usedFallback };

  await updateOrderAttributes(orderId, {
    attributes,
    addTags: tag ? [tag] : [],
    removeTagPrefixes: [PACK_TAG_PREFIX],
    order,
  });

  return { ok: true, resolved, attributes, tag, orderDate, schedule, usedFallback };
}

module.exports = {
  needsRewrite,
  previousTuple,
  fallbackFromWeekdayMath,
  scheduleFor,
  weekdayOf,
  timeRangeForWindow,
  rewriteRenewalOrder,
  buildOrderAttributes,
  packDateTag,
  cutoffFor,
  toSlashDate,
  locationFor,
  PACK_TAG_PREFIX,
};
