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
const { chooseDeliveryWindow, resolveRenewalDelivery, fetchDeliveryOptions } = require('./renewal-date');
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

// A window's configured value may take either form:
//
//   "12:00 AM - 7:00 AM"                              the clock range alone
//   {"label":"Morning","time":"12:00 AM - 7:00 AM"}    the range and the name the
//                                                     customer actually chose
//
// The label is recorded so it is AVAILABLE, not so it is written: by default
// Delivery-Time still holds the range alone. What the object form actually buys
// is that the range follows the window the customer chose — Morning yields
// "12:00 AM - 7:00 AM" and Daytime "8:00 AM - 6:00 PM" — with the name kept
// beside it for anything that wants to name the window without re-deriving it
// from a pair of times.
function windowEntryFor(window) {
  if (!window) return null;
  const map = windowTimes();

  let value = map[window];
  if (value === undefined) {
    // Tolerate casing drift between the schedule and the configured keys.
    const hit = Object.keys(map).find((k) => k.toLowerCase() === String(window).toLowerCase());
    if (hit === undefined) return null;
    value = map[hit];
  }

  if (typeof value === 'string') return { label: null, time: value };

  if (value && typeof value === 'object') {
    // 'time'/'range' and 'label'/'name' both accepted: this is hand-written JSON
    // in an environment variable, and rejecting a reasonable spelling would fail
    // silently as an unmapped window.
    const time = value.time || value.range || null;
    const label = value.label || value.name || null;
    if (!time && !label) return null;
    return { label, time };
  }

  return null;
}

// How the label and the range are combined.
//
// The default is the range ALONE — "8:00 AM - 6:00 PM" — because that is what
// Delivery-Time has always held and what reads it downstream. A window's label
// is available to whoever wants it via the template, but it is opt-in: putting a
// word in front of the range by default would change a value other systems parse
// on the strength of nothing more than it reading nicely.
function deliveryTimeFormat() {
  const raw = process.env.DELIVERY_TIME_FORMAT;
  return raw && raw.trim() ? raw : '{time}';
}

function timeRangeForWindow(window) {
  const entry = windowEntryFor(window);
  if (!entry) return null;

  // Either half on its own is still worth writing; there is just nothing to join.
  if (!entry.label) return entry.time;
  if (!entry.time) return entry.label;

  return deliveryTimeFormat()
    .split('{label}')
    .join(entry.label)
    .split('{time}')
    .join(entry.time)
    .trim();
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
    'HDS Ship Date': toSlashDate(resolved.pack_date),
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

// The delivery date as a bare DD-MM-YYYY tag — the convention already on the live
// orders ("06-09-2026" for a 2026/09/06 delivery), which fulfilment filters on.
function deliveryDateTag(deliveryDate) {
  if (!deliveryDate) return null;
  const [y, m, d] = String(deliveryDate).slice(0, 10).split('-');
  if (!y || !m || !d) return null;
  return `${d}-${m}-${y}`;
}

// A bare date tag has no prefix to match on, so a superseded one is removed by
// computing its exact text from the date the order previously carried.
const DATE_TAG_SHAPE = /^d{2}-d{2}-d{4}$/;

// Tagged onto an order whose dates could NOT be recomputed, so the expired ones it
// still carries are visibly untrustworthy. Cleared the moment a rewrite succeeds.
const HELD_TAG = 'HDS-Dates-Held';

// Whether a rewrite may clear the date tags it supersedes.
//
// Off by default: tags on an order may be there for reasons we know nothing about,
// and removing someone else's tag is not ours to do. So the write only ever ADDS.
//
// The cost of that, stated plainly: an order whose dates are rewritten keeps its
// previous date tags alongside the new ones, so a fulfilment filter on
// "Pick-Pack-Date-*" would match both. Set TAG_REMOVE_SUPERSEDED=true if that
// matters more than leaving tags untouched.
//
// HDS-Dates-Held is exempt: it is a marker this service adds itself, and leaving it
// on an order whose dates are now correct would mislabel it permanently.
function mayRemoveSupersededTags() {
  return String(process.env.TAG_REMOVE_SUPERSEDED || 'false').toLowerCase() === 'true';
}

// Renamed keys. The rewrite removes these so a stale value cannot sit alongside
// its replacement, leaving downstream unable to tell which one is authoritative.
const SUPERSEDED_ATTRIBUTES = ['HDS Pack Date'];

// Where to read the suburb/postcode for the HDS lookup.
//
// NOT from Delivery-Location-Id: on a real renewal that field held
// "NSW Sydney Metro" (a region name) rather than a postcode, so trusting it would
// send garbage to the API. The labelled HDS keys, then the shipping address.
// Delivery-Location-Id is only trustworthy when it actually looks like a
// postcode. Real renewals carry both spellings: "2170" on one, "NSW Sydney Metro"
// on another. Checking the shape lets the useful case through and keeps the region
// name out of the API query.
function isPostcodeShaped(value) {
  return /^\d{4}$/.test(String(value == null ? '' : value).trim());
}

// Where to look up the schedule, in priority order.
//
// The SHIPPING ADDRESS comes first. It is where the parcel actually goes, and on a
// renewal it is current — whereas HDS Postcode / HDS Suburb are copies of the first
// cycle, so a customer who has moved would otherwise be scheduled against the
// suburb they left.
//
// The labelled attributes stay as a fallback because they hold HDS's own canonical
// suburb spelling, which resolves when a free-text shipping city does not.
function locationCandidatesFor(order) {
  const locationId = getNoteAttribute(order, 'Delivery-Location-Id');

  const shipped = {
    postcode: order?.shipping_address?.zip ? String(order.shipping_address.zip).trim() : null,
    suburb: order?.shipping_address?.city ? String(order.shipping_address.city).trim() : null,
    source: 'shipping address',
  };

  const labelled = {
    postcode:
      getNoteAttribute(order, 'HDS Postcode') ||
      getNoteAttribute(order, 'hds_postcode') ||
      (isPostcodeShaped(locationId) ? String(locationId).trim() : null),
    suburb: getNoteAttribute(order, 'HDS Suburb') || getNoteAttribute(order, 'hds_suburb'),
    source: 'HDS attributes on the order',
  };

  const candidates = [shipped, labelled].filter((c) => c.postcode && c.suburb);

  // Drop a duplicate second attempt when both agree.
  if (
    candidates.length === 2 &&
    String(candidates[0].postcode) === String(candidates[1].postcode) &&
    String(candidates[0].suburb).toLowerCase() === String(candidates[1].suburb).toLowerCase()
  ) {
    return [candidates[0]];
  }
  return candidates;
}

// The single best guess, for diagnostics and for reporting what is missing.
function locationFor(order) {
  const candidates = locationCandidatesFor(order);
  if (candidates.length) return { postcode: candidates[0].postcode, suburb: candidates[0].suburb };

  const locationId = getNoteAttribute(order, 'Delivery-Location-Id');
  return {
    postcode:
      order?.shipping_address?.zip ||
      getNoteAttribute(order, 'HDS Postcode') ||
      getNoteAttribute(order, 'hds_postcode') ||
      (isPostcodeShaped(locationId) ? String(locationId).trim() : null) ||
      null,
    suburb:
      order?.shipping_address?.city ||
      getNoteAttribute(order, 'HDS Suburb') ||
      getNoteAttribute(order, 'hds_suburb') ||
      null,
  };
}

// DAY_INDEX read backwards — one day table, not two.
function weekdayOf(isoDate) {
  if (!isoDate) return null;
  const d = new Date(String(isoDate).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  const name = Object.keys(DAY_INDEX).find((k) => DAY_INDEX[k] === d.getUTCDay());
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}

// How to choose a renewal's delivery date when the customer's own weekday is not
// the soonest option available.
//
//   cutoff-day (default)   the day the order was created IS the cutoff day, so use
//                          the region's schedule for that cutoff — which carries its
//                          own ship and delivery days. Loop charges at the cutoff, so
//                          the charge day identifies the schedule. Needs nothing from
//                          the subscription's stored attributes, which is the point:
//                          a stale Delivery-Date can no longer decide the weekday.
//   keep-weekday           hold the weekday of the subscription's Delivery-Date, even
//                          if that means waiting a week for its cutoff
//   earliest               take the soonest date HDS offers, whatever weekday
//
// Real example, order placed 2026-08-21 in postcode 2170: a Sunday subscriber gets
// Sun 30 Aug under keep-weekday (Sun 23 Aug's cutoff had gone) but Mon 24 Aug under
// earliest. Six days apart, so this is a real business choice rather than a detail.
function selectionMode() {
  const raw = String(process.env.RENEWAL_DELIVERY_SELECTION || 'cutoff-day').toLowerCase();
  if (raw === 'earliest') return 'earliest';
  if (raw === 'keep-weekday') return 'keep-weekday';
  return 'cutoff-day';
}

// Which schedule must the renewal stay on?
//
// A Monday delivery stays a Monday delivery, so the previous cycle's schedule is
// the constraint. HDS Schedule ID pins both the weekday and the window (one
// weekday can have several schedules); the weekday alone is the fallback. When
// neither label is present the weekday is derived from the PREVIOUS delivery
// date, which every renewal carries by definition — that staleness is exactly
// why these orders need rewriting in the first place.
function scheduleFor(order, subscriptionAttributes = null) {
  const scheduleId =
    getNoteAttribute(order, 'HDS Schedule ID') || getNoteAttribute(order, 'hds_schedule_id');

  // The SUBSCRIPTION's own Delivery-Date first. We rewrite the order's attributes,
  // so the order has stopped being an independent witness to what the customer
  // chose; the subscription still is. Loop has no deliveryDay field — this
  // attribute is its only record of a weekday.
  const subDateRaw = subscriptionAttributes ? subscriptionAttributes['Delivery-Date'] : null;
  const subDate = subDateRaw ? normalizeDate(subDateRaw) : null;

  const labelledDay =
    getNoteAttribute(order, 'HDS Delivery Day') || getNoteAttribute(order, 'hds_delivery_day');

  const previousRaw =
    getNoteAttribute(order, 'Delivery-Date') ||
    getNoteAttribute(order, 'HDS Delivery Date') ||
    getNoteAttribute(order, 'hds_delivery_date');
  const previous = previousRaw ? normalizeDate(previousRaw) : null;

  const deliveryDay = weekdayOf(subDate) || labelledDay || weekdayOf(previous);

  return {
    scheduleId: scheduleId || null,
    deliveryDay: deliveryDay || null,
    derivedFrom: subDate
      ? 'Loop subscription Delivery-Date ' + subDate
      : labelledDay
        ? 'order HDS Delivery Day'
        : previous
          ? 'order Delivery-Date ' + previous
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
  const pack = read('Pick-Pack-Date', 'HDS Ship Date', 'HDS Pack Date', 'hds_pack_date');
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
async function rewriteRenewalOrder(order, { dryRun = false, subscriptionAttributes = null } = {}) {
  const orderId = order?.id;
  if (!orderId) return { ok: false, reason: 'order payload has no id' };

  const candidates = locationCandidatesFor(order);
  if (!candidates.length) {
    const partial = locationFor(order);
    return {
      ok: false,
      reason: !partial.postcode
        ? 'no postcode on the order (shipping address / HDS Postcode)'
        : 'no suburb on the order (shipping city / HDS Suburb)',
    };
  }

  const orderDate = String(order.created_at || '').slice(0, 10);
  if (!orderDate) return { ok: false, reason: 'order has no created_at to resolve against' };

  const schedule = scheduleFor(order, subscriptionAttributes);
  const mode = selectionMode();

  // In 'earliest' mode the weekday constraint is simply not applied, so the
  // resolver returns the soonest option it has.
  // In cutoff-day mode the order's own creation weekday selects the schedule, so
  // no weekday is taken from the subscription at all.
  const orderWeekday = weekdayOf(orderDate);

  // Try the shipping address first, then the labelled attributes. A free-text
  // shipping city HDS does not recognise should not cost us the lookup when the
  // order also carries HDS's own canonical spelling.
  let result = null;
  let locationUsed = null;
  const locationAttempts = [];

  for (const candidate of candidates) {
    result = await resolveRenewalDelivery({
      postcode: candidate.postcode,
      suburb: candidate.suburb,
      chargeDateIso: order.created_at,
      // Never scheduleId: it pins a weekday AND a window, so a stale id silently
      // overrides whatever was resolved here.
      scheduleId: null,
      cutoffDay: mode === 'cutoff-day' ? orderWeekday : null,
      deliveryDay: mode === 'keep-weekday' ? schedule.deliveryDay : null,
    });

    if (result.ok) {
      locationUsed = candidate;
      break;
    }
    locationAttempts.push(`${candidate.suburb} ${candidate.postcode} (${candidate.source}): ${result.reason}`);
  }

  if (!result.ok && locationAttempts.length > 1) {
    // Report every address tried, so "not serviceable" names which ones failed.
    result = { ok: false, reason: locationAttempts.join('; ') };
  }

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

  // For a renewal the cutoff IS the order date: Loop charges at the cutoff, so the
  // moment the order exists is the moment the cycle closed. Deriving it from the
  // delivery date instead would only restate the schedule, and would disagree with
  // reality whenever a subscription's charge offset is not yet correct.
  //
  // Charge Offset stays the SCHEDULE's value (3 days NSW, 4 VIC) rather than
  // delivery-minus-order-date: that is what we push to Loop to fix future charges,
  // so deriving it from a charge that fired on the wrong day would preserve the
  // error instead of correcting it.
  if (!usedFallback) {
    const scheduleCutoff = cutoffFor(resolved.option);
    resolved.cutoff_override = {
      // The order date IS the cutoff for a renewal — Loop charges at the cutoff.
      cutoff_date: orderDate,
      // The schedule's own cutoff weekday, which in cutoff-day mode is the order's
      // weekday by construction; naming the schedule's keeps them honest if not.
      cutoff_day: resolved.cutoff_day || weekdayOf(orderDate),
      charge_offset_days: scheduleCutoff.charge_offset_days,
    };
  }

  const attributes = buildOrderAttributes(resolved, {
    preferredWindow: getNoteAttribute(order, 'HDS Delivery Window'),
  });
  const tag = packDateTag(resolved.pack_date);
  const dateTag = deliveryDateTag(resolved.delivery_date);
  const tags = [tag, dateTag].filter(Boolean);

  // The date the order arrived with, so its tag is cleared rather than left
  // sitting beside the new one.
  const previousRaw =
    getNoteAttribute(order, 'Delivery-Date') || getNoteAttribute(order, 'HDS Delivery Date');
  const previousDateTag = previousRaw ? deliveryDateTag(normalizeDate(previousRaw)) : null;
  const staleDateTags =
    previousDateTag && previousDateTag !== dateTag && DATE_TAG_SHAPE.test(previousDateTag)
      ? [previousDateTag]
      : [];

  if (dryRun) {
    return { ok: true, dryRun: true, resolved, attributes, tag, tags, orderDate, schedule, usedFallback, locationUsed };
  }

  await updateOrderAttributes(orderId, {
    attributes,
    addTags: tags,
    // Clear the held flag and any superseded date tag: these dates are now good.
    // Only ever our own held marker, unless removal is explicitly enabled.
    removeTagPrefixes: mayRemoveSupersededTags()
      ? [PACK_TAG_PREFIX, HELD_TAG, ...staleDateTags]
      : [HELD_TAG],
    removeAttributes: SUPERSEDED_ATTRIBUTES,
    order,
  });

  return { ok: true, resolved, attributes, tag, tags, orderDate, schedule, usedFallback, locationUsed };
}

module.exports = {
  needsRewrite,
  mayRemoveSupersededTags,
  deliveryDateTag,
  locationCandidatesFor,
  HELD_TAG,
  selectionMode,
  SUPERSEDED_ATTRIBUTES,
  isPostcodeShaped,
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

// ---------------------------------------------------------------------------
// Filling in the HDS records for an order scheduled by something else.
//
// Production orders come from Zapiet, not the HDS checkout: they carry
// Delivery-Date, Delivery-Slot-Id and Delivery-Location-Id, and no HDS * fields
// at all. Their delivery date is valid and in the future, so needsRewrite()
// correctly leaves it alone — which meant nothing ever gave the kitchen a pack or
// production date for them.
//
// So keep the delivery date exactly as it is and derive the rest around it: find
// the schedule for that suburb whose delivery weekday matches, and apply its own
// pack and production gaps. Nothing the other app owns is touched.
// How much to add to an order that another system scheduled.
//
//   pack-date (default)  add Pick-Pack-Date and nothing else
//   all-missing          add every HDS field the order is missing
//
// Either way the write is ADDITIVE: a value the order already carries is never
// replaced, so nothing here can change a date a customer was already told.
function fillScope() {
  return String(process.env.FILL_HDS_ATTRIBUTES || 'all-missing').toLowerCase() === 'pack-date'
    ? 'pack-date'
    : 'all-missing';
}

// Every field the HDS set contributes to an order. Delivery-Date and Delivery-Time
// are absent on purpose: those belong to whatever scheduled the order.
const HDS_FIELDS = [
  'Pick-Pack-Date',
  'HDS Delivery Date',
  'HDS Delivery Formatted',
  'HDS Delivery Day',
  'HDS Delivery Window',
  'HDS Schedule ID',
  'HDS Cutoff Day',
  'HDS Cutoff Date',
  'Charge Offset',
  'HDS Ship Date',
  'HDS Production Date',
  'HDS Region',
  'HDS Suburb',
  'HDS Postcode',
];

function missingHdsFields(order) {
  return HDS_FIELDS.filter((f) => {
    const v = getNoteAttribute(order, f);
    return v === null || v === undefined || v === '';
  });
}

// What the current scope would actually add. Used to decide whether an HDS lookup
// is worth making at all: an order missing nothing needs no call, and in pack-date
// scope an order missing only HDS Region needs no call either.
function pendingHdsFields(order) {
  const missing = missingHdsFields(order);
  return fillScope() === 'pack-date' ? missing.filter((f) => f === 'Pick-Pack-Date') : missing;
}

// Drop anything the order already has a value for, so the write can only add.
function additiveOnly(order, attributes) {
  return Object.fromEntries(
    Object.entries(attributes).filter(([name]) => {
      const existing = getNoteAttribute(order, name);
      return existing === null || existing === undefined || existing === '';
    })
  );
}

function hasHdsRecords(order) {
  return Boolean(
    getNoteAttribute(order, 'HDS Ship Date') ||
      getNoteAttribute(order, 'HDS Pack Date') ||
      getNoteAttribute(order, 'HDS Production Date') ||
      getNoteAttribute(order, 'Pick-Pack-Date')
  );
}

// overwrite: replace values already on the order rather than only adding missing
// ones. For correcting a set that was written wrongly — a pack date typed by hand,
// say — where the existing values are the problem rather than something to protect.
async function fillHdsRecords(order, { dryRun = false, overwrite = false } = {}) {
  const orderId = order?.id;
  if (!orderId) return { ok: false, reason: 'order payload has no id' };

  const raw = getNoteAttribute(order, 'Delivery-Date') || getNoteAttribute(order, 'HDS Delivery Date');
  if (!raw) return { ok: false, reason: 'no Delivery-Date to derive the pack date from' };
  const deliveryDate = normalizeDate(raw);

  const wanted = weekdayOf(deliveryDate);
  if (!wanted) return { ok: false, reason: `unparseable Delivery-Date: ${raw}` };

  const candidates = locationCandidatesFor(order);
  if (!candidates.length) return { ok: false, reason: 'no postcode and suburb to look up' };

  const attempts = [];
  for (const candidate of candidates) {
    const res = await fetchDeliveryOptions({ postcode: candidate.postcode, suburb: candidate.suburb });
    if (!res.ok) {
      attempts.push(`${candidate.suburb} ${candidate.postcode} (${candidate.source}): ${res.reason}`);
      continue;
    }

    const options = Array.isArray(res.data.delivery_options) ? res.data.delivery_options : [];
    // Match the weekday, not the date: HDS drops options whose cutoff has passed,
    // so the order's own date is usually no longer listed even though its schedule
    // still exists.
    const option = options.find(
      (o) => String(o.delivery_day).toLowerCase() === String(wanted).toLowerCase()
    );
    if (!option) {
      attempts.push(
        `${candidate.suburb} ${candidate.postcode}: no ${wanted} schedule ` +
          `(offers ${[...new Set(options.map((o) => o.delivery_day))].join(', ') || 'nothing'})`
      );
      continue;
    }

    const packGap = daysBetween(option.delivery_date, option.pack_date);
    const productionGap = daysBetween(option.delivery_date, option.production_date);

    const resolved = {
      charge_date: String(order.created_at || '').slice(0, 10) || null,
      matched_by: `${wanted} schedule ${option.schedule_id} (delivery date kept as it was)`,
      delivery_date: deliveryDate,
      pack_date: packGap == null ? null : subtractDays(deliveryDate, packGap),
      production_date: productionGap == null ? null : subtractDays(deliveryDate, productionGap),
      region: res.data.region?.name || null,
      suburb: res.data.suburb?.name || candidate.suburb,
      postcode: res.data.suburb?.postcode || candidate.postcode,
      schedule_id: option.schedule_id ?? null,
      delivery_day: option.delivery_day || wanted,
      delivery_window: option.delivery_window || null,
      formatted_date: formatLongDate(deliveryDate),
      option,
      // The cutoff for THIS delivery date, from the schedule's own cutoff weekday.
      // Not the order date: these orders are not charged at the HDS cutoff.
      cutoff_override: cutoffFor({ delivery_date: deliveryDate, cutoff_info: option.cutoff_info }),
    };

    const built = buildOrderAttributes(resolved, {
      preferredWindow: getNoteAttribute(order, 'HDS Delivery Window'),
    });

    const scope = fillScope();
    let attributes = overwrite ? built : additiveOnly(order, built);

    if (scope === 'pack-date') {
      // Just the one key NetSuite reads. Everything else the order already had
      // stays exactly as it was.
      attributes = attributes['Pick-Pack-Date']
        ? { 'Pick-Pack-Date': attributes['Pick-Pack-Date'] }
        : {};
    }

    if (!Object.keys(attributes).length) {
      return {
        ok: false,
        reason:
          scope === 'pack-date'
            ? 'Pick-Pack-Date is already set — nothing to add'
            : 'every HDS field already has a value — nothing to add',
      };
    }

    const tag = packDateTag(resolved.pack_date);
    const dateTag = deliveryDateTag(resolved.delivery_date);
    const tags = [tag, dateTag].filter(Boolean);

    if (dryRun) return { ok: true, dryRun: true, resolved, attributes, tag, tags, locationUsed: candidate, scope };

    await updateOrderAttributes(orderId, {
      attributes,
      addTags: tags,
      // Additive: nothing stripped. A tag the order already carries is
      // deduplicated by mergeTags rather than repeated.
      removeTagPrefixes: [],
      removeAttributes: [],
      order,
    });

    return { ok: true, resolved, attributes, tag, tags, locationUsed: candidate, scope };
  }

  return { ok: false, reason: attempts.join('; ') || 'no serviceable address on the order' };
}

module.exports.hasHdsRecords = hasHdsRecords;
module.exports.HDS_FIELDS = HDS_FIELDS;
module.exports.missingHdsFields = missingHdsFields;
module.exports.pendingHdsFields = pendingHdsFields;
module.exports.additiveOnly = additiveOnly;
module.exports.fillScope = fillScope;
module.exports.fillHdsRecords = fillHdsRecords;

// Tags live in ./order-tags.js — a single implementation, so the webhook and the
// CLI cannot drift apart on what an order should be tagged with.
