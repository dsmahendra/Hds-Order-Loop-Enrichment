// Selecting orders by when they were placed, in STORE time.
//
// Shopify's created_at already carries the store's offset:
//
//   "2026-09-03T22:46:12+10:00"
//
// so the part before the offset IS the local time the order was placed. Comparing
// that substring against a local bound needs no timezone maths at all — no shop
// timezone lookup, no DST edge case, no library. ISO strings of equal shape sort
// correctly, which is the whole trick.
//
// The one thing to get right is precision. A bound of "22:56" must include an
// order at 22:56:30, so an end bound without seconds is padded to :59 and a start
// bound to :00. Without that, "2026-09-03T22:56:30" <= "2026-09-03T22:56" is
// false and the last minute of the window silently drops out.

// "2026-09-03T22:46:12+10:00" -> "2026-09-03T22:46:12"
// "2026-09-03T22:46:12Z"      -> "2026-09-03T22:46:12"
function localPart(createdAt) {
  const s = String(createdAt || '');
  const m = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : null;
}

// Accepts "2026-09-03", "2026-09-03 22:46", "2026-09-03T22:46", "…T22:46:12".
// end=true pads the missing precision upwards so the bound is inclusive.
function parseLocalBound(value, { end = false } = {}) {
  if (!value) return null;
  const s = String(value).trim().replace(' ', 'T');

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T${end ? '23:59:59' : '00:00:00'}`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return `${s}:${end ? '59' : '00'}`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return s;
  return null;
}

// Inclusive on both ends. An unparseable created_at is excluded rather than
// silently swept in.
function createdWithin(order, from, to) {
  const local = localPart(order?.created_at);
  if (!local) return false;
  if (from && local < from) return false;
  if (to && local > to) return false;
  return true;
}

// The date part of a bound, for the API's created_at_min — which is a date, so it
// only narrows the scan rather than replacing the exact filter above.
function dateOf(bound) {
  return bound ? bound.slice(0, 10) : null;
}

module.exports = { localPart, parseLocalBound, createdWithin, dateOf };
