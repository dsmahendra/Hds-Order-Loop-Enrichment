const test = require('node:test');
const assert = require('node:assert');

const {
  needsRewrite,
  buildOrderAttributes,
  packDateTag,
  cutoffFor,
  toSlashDate,
  locationFor,
  timeRangeForWindow,
} = require('../src/lib/renewal-rewrite');
const { mergeNoteAttributes, mergeTags } = require('../src/shopify');

const attrs = (pairs) => ({
  note_attributes: Object.entries(pairs).map(([name, value]) => ({ name, value })),
});

// --- cutoff derivation -------------------------------------------------------
// HDS states the cutoff as a weekday ("Friday 11 PM"), not a date. Pairing it
// with the delivery date yields both the cutoff date and the charge offset.
// The expectations below were verified against both live regions.

test('cutoffFor derives the NSW cutoff (Monday delivery, Friday cutoff = 3 days)', () => {
  assert.deepStrictEqual(cutoffFor({ delivery_date: '2026-08-24', cutoff_info: 'Friday 11 PM' }), {
    cutoff_date: '2026-08-21',
    cutoff_day: 'Friday',
    charge_offset_days: 3,
  });
});

test('cutoffFor derives the VIC cutoff (Friday delivery, Monday cutoff = 4 days)', () => {
  assert.deepStrictEqual(cutoffFor({ delivery_date: '2026-08-28', cutoff_info: 'Monday 11 PM' }), {
    cutoff_date: '2026-08-24',
    cutoff_day: 'Monday',
    charge_offset_days: 4,
  });
});

test('cutoffFor reproduces the values the checkout extension itself wrote', () => {
  // Order 1137 carried cutoff 2026/08/07 and "3 Days" for a 2026/08/10 delivery.
  const c = cutoffFor({ delivery_date: '2026-08-10', cutoff_info: 'Friday 11 PM' });
  assert.strictEqual(c.cutoff_date, '2026-08-07');
  assert.strictEqual(c.charge_offset_days, 3);
});

test('cutoffFor goes a full week back when the cutoff day is the delivery day', () => {
  const c = cutoffFor({ delivery_date: '2026-08-24', cutoff_info: 'Monday 11 PM' });
  assert.strictEqual(c.cutoff_date, '2026-08-17');
  assert.strictEqual(c.charge_offset_days, 7);
});

test('cutoffFor returns nulls rather than guessing when cutoff_info is absent', () => {
  assert.deepStrictEqual(cutoffFor({ delivery_date: '2026-08-24' }), {
    cutoff_date: null,
    cutoff_day: null,
    charge_offset_days: null,
  });
});

// --- staleness detection -----------------------------------------------------

test('needsRewrite flags a delivery date earlier than the order date', () => {
  const state = needsRewrite({
    created_at: '2026-08-19T12:00:00+10:00',
    ...attrs({ 'Delivery-Date': '2026/08/10' }),
  });
  assert.strictEqual(state.stale, true);
  assert.match(state.reason, /2026-08-10 is before the order date 2026-08-19/);
});

test('needsRewrite leaves a delivery date on or after the order date alone', () => {
  for (const value of ['2026/08/19', '2026/08/24']) {
    const state = needsRewrite({
      created_at: '2026-08-19T12:00:00Z',
      ...attrs({ 'Delivery-Date': value }),
    });
    assert.strictEqual(state.stale, false, value + ' should not be stale');
  }
});

test('needsRewrite flags an order carrying no delivery date at all', () => {
  const state = needsRewrite({ created_at: '2026-08-19T12:00:00Z', note_attributes: [] });
  assert.strictEqual(state.stale, true);
});

test('needsRewrite falls back to the labelled HDS key', () => {
  const state = needsRewrite({
    created_at: '2026-08-19T12:00:00Z',
    ...attrs({ 'HDS Delivery Date': '2026/08/10' }),
  });
  assert.strictEqual(state.stale, true);
});

test('needsRewrite does not rewrite when there is no order date to compare', () => {
  assert.strictEqual(needsRewrite(attrs({ 'Delivery-Date': '2026/08/10' })).stale, false);
});

// --- attribute construction --------------------------------------------------

const RESOLVED = {
  delivery_date: '2026-08-24',
  pack_date: '2026-08-23',
  production_date: '2026-08-22',
  region: 'NSW Sydney Metro',
  suburb: 'PRAIRIEWOOD',
  postcode: '2176',
  schedule_id: 1,
  delivery_day: 'Monday',
  delivery_window: 'AM,Business Hours',
  formatted_date: 'Monday 24 August 2026',
  option: { delivery_date: '2026-08-24', cutoff_info: 'Friday 11 PM' },
};

test('buildOrderAttributes writes the downstream keys in yyyy/mm/dd', () => {
  const a = buildOrderAttributes(RESOLVED);
  assert.strictEqual(a['Delivery-Date'], '2026/08/24');
  assert.strictEqual(a['Pick-Pack-Date'], '2026/08/23');
  assert.strictEqual(a['HDS Production Date'], '2026/08/22');
  assert.strictEqual(a['HDS Cutoff Date'], '2026/08/21');
  assert.strictEqual(a['Charge Offset'], '3 Days');
});

test('buildOrderAttributes keeps the customer window when the schedule offers it', () => {
  const kept = buildOrderAttributes(RESOLVED, { preferredWindow: 'Business Hours' });
  assert.strictEqual(kept['HDS Delivery Window'], 'Business Hours');
  assert.strictEqual(buildOrderAttributes(RESOLVED)['HDS Delivery Window'], 'AM');
});

test('buildOrderAttributes never writes the fields other systems own', () => {
  const keys = Object.keys(buildOrderAttributes(RESOLVED));
  const owned = [
    'Delivery-Time',
    'Delivery-Location-Id',
    'Delivery-Slot-Id',
    'Checkout-Method',
    '_amp_sc',
  ];
  for (const key of owned) {
    assert.ok(!keys.includes(key), 'must not write ' + key);
  }
});

test('buildOrderAttributes omits keys it could not derive', () => {
  const a = buildOrderAttributes({ ...RESOLVED, production_date: null, option: {} });
  assert.ok(!('HDS Production Date' in a));
  assert.ok(!('Charge Offset' in a));
});

// --- Delivery-Time mapping ---------------------------------------------------
// HDS knows window NAMES, not clock ranges, so the range is configuration.

const withWindowTimes = (json, fn) => {
  const saved = process.env.DELIVERY_WINDOW_TIMES;
  if (json === undefined) delete process.env.DELIVERY_WINDOW_TIMES;
  else process.env.DELIVERY_WINDOW_TIMES = json;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.DELIVERY_WINDOW_TIMES;
    else process.env.DELIVERY_WINDOW_TIMES = saved;
  }
};

const WINDOW_TIMES = '{"AM":"12:00 AM - 7:00 AM","Business Hours":"8:00 AM - 6:00 PM"}';

test('Delivery-Time is left untouched when no mapping is configured', () => {
  withWindowTimes(undefined, () => {
    assert.ok(!('Delivery-Time' in buildOrderAttributes(RESOLVED)));
  });
});

test('Delivery-Time follows the chosen window when a mapping is configured', () => {
  withWindowTimes(WINDOW_TIMES, () => {
    assert.strictEqual(buildOrderAttributes(RESOLVED)['Delivery-Time'], '12:00 AM - 7:00 AM');
    const other = buildOrderAttributes(RESOLVED, { preferredWindow: 'Business Hours' });
    assert.strictEqual(other['Delivery-Time'], '8:00 AM - 6:00 PM');
  });
});

test('timeRangeForWindow tolerates casing drift between schedule and config', () => {
  withWindowTimes(WINDOW_TIMES, () => {
    assert.strictEqual(timeRangeForWindow('am'), '12:00 AM - 7:00 AM');
    assert.strictEqual(timeRangeForWindow('BUSINESS HOURS'), '8:00 AM - 6:00 PM');
  });
});

test('an unmapped window leaves Delivery-Time alone rather than blanking it', () => {
  withWindowTimes('{"Evening":"5:00 PM - 9:00 PM"}', () => {
    assert.ok(!('Delivery-Time' in buildOrderAttributes(RESOLVED)));
  });
});

test('invalid DELIVERY_WINDOW_TIMES fails safe instead of throwing', () => {
  withWindowTimes('{not json', () => {
    assert.ok(!('Delivery-Time' in buildOrderAttributes(RESOLVED)));
  });
});

test('packDateTag matches the tag format already on the orders', () => {
  assert.strictEqual(packDateTag('2026-08-22'), 'Pick-Pack-Date-22-08-2026');
  assert.strictEqual(packDateTag(null), null);
});

test('toSlashDate trims a timestamp to the date', () => {
  assert.strictEqual(toSlashDate('2026-08-24T00:00:00Z'), '2026/08/24');
});

// --- location resolution -----------------------------------------------------

test('locationFor ignores Delivery-Location-Id, which held a region name', () => {
  const loc = locationFor({
    shipping_address: { city: 'Prairiewood', zip: '2176' },
    ...attrs({ 'Delivery-Location-Id': 'NSW Sydney Metro' }),
  });
  assert.deepStrictEqual(loc, { postcode: '2176', suburb: 'Prairiewood' });
});

test('locationFor prefers the labelled HDS keys over the shipping address', () => {
  const loc = locationFor({
    shipping_address: { city: 'Somewhere Else', zip: '9999' },
    ...attrs({ 'HDS Postcode': '2176', 'HDS Suburb': 'PRAIRIEWOOD' }),
  });
  assert.deepStrictEqual(loc, { postcode: '2176', suburb: 'PRAIRIEWOOD' });
});

// --- merge semantics ---------------------------------------------------------
// The Admin API replaces note_attributes and tags wholesale, so both must merge.

test('mergeNoteAttributes overwrites our keys and preserves the rest', () => {
  const merged = mergeNoteAttributes(
    [
      { name: 'Delivery-Time', value: '12:00 AM - 7:00 AM' },
      { name: 'Delivery-Date', value: '2026/08/10' },
      { name: '_amp_sc', value: 'opaque' },
    ],
    { 'Delivery-Date': '2026/08/24', 'Pick-Pack-Date': '2026/08/23' }
  );
  assert.deepStrictEqual(merged, [
    { name: 'Delivery-Time', value: '12:00 AM - 7:00 AM' },
    { name: 'Delivery-Date', value: '2026/08/24' },
    { name: '_amp_sc', value: 'opaque' },
    { name: 'Pick-Pack-Date', value: '2026/08/23' },
  ]);
});

test('mergeNoteAttributes skips empty values instead of blanking a field', () => {
  const merged = mergeNoteAttributes([{ name: 'Delivery-Date', value: '2026/08/10' }], {
    'Delivery-Date': null,
    'HDS Region': '',
  });
  assert.deepStrictEqual(merged, [{ name: 'Delivery-Date', value: '2026/08/10' }]);
});

test('mergeTags replaces the superseded pick-pack tag and keeps the rest', () => {
  const tags = mergeTags(
    'Subscription, Pick-Pack-Date-09-08-2026, Deliver every 1 WEEK',
    ['Pick-Pack-Date-23-08-2026'],
    ['Pick-Pack-Date-']
  );
  assert.strictEqual(tags, 'Subscription, Deliver every 1 WEEK, Pick-Pack-Date-23-08-2026');
});

test('mergeTags does not duplicate a tag that is already present', () => {
  assert.strictEqual(mergeTags('Subscription, VIP', ['vip']), 'Subscription, VIP');
});
