// One order's real, live verdict: still genuinely broken, already fixed,
// failing for some other reason, or not enough data to tell.
//
// Shared between stuck-schedules.js (the on-demand report) and the alert
// digest (the automated email) so the two can never disagree about what
// "still broken" means. Each finds its own list of CANDIDATE order ids to
// check (differently — one from a CLI flag, one from orders_to_enrich) but
// both hand every candidate here for the actual answer, fetched fresh from
// Shopify and checked against the live HDS API — not read off a historical DB
// row, whose recorded postcode/suburb can be wrong (see locationCandidatesFor)
// and whose failure may already have been fixed since it was recorded.

const { fetchDeliveryOptions } = require('./renewal-date');
const { weekdayOf, locationCandidatesFor, locationFor } = require('./renewal-rewrite');
const { getOrder, getNoteAttribute, normalizeDate } = require('../shopify');

const packDateOf = (order) =>
  getNoteAttribute(order, 'Pick-Pack-Date') ||
  getNoteAttribute(order, 'HDS Ship Date') ||
  getNoteAttribute(order, 'HDS Pack Date');

// Returns one of:
//   { verdict: 'fetch-failed', detail }                     Shopify call itself failed
//   { verdict: 'not-found' }                                 order id doesn't exist (deleted?)
//   { verdict: 'fixed', order }                               already has a pack date
//   { verdict: 'skip', detail, order }                        not enough data to check
//   { verdict: 'other', detail, order }                       failing, but not a withdrawn weekday
//   { verdict: 'stuck', detail, order, wanted, offered, location }   the real, targeted answer
async function checkOrder(orderId) {
  let order;
  try {
    order = (await getOrder(orderId))?.order;
  } catch (err) {
    return { verdict: 'fetch-failed', detail: err.message.split('\n')[0] };
  }
  if (!order) return { verdict: 'not-found' };

  if (packDateOf(order)) return { verdict: 'fixed', order };

  const candidates = locationCandidatesFor(order);
  if (!candidates.length) {
    const partial = locationFor(order);
    return {
      verdict: 'skip',
      detail: `no usable postcode/suburb (shipping address / HDS attributes) — best guess ${partial.suburb || '?'} / ${partial.postcode || '?'}`,
      order,
    };
  }

  const rawDelivery = getNoteAttribute(order, 'Delivery-Date') || getNoteAttribute(order, 'HDS Delivery Date');
  const deliveryDate = rawDelivery ? normalizeDate(rawDelivery) : null;
  const wanted = deliveryDate ? weekdayOf(deliveryDate) : null;
  if (!wanted) return { verdict: 'skip', detail: 'no parseable Delivery-Date on the order', order };

  // Same fallback order fillHdsRecords itself tries: shipping address, then
  // the labelled HDS attributes — so this reaches the identical verdict.
  let offered = null;
  let checkedWith = null;
  let hdsFailure = null;
  for (const candidate of candidates) {
    const res = await fetchDeliveryOptions({ postcode: candidate.postcode, suburb: candidate.suburb });
    if (!res.ok) {
      hdsFailure = `${candidate.suburb} ${candidate.postcode} (${candidate.source}): ${res.reason}`;
      continue;
    }
    offered = [...new Set((res.data.delivery_options || []).map((o) => o.delivery_day))];
    checkedWith = candidate;
    if (offered.some((d) => String(d).toLowerCase() === wanted.toLowerCase())) break;
  }

  if (!offered) {
    return { verdict: 'other', detail: `could not check HDS for any candidate address — ${hdsFailure}`, order };
  }

  const isOffered = offered.some((d) => String(d).toLowerCase() === wanted.toLowerCase());
  if (isOffered) {
    // HDS offers this weekday now, so whatever failed was something else — a
    // transient blip at the time, an address HDS didn't recognise, etc.
    return {
      verdict: 'other',
      detail: `${checkedWith.suburb} ${checkedWith.postcode} DOES offer ${wanted} now — different cause`,
      order,
    };
  }

  return {
    verdict: 'stuck',
    detail: `anchored to ${wanted} for ${checkedWith.suburb} ${checkedWith.postcode}, but HDS now only offers ${offered.join(', ') || 'nothing'} there`,
    order,
    wanted,
    offered,
    location: checkedWith,
  };
}

module.exports = { checkOrder, packDateOf };
