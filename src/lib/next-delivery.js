// Pure weekday arithmetic: "next upcoming <weekday>, minus the offset".
//
// This is the calculation stated in plain terms — no API call, no schedule table.
// It is the fallback for when HDS offers nothing for a customer's weekday, and a
// cross-check on the HDS-sourced path.
//
// IMPORTANT: offsetDays is the CHARGE/CUTOFF offset, not the pack offset. Order
// 1137 proves the two differ:
//
//   delivery 2026-08-10 (Mon)
//   cutoff   2026-08-07 (Fri)  = delivery - 3   <- "Charge Offset: 3 Days"
//   pack     2026-08-09 (Sun)  = delivery - 1
//
// Subtracting 3 to get a PACK date would put it two days early in NSW, and the
// gap is region-specific (NSW packs delivery-1, VIC delivery-2). So pack and
// production come from HDS wherever HDS has the schedule; this module only
// derives what weekday arithmetic can honestly derive.

const DAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const DAY_NAME = (index) => {
  const name = Object.keys(DAY_INDEX).find((k) => DAY_INDEX[k] === index);
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
};

function toUtcDate(value) {
  if (!value) return null;
  const iso = String(value).slice(0, 10);
  const d = new Date(iso + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

function shift(date, days) {
  const out = new Date(date.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

const iso = (date) => date.toISOString().slice(0, 10);

// The next occurrence of deliveryDay, and the charge/cutoff date offsetDays before it.
//
//   deliveryDay  "Sunday" | "monday" | 0-6
//   offsetDays   days the charge lands BEFORE delivery (the schedule cutoff gap)
//   from         reference date (default: today, UTC). Pass the ORDER date when
//                rewriting an order, so a backfill run weeks later still computes
//                the cycle that order belonged to rather than one relative to now.
//   inclusive    true (default) lets the reference date itself count when it
//                already falls on deliveryDay; false always moves a week on.
function calculateNextDeliveryDate(deliveryDay, offsetDays, { from = null, inclusive = true } = {}) {
  const target =
    typeof deliveryDay === 'number'
      ? deliveryDay
      : DAY_INDEX[String(deliveryDay || '').trim().toLowerCase()];

  if (target === undefined || target === null) {
    return { ok: false, reason: `unrecognised delivery day: ${deliveryDay}` };
  }

  const start = from ? toUtcDate(from) : toUtcDate(new Date().toISOString());
  if (!start) return { ok: false, reason: `unrecognised reference date: ${from}` };

  let ahead = (target - start.getUTCDay() + 7) % 7;
  if (ahead === 0 && !inclusive) ahead = 7;

  const delivery = shift(start, ahead);

  // Number(null) is 0, so an absent offset must be detected before coercing —
  // otherwise "no offset" would silently claim the charge lands on delivery day.
  const hasOffset = offsetDays !== undefined && offsetDays !== null && offsetDays !== '';
  const offset = hasOffset ? Number(offsetDays) : null;
  if (hasOffset && (!Number.isFinite(offset) || offset < 0)) {
    return { ok: false, reason: `offsetDays must be a non-negative number, got ${offsetDays}` };
  }

  const charge = hasOffset ? shift(delivery, -Math.trunc(offset)) : null;

  return {
    ok: true,
    delivery_date: iso(delivery),
    delivery_day: DAY_NAME(target),
    // The cutoff / charge date. NOT the pack date — see the note at the top.
    charge_date: charge ? iso(charge) : null,
    charge_day: charge ? DAY_NAME(charge.getUTCDay()) : null,
    days_ahead: ahead,
    reference_date: iso(start),
  };
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// "2026-08-24" -> "Monday 24 August 2026", matching HDS's formatted_date, so a
// fallback-built order reads identically to an HDS-built one.
function formatLongDate(value) {
  const d = toUtcDate(value);
  if (!d) return null;
  return `${DAY_NAME(d.getUTCDay())} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Days between two dates, or null if either is unparseable. Used to carry a
// customer's own delivery->pack gap forward, which is region-correct by
// construction: NSW packs the day before, VIC two days before.
function daysBetween(laterValue, earlierValue) {
  const later = toUtcDate(laterValue);
  const earlier = toUtcDate(earlierValue);
  if (!later || !earlier) return null;
  return Math.round((later.getTime() - earlier.getTime()) / 86400000);
}

function subtractDays(value, days) {
  const d = toUtcDate(value);
  if (!d || !Number.isFinite(Number(days))) return null;
  return iso(shift(d, -Math.trunc(Number(days))));
}

module.exports = {
  calculateNextDeliveryDate,
  formatLongDate,
  daysBetween,
  subtractDays,
  DAY_INDEX,
  DAY_NAME,
};
