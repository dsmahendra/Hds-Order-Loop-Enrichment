// Enrichment source of truth: the HDS public delivery-options API. We match the
// order's chosen delivery_date to the API's option for that suburb+postcode and
// read the already-computed pack/production/region/suburb. This keeps enrichment
// identical to what the checkout showed, and avoids duplicating schedule math.

function base() {
  return (process.env.HDS_API_BASE || '').replace(/\/+$/, '');
}

function toAdditionalParameters(option) {
  if (!option || typeof option !== 'object') return null;

  const { delivery_date, pack_date, production_date, ...rest } = option;
  return Object.keys(rest).length > 0 ? rest : null;
}

async function enrichFromHds({ postcode, suburb, deliveryDate, additionalParams = {} }) {
  if (!postcode || !deliveryDate) {
    return { ok: false, reason: 'missing postcode or delivery_date' };
  }

  const params = new URLSearchParams({ postcode: String(postcode) });
  if (suburb) params.set('suburb', String(suburb));

  for (const [key, value] of Object.entries(additionalParams)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }

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

  const options = Array.isArray(data.delivery_options) ? data.delivery_options : [];
  // Compare in ISO regardless of how the date was formatted upstream (yyyy/mm/dd).
  const wantISO = String(deliveryDate || '').replace(/\//g, '-');
  const match = options.find((o) => String(o.delivery_date).replace(/\//g, '-') === wantISO);
  if (!match) {
    return { ok: false, reason: `delivery_date ${deliveryDate} not in API options` };
  }

  const additionalParameters = toAdditionalParameters(match);

  return {
    ok: true,
    data: {
      hds_delivery_date: match.delivery_date,
      hds_pack_date: match.pack_date || null,
      hds_production_date: match.production_date || null,
      hds_region: data.region?.name || null,
      hds_suburb: data.suburb?.name || null,
      hds_postcode: data.suburb?.postcode || String(postcode),
      hds_additional_parameters: additionalParameters,
      hds_response: {
        matched_option: {
          delivery_date: match.delivery_date,
          pack_date: match.pack_date || null,
          production_date: match.production_date || null,
          ...additionalParameters,
        },
        region: data.region || null,
        suburb: data.suburb || null,
      },
    },
  };
}

// The checkout extension already resolved everything against HDS and stamped it
// on the order, so a complete hds_* attribute set IS the enrichment — calling
// the API again would only re-fetch what we already hold (and risk drifting from
// what the customer was actually shown, if a schedule changed since).
//
// Returns the same shape as enrichFromHds(), or { ok: false } when the set is
// incomplete, so the caller can fall back to the API.
const CORE_ATTRIBUTES = [
  'hds_delivery_date',
  'hds_pack_date',
  'hds_production_date',
  'hds_region',
  'hds_suburb',
  'hds_postcode',
];

function enrichFromAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object') {
    return { ok: false, reason: 'no hds_* attributes on order' };
  }

  const missing = CORE_ATTRIBUTES.filter((key) => !attributes[key]);
  if (missing.length > 0) {
    return { ok: false, reason: `incomplete hds_* attributes (missing ${missing.join(', ')})` };
  }

  // Anything beyond the core set — hds_delivery_formatted, hds_delivery_day,
  // hds_delivery_window, hds_schedule_id, and whatever the extension adds later.
  const extra = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!CORE_ATTRIBUTES.includes(key)) extra[key] = value;
  }

  return {
    ok: true,
    data: {
      hds_delivery_date: attributes.hds_delivery_date,
      hds_pack_date: attributes.hds_pack_date,
      hds_production_date: attributes.hds_production_date,
      hds_region: attributes.hds_region,
      hds_suburb: attributes.hds_suburb,
      hds_postcode: attributes.hds_postcode,
      hds_additional_parameters: Object.keys(extra).length > 0 ? extra : null,
      hds_response: { source: 'order_attributes', attributes },
    },
  };
}

module.exports = { enrichFromHds, enrichFromAttributes };
