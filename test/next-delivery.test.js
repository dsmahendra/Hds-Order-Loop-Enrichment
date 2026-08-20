const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateNextDeliveryDate,
  formatLongDate,
  daysBetween,
  subtractDays,
} = require('../src/lib/next-delivery');
const { previousTuple, fallbackFromWeekdayMath } = require('../src/lib/renewal-rewrite');

const attrs = (pairs) => ({
  note_attributes: Object.entries(pairs).map(([name, value]) => ({ name, value })),
});

// --- calculateNextDeliveryDate ----------------------------------------------

test('next upcoming weekday, minus the offset for the charge date', () => {
  // Wed 20 Aug 2025 -> Sun 24 Aug 2025, charge 3 days earlier.
  const r = calculateNextDeliveryDate('Sunday', 3, { from: '2025-08-20' });

  assert.equal(r.ok, true);
  assert.equal(r.delivery_date, '2025-08-24');
  assert.equal(r.delivery_day, 'Sunday');
  assert.equal(r.charge_date, '2025-08-21');
  assert.equal(r.days_ahead, 4);
});

test('the offset lands the charge on the schedule cutoff weekday', () => {
  // NSW: Monday delivery, offset 3 -> Friday cutoff. Matches HDS cutoff_info.
  const monday = calculateNextDeliveryDate('Monday', 3, { from: '2026-08-19' });
  assert.equal(monday.delivery_date, '2026-08-24');
  assert.equal(monday.charge_day, 'Friday');

  // VIC: Friday delivery, offset 4 -> Monday cutoff.
  const friday = calculateNextDeliveryDate('Friday', 4, { from: '2026-08-24' });
  assert.equal(friday.delivery_date, '2026-08-28');
  assert.equal(friday.charge_day, 'Monday');
});

test('the reference date itself counts when it already falls on the weekday', () => {
  const inclusive = calculateNextDeliveryDate('Monday', 3, { from: '2026-08-24' });
  assert.equal(inclusive.delivery_date, '2026-08-24');
  assert.equal(inclusive.days_ahead, 0);

  const exclusive = calculateNextDeliveryDate('Monday', 3, { from: '2026-08-24', inclusive: false });
  assert.equal(exclusive.delivery_date, '2026-08-31');
  assert.equal(exclusive.days_ahead, 7);
});

test('weekday accepts any casing, and an index', () => {
  assert.equal(calculateNextDeliveryDate('monday', 0, { from: '2026-08-19' }).delivery_date, '2026-08-24');
  assert.equal(calculateNextDeliveryDate('MONDAY', 0, { from: '2026-08-19' }).delivery_date, '2026-08-24');
  assert.equal(calculateNextDeliveryDate(1, 0, { from: '2026-08-19' }).delivery_date, '2026-08-24');
});

test('an unrecognised weekday is reported, not silently defaulted', () => {
  const r = calculateNextDeliveryDate('Someday', 3, { from: '2026-08-19' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unrecognised delivery day/);
});

test('a negative offset is rejected rather than pushing the charge later', () => {
  const r = calculateNextDeliveryDate('Monday', -3, { from: '2026-08-19' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /non-negative/);
});

test('a missing offset still yields a delivery date, with no charge date', () => {
  const r = calculateNextDeliveryDate('Monday', null, { from: '2026-08-19' });
  assert.equal(r.ok, true);
  assert.equal(r.delivery_date, '2026-08-24');
  assert.equal(r.charge_date, null);
});

// --- date helpers ------------------------------------------------------------

test('formatLongDate matches the HDS formatted_date spelling', () => {
  assert.equal(formatLongDate('2026-08-24'), 'Monday 24 August 2026');
  assert.equal(formatLongDate('not a date'), null);
});

test('daysBetween and subtractDays carry a gap forward', () => {
  assert.equal(daysBetween('2026-08-10', '2026-08-09'), 1);
  assert.equal(daysBetween('2026-08-28', '2026-08-26'), 2);
  assert.equal(daysBetween('2026-08-10', null), null);
  assert.equal(subtractDays('2026-08-24', 1), '2026-08-23');
});

// --- previous-cycle gaps -----------------------------------------------------
// The stale attributes are expired but still describe the SHAPE of the schedule.

test('previousTuple reads the delivery-to-pack gap off the stale attributes', () => {
  const t = previousTuple(
    attrs({
      'Delivery-Date': '2026/08/10',
      'HDS Pack Date': '2026/08/09',
      'HDS Production Date': '2026/08/08',
      'Charge Offset': '3 Days',
    })
  );

  assert.equal(t.packGap, 1); // NSW packs the day before
  assert.equal(t.productionGap, 2);
  assert.equal(t.chargeOffset, 3);
});

test('previousTuple reads a VIC two-day pack gap just as well', () => {
  const t = previousTuple(
    attrs({ 'Delivery-Date': '2026/08/24', 'Pick-Pack-Date': '2026/08/22' })
  );
  assert.equal(t.packGap, 2);
});

// --- the fallback ------------------------------------------------------------

const TUESDAY_ORDER = {
  created_at: '2026-08-19T12:00:00+10:00',
  ...attrs({
    'Delivery-Date': '2026/08/11',
    'HDS Pack Date': '2026/08/10',
    'HDS Production Date': '2026/08/09',
    'Charge Offset': '3 Days',
  }),
};
const TUESDAY_SCHEDULE = { scheduleId: null, deliveryDay: 'Tuesday', derivedFrom: 'test' };

const withFallback = (value, fn) => {
  const saved = process.env.FALLBACK_WEEKDAY_MATH;
  if (value === undefined) delete process.env.FALLBACK_WEEKDAY_MATH;
  else process.env.FALLBACK_WEEKDAY_MATH = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.FALLBACK_WEEKDAY_MATH;
    else process.env.FALLBACK_WEEKDAY_MATH = saved;
  }
};

test('the weekday-math fallback is off unless explicitly enabled', () => {
  withFallback(undefined, () => {
    const r = fallbackFromWeekdayMath(TUESDAY_ORDER, TUESDAY_SCHEDULE);
    assert.equal(r.ok, false);
    assert.match(r.reason, /FALLBACK_WEEKDAY_MATH/);
  });
});

test('enabled, the fallback keeps the weekday and carries the gaps forward', () => {
  withFallback('true', () => {
    const r = fallbackFromWeekdayMath(TUESDAY_ORDER, TUESDAY_SCHEDULE);

    assert.equal(r.ok, true);
    assert.equal(r.data.delivery_date, '2026-08-25'); // the next Tuesday
    assert.equal(r.data.pack_date, '2026-08-24'); // gap of 1, as before
    assert.equal(r.data.production_date, '2026-08-23'); // gap of 2, as before
    assert.equal(r.data.charge_date, '2026-08-22'); // offset of 3
    assert.match(r.data.matched_by, /weekday arithmetic/);
  });
});

test('the fallback needs a weekday to work from', () => {
  withFallback('true', () => {
    const r = fallbackFromWeekdayMath(TUESDAY_ORDER, { deliveryDay: null });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no delivery weekday/);
  });
});
