// Resolving the delivery date for a Loop renewal.
//
// A renewal has no customer-picked date, so we derive one from Loop's next
// charge date — NOT from "next weekday from today". We ask the same HDS public
// API the checkout uses and take the earliest option that lands on or after the
// charge date (plus an optional lead-time offset), so a renewal is scheduled
// exactly like a checkout order for the same suburb.

const LEAD_DAYS = Number(process.env.LOOP_DELIVERY_LEAD_DAYS || 0);

const {
  calculateNextDeliveryDate,
  formatLongDate,
  daysBetween,
  subtractDays,
} = require('./next-delivery');

function base() {
  return (process.env.HDS_API_BASE || '').replace(/\/+$/, '');
}

// Loop returns nextBillingDateEpoch (Unix, timezone-unambiguous) and an ISO 8601
// nextBillingDate in UTC. Prefer the epoch — it can't be misread.
function toChargeDate({ epoch, iso }) {
  if (epoch !== undefined && epoch !== null && epoch !== '') {
    const n = Number(epoch);
    if (Number.isFinite(n)) {
      // Loop's epoch is in seconds; tolerate milliseconds just in case.
      const ms = n > 1e11 ? n : n * 1000;
      return new Date(ms).toISOString().slice(0, 10);
    }
  }
  if (iso) return String(iso).slice(0, 10);
  return null;
}

function addDays(isoDate, days) {
  if (!days) return isoDate;
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// --- HDS lookups under load --------------------------------------------------
//
// A Loop renewal run asks HDS about one suburb per order, all at once, and every
// one of those is a fresh HTTP request for an answer that changes daily at most.
// Fifty renewals across a dozen suburbs made fifty calls; the same twelve answers
// would have done.
//
// Two things are cached, and the second matters more during a burst:
//
//   - a completed answer, for CACHE_TTL_MS
//   - the IN-FLIGHT request, so concurrent orders for one suburb share the single
//     call already on its way rather than each starting another
//
// The key carries the date because the answer contains dates. The TTL is short
// for the same reason: a cached answer must not outlive the day it describes.
const CACHE_TTL_MS = Number(process.env.HDS_CACHE_TTL_MS || 60 * 1000);

// A transient HDS blip used to cost the order its dates outright — the failure
// was returned, logged, and never retried. Retry the retryable and leave the rest
// alone: "not serviceable" is a real answer, not a glitch.
const HDS_ATTEMPTS = Number(process.env.HDS_FETCH_ATTEMPTS || 3);

const optionsCache = new Map(); // key -> { at, promise }

const cacheKey = ({ postcode, suburb }) =>
  `${new Date().toISOString().slice(0, 10)}|${postcode}|${String(suburb || '').toLowerCase()}`;

function pruneCache(now) {
  for (const [key, entry] of optionsCache) {
    if (now - entry.at > CACHE_TTL_MS) optionsCache.delete(key);
  }
}

function clearDeliveryOptionsCache() {
  optionsCache.clear();
}

const nap = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One attempt. Returns the same { ok, data } / { ok, reason } shape as before,
// plus retryable on the failures worth another go.
async function attemptDeliveryOptions({ postcode, suburb }) {
  const params = new URLSearchParams({ postcode: String(postcode) });
  if (suburb) params.set('suburb', String(suburb));

  const url = `${base()}/api/public/delivery-options?${params.toString()}`;

  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    return { ok: false, retryable: true, reason: `network error: ${err.message}` };
  }

  const data = await res.json().catch(() => null);
  if (!data) {
    // A non-JSON body means we reached SOME server but not the HDS API — almost
    // always a wrong HDS_API_BASE. Saying which base was used turns a blank
    // "bad JSON" into something actionable. A 5xx is the exception: that is HDS
    // itself struggling, and worth asking again.
    return {
      ok: false,
      retryable: res.status >= 500,
      reason:
        `HDS returned a non-JSON response (HTTP ${res.status}) from ${base()} — ` +
        'check HDS_API_BASE points at the HDS delivery admin backend',
    };
  }
  if (data.success === false || data.serviceable === false) {
    // A considered "no" from HDS. Asking again would get the same answer.
    return { ok: false, retryable: false, reason: data.error || 'not serviceable' };
  }

  return { ok: true, data };
}

async function fetchWithRetries(location) {
  let last = null;
  for (let attempt = 1; attempt <= HDS_ATTEMPTS; attempt += 1) {
    last = await attemptDeliveryOptions(location);
    if (last.ok || !last.retryable) break;

    if (attempt < HDS_ATTEMPTS) {
      const wait = Math.min(500 * 2 ** (attempt - 1), 4000);
      console.warn(
        `[hds] ${location.suburb || ''} ${location.postcode}: ${last.reason} — ` +
          `attempt ${attempt}/${HDS_ATTEMPTS}, retrying in ${wait}ms`
      );
      await nap(wait);
    }
  }
  // retryable is internal bookkeeping; callers only ever needed ok and reason.
  const { retryable, ...result } = last;
  return result;
}

// Fetch the HDS delivery options for a suburb/postcode.
async function fetchDeliveryOptions({ postcode, suburb }) {
  const now = Date.now();
  const key = cacheKey({ postcode, suburb });

  const hit = optionsCache.get(key);
  if (hit && now - hit.at <= CACHE_TTL_MS) return hit.promise;

  pruneCache(now);

  // The PROMISE goes in the map, not the result, so callers arriving while the
  // request is still in the air wait on it instead of starting their own.
  const promise = fetchWithRetries({ postcode, suburb });
  optionsCache.set(key, { at: now, promise });

  const result = await promise;

  // Never cache a failure: a wrong HDS_API_BASE gets fixed, an outage ends, and
  // a cached "no" would keep answering for orders that could now succeed.
  if (!result.ok) optionsCache.delete(key);

  return result;
}

// Pick the delivery date for a renewal.
//
// Returns { ok: true, data: { delivery_date, pack_date, production_date,
// region, suburb, postcode, charge_date } } or { ok: false, reason }.
// The weekday named in an option's cutoff ("Friday 11 PM" -> "Friday").
function cutoffWeekdayOf(option) {
  return String(option?.cutoff_info || '').trim().split(/\s+/)[0] || null;
}

async function resolveRenewalDelivery({
  postcode,
  suburb,
  chargeDateEpoch,
  chargeDateIso,
  scheduleId = null,
  deliveryDay = null,
  cutoffDay = null,
  allowDayChange = false,
}) {
  if (!postcode) return { ok: false, reason: 'missing postcode' };

  const chargeDate = toChargeDate({ epoch: chargeDateEpoch, iso: chargeDateIso });
  if (!chargeDate) return { ok: false, reason: 'missing next charge date' };

  const earliest = addDays(chargeDate, LEAD_DAYS);

  const result = await fetchDeliveryOptions({ postcode, suburb });
  if (!result.ok) return result;

  const options = Array.isArray(result.data.delivery_options)
    ? result.data.delivery_options
    : [];

  // Options aren't guaranteed sorted, so sort rather than trusting API order.
  const upcoming = options
    .filter((o) => o?.delivery_date && o.delivery_date >= earliest)
    .sort((a, b) => a.delivery_date.localeCompare(b.delivery_date));

  // Match the schedule whose CUTOFF falls on the day the order was created.
  //
  // Loop charges at the cutoff, so the day a renewal order appears identifies which
  // of the region's schedules it belongs to — and that schedule carries its own ship
  // and delivery days. NSW: a Friday cutoff ships Sunday and delivers Monday; a
  // Thursday cutoff ships Saturday and delivers Sunday.
  //
  // Read from HDS rather than a hardcoded region table: HDS already publishes the
  // triple per SUBURB, so this stays correct when a schedule changes and needs no
  // per-region maintenance.
  const byCutoffDay = cutoffDay
    ? upcoming.filter((o) => String(cutoffWeekdayOf(o)).toLowerCase() === String(cutoffDay).toLowerCase())
    : [];

  const bySchedule = scheduleId
    ? upcoming.filter((o) => String(o.schedule_id) === String(scheduleId))
    : [];
  const byDay = deliveryDay
    ? upcoming.filter((o) => String(o.delivery_day).toLowerCase() === String(deliveryDay).toLowerCase())
    : [];

  let candidates = upcoming;
  let matchedBy = 'earliest available';
  if (byCutoffDay.length) {
    candidates = byCutoffDay;
    matchedBy = `${cutoffDay} cutoff schedule`;
  } else if (cutoffDay) {
    // No schedule in this region cuts off on that weekday — NSW has no Saturday
    // cutoff, for instance. Take the soonest schedule whose cutoff is still ahead
    // rather than throwing: a late box beats an unprocessed order.
    matchedBy = `no ${cutoffDay} cutoff in this region — earliest available instead`;
  } else if (bySchedule.length) {
    candidates = bySchedule;
    matchedBy = `schedule ${scheduleId}`;
  } else if (byDay.length) {
    candidates = byDay;
    matchedBy = scheduleId ? `${deliveryDay} (schedule ${scheduleId} no longer offered)` : String(deliveryDay);
  } else if ((scheduleId || deliveryDay) && !allowDayChange) {
    return {
      ok: false,
      reason:
        `no HDS option on or after ${earliest} for ${deliveryDay || 'schedule ' + scheduleId}` +
        ` — the schedule may have been withdrawn (charge ${chargeDate})`,
    };
  }

  const chosen = candidates[0];
  if (!chosen) {
    return {
      ok: false,
      reason: `no HDS delivery option on or after ${earliest} (charge ${chargeDate})`,
    };
  }

  // Cutoff-day mode uses the schedule, not the schedule's next available date.
  //
  // HDS only lists options whose cutoff is still ahead of NOW, so an order created
  // on Friday 21 Aug can no longer be offered Monday 24 Aug once that Friday 23:00
  // cutoff passes — yet 24 Aug is the date that order was entitled to, and the one
  // a backfill has to produce. So we take the schedule (its delivery weekday and
  // its pack/production gaps, both region-specific) and compute the dates from the
  // ORDER date instead of reading the option's own.
  //
  // For a renewal processed on its charge day the two agree; they diverge only when
  // the order is handled after its cutoff, which is exactly when the computed date
  // is the correct one.
  let dates = {
    delivery_date: chosen.delivery_date,
    pack_date: chosen.pack_date || null,
    production_date: chosen.production_date || null,
    formatted_date: chosen.formatted_date || null,
  };

  if (byCutoffDay.length) {
    const packGap = daysBetween(chosen.delivery_date, chosen.pack_date);
    const productionGap = daysBetween(chosen.delivery_date, chosen.production_date);
    const next = calculateNextDeliveryDate(chosen.delivery_day, null, {
      from: chargeDate,
      inclusive: false, // a cutoff day is never its own delivery day
    });

    if (next.ok) {
      dates = {
        delivery_date: next.delivery_date,
        pack_date: packGap == null ? null : subtractDays(next.delivery_date, packGap),
        production_date: productionGap == null ? null : subtractDays(next.delivery_date, productionGap),
        formatted_date: formatLongDate(next.delivery_date),
      };
      matchedBy = `${cutoffDay} cutoff schedule ${chosen.schedule_id} (${chosen.delivery_day} delivery, computed from the order date)`;
    }
  }

  return {
    ok: true,
    data: {
      charge_date: chargeDate,
      matched_by: matchedBy,
      cutoff_day: cutoffWeekdayOf(chosen),
      delivery_date: dates.delivery_date,
      pack_date: dates.pack_date,
      production_date: dates.production_date,
      region: result.data.region?.name || null,
      suburb: result.data.suburb?.name || suburb || null,
      postcode: result.data.suburb?.postcode || String(postcode),
      // Everything the checkout extension also stamps on the order.
      schedule_id: chosen.schedule_id ?? null,
      delivery_day: chosen.delivery_day || null,
      delivery_window: chosen.delivery_window || null,
      formatted_date: dates.formatted_date,
      option: chosen,
    },
  };
}

// Build the note-attribute set a Loop renewal order should carry, matching the
// hds_* keys the checkout extension writes so a renewal is indistinguishable
// from a checkout order on the Shopify order page.
//
// preferredWindow: the customer's saved window. The API returns every window the
// schedule offers ("AM,Business Hours"), but an order carries the single chosen
// one — so keep theirs if we have it, else fall back to the first offered.
function chooseDeliveryWindow(resolved, preferredWindow = null) {
  const offered = String(resolved.delivery_window || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    (preferredWindow && offered.includes(preferredWindow) ? preferredWindow : null) ||
    preferredWindow ||
    process.env.LOOP_DEFAULT_DELIVERY_WINDOW ||
    offered[0] ||
    null
  );
}

function buildHdsAttributes(resolved, preferredWindow = null) {
  const window = chooseDeliveryWindow(resolved, preferredWindow);

  return {
    hds_delivery_date: resolved.delivery_date,
    hds_delivery_formatted: resolved.formatted_date,
    hds_delivery_day: resolved.delivery_day,
    hds_delivery_window: window,
    hds_schedule_id: resolved.schedule_id,
    hds_pack_date: resolved.pack_date,
    hds_production_date: resolved.production_date,
    hds_region: resolved.region,
    hds_suburb: resolved.suburb,
    hds_postcode: resolved.postcode,
  };
}

module.exports = {
  resolveRenewalDelivery,
  fetchDeliveryOptions,
  clearDeliveryOptionsCache,
  cutoffWeekdayOf,
  buildHdsAttributes,
  chooseDeliveryWindow,
  toChargeDate,
  addDays,
};
