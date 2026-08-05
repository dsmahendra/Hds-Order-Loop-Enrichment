// Resolving the delivery date for a Loop renewal.
//
// A renewal has no customer-picked date, so we derive one from Loop's next
// charge date — NOT from "next weekday from today". We ask the same HDS public
// API the checkout uses and take the earliest option that lands on or after the
// charge date (plus an optional lead-time offset), so a renewal is scheduled
// exactly like a checkout order for the same suburb.

const LEAD_DAYS = Number(process.env.LOOP_DELIVERY_LEAD_DAYS || 0);

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

// Fetch the HDS delivery options for a suburb/postcode.
async function fetchDeliveryOptions({ postcode, suburb }) {
  const params = new URLSearchParams({ postcode: String(postcode) });
  if (suburb) params.set('suburb', String(suburb));

  const url = `${base()}/api/public/delivery-options?${params.toString()}`;

  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    return { ok: false, reason: `network error: ${err.message}` };
  }

  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, reason: `bad JSON (HTTP ${res.status})` };
  if (data.success === false || data.serviceable === false) {
    return { ok: false, reason: data.error || 'not serviceable' };
  }

  return { ok: true, data };
}

// Pick the delivery date for a renewal.
//
// Returns { ok: true, data: { delivery_date, pack_date, production_date,
// region, suburb, postcode, charge_date } } or { ok: false, reason }.
async function resolveRenewalDelivery({ postcode, suburb, chargeDateEpoch, chargeDateIso }) {
  if (!postcode) return { ok: false, reason: 'missing postcode' };

  const chargeDate = toChargeDate({ epoch: chargeDateEpoch, iso: chargeDateIso });
  if (!chargeDate) return { ok: false, reason: 'missing next charge date' };

  const earliest = addDays(chargeDate, LEAD_DAYS);

  const result = await fetchDeliveryOptions({ postcode, suburb });
  if (!result.ok) return result;

  const options = Array.isArray(result.data.delivery_options)
    ? result.data.delivery_options
    : [];

  // Earliest option on or after the charge date (+ lead time). Options aren't
  // guaranteed sorted, so sort rather than trusting API order.
  const candidates = options
    .filter((o) => o?.delivery_date && o.delivery_date >= earliest)
    .sort((a, b) => a.delivery_date.localeCompare(b.delivery_date));

  const chosen = candidates[0];
  if (!chosen) {
    return {
      ok: false,
      reason: `no HDS delivery option on or after ${earliest} (charge ${chargeDate})`,
    };
  }

  return {
    ok: true,
    data: {
      charge_date: chargeDate,
      delivery_date: chosen.delivery_date,
      pack_date: chosen.pack_date || null,
      production_date: chosen.production_date || null,
      region: result.data.region?.name || null,
      suburb: result.data.suburb?.name || suburb || null,
      postcode: result.data.suburb?.postcode || String(postcode),
      // Everything the checkout extension also stamps on the order.
      schedule_id: chosen.schedule_id ?? null,
      delivery_day: chosen.delivery_day || null,
      delivery_window: chosen.delivery_window || null,
      formatted_date: chosen.formatted_date || null,
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
function buildHdsAttributes(resolved, preferredWindow = null) {
  const offered = String(resolved.delivery_window || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const window =
    (preferredWindow && offered.includes(preferredWindow) ? preferredWindow : null) ||
    preferredWindow ||
    process.env.LOOP_DEFAULT_DELIVERY_WINDOW ||
    offered[0] ||
    null;

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

module.exports = { resolveRenewalDelivery, buildHdsAttributes, toChargeDate, addDays };
