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
  isPostcodeShaped,
  previousTuple,
  SUPERSEDED_ATTRIBUTES,
  scheduleFor,
  locationCandidatesFor,
  hasHdsRecords,
  additiveOnly,
  fillScope,
  HDS_FIELDS,
  pendingHdsFields,
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

// --- where the delivery weekday comes from -----------------------------------
// Loop has no deliveryDay field. Its only record of a weekday is the
// subscription's own Delivery-Date attribute.

test('the subscription Delivery-Date outranks anything on the order', () => {
  const order = {
    created_at: '2026-08-21T09:46:00+10:00',
    ...attrs({ 'Delivery-Date': '2026/08/17', 'HDS Delivery Day': 'Monday' }),
  };
  const schedule = scheduleFor(order, { 'Delivery-Date': '2026-07-26' }); // a Sunday

  assert.strictEqual(schedule.deliveryDay, 'Sunday');
  assert.match(schedule.derivedFrom, /Loop subscription Delivery-Date 2026-07-26/);
});

test('without subscription attributes it falls back to the order', () => {
  const order = { created_at: '2026-08-21T09:46:00+10:00', ...attrs({ 'HDS Delivery Day': 'Monday' }) };
  const schedule = scheduleFor(order, null);

  assert.strictEqual(schedule.deliveryDay, 'Monday');
  assert.match(schedule.derivedFrom, /order HDS Delivery Day/);
});

test('and then to the weekday of the order own delivery date', () => {
  const order = { created_at: '2026-08-21T09:46:00+10:00', ...attrs({ 'Delivery-Date': '2026/08/17' }) };
  const schedule = scheduleFor(order, null);

  assert.strictEqual(schedule.deliveryDay, 'Monday');
  assert.match(schedule.derivedFrom, /order Delivery-Date 2026-08-17/);
});

test('a subscription with no Delivery-Date does not mask the order value', () => {
  const order = { created_at: '2026-08-21T09:46:00+10:00', ...attrs({ 'HDS Delivery Day': 'Friday' }) };
  const schedule = scheduleFor(order, { 'Delivery-Time': '12:00 AM - 7:00 AM' });

  assert.strictEqual(schedule.deliveryDay, 'Friday');
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

// --- orders scheduled by another app -----------------------------------------
// Production orders come from Zapiet: a valid future Delivery-Date, a slot id, and
// no HDS fields. The date is right, so only the HDS records need adding.

test('an order with no HDS fields is detected as missing them', () => {
  const zapietOrder = attrs({
    'Delivery-Location-Id': '290879',
    'Delivery-Date': '2026/09/06',
    'Delivery-Time': '6:00 AM - 6:00 PM',
    'Delivery-Slot-Id': '140419042',
    'Checkout-Method': 'delivery',
  });

  assert.strictEqual(hasHdsRecords(zapietOrder), false);
});

test('any one of the HDS date fields counts as present', () => {
  for (const key of ['HDS Ship Date', 'HDS Pack Date', 'HDS Production Date', 'Pick-Pack-Date']) {
    assert.strictEqual(hasHdsRecords(attrs({ [key]: '2026/09/04' })), true, `${key} should count`);
  }
});

test('HDS Region alone does not count — it carries no date', () => {
  // Region without a pack date leaves the kitchen with nothing to work from.
  assert.strictEqual(hasHdsRecords(attrs({ 'HDS Region': 'VIC Melbourne Metro' })), false);
});

test('an order with no attributes at all is missing its HDS records', () => {
  assert.strictEqual(hasHdsRecords({ note_attributes: [] }), false);
  assert.strictEqual(hasHdsRecords({}), false);
});

// --- additive writes ---------------------------------------------------------
// On a store where other systems own the order, the fill must only ADD. A value
// already on the order is never replaced, whatever we computed for it.

test('a value already on the order is never replaced', () => {
  const order = attrs({
    'Delivery-Date': '2026/09/06',
    'Delivery-Time': '6:00 AM - 6:00 PM',
    'Delivery-Slot-Id': '140419042',
  });

  const kept = additiveOnly(order, {
    'Delivery-Date': '2026/09/13', // we computed something different
    'Delivery-Time': '12:00 AM - 7:00 AM',
    'Pick-Pack-Date': '2026/09/04', // genuinely missing
  });

  assert.deepStrictEqual(kept, { 'Pick-Pack-Date': '2026/09/04' });
});

test('an empty existing value counts as missing and is filled', () => {
  const order = attrs({ 'Pick-Pack-Date': '' });
  assert.deepStrictEqual(additiveOnly(order, { 'Pick-Pack-Date': '2026/09/04' }), {
    'Pick-Pack-Date': '2026/09/04',
  });
});

test('an order with nothing on it takes everything offered', () => {
  const kept = additiveOnly({ note_attributes: [] }, { 'Pick-Pack-Date': '2026/09/04', 'HDS Region': 'VIC' });
  assert.strictEqual(Object.keys(kept).length, 2);
});

test('the fill scope defaults to every missing HDS field', () => {
  const saved = process.env.FILL_HDS_ATTRIBUTES;
  try {
    // Adding every missing field is safe because the write is additive — nothing
    // already on the order is replaced — so the default is the fuller one.
    delete process.env.FILL_HDS_ATTRIBUTES;
    assert.strictEqual(fillScope(), 'all-missing');

    process.env.FILL_HDS_ATTRIBUTES = 'pack-date';
    assert.strictEqual(fillScope(), 'pack-date');

    process.env.FILL_HDS_ATTRIBUTES = 'everything';
    assert.strictEqual(fillScope(), 'all-missing');
  } finally {
    if (saved === undefined) delete process.env.FILL_HDS_ATTRIBUTES;
    else process.env.FILL_HDS_ATTRIBUTES = saved;
  }
});

test('a complete order needs no HDS lookup, an incomplete one names what it needs', () => {
  const complete = {};
  for (const f of HDS_FIELDS) complete[f] = 'x';

  assert.strictEqual(pendingHdsFields(attrs(complete)).length, 0, 'nothing pending');

  const { 'HDS Region': _region, 'Charge Offset': _offset, ...partial } = complete;
  assert.deepStrictEqual(pendingHdsFields(attrs(partial)), ['Charge Offset', 'HDS Region']);
});

// --- the key NetSuite reads --------------------------------------------------
// NetSuite reads Pick-Pack-Date. It is the one attribute another system depends on
// by name, so it must survive any future renaming of the HDS * set.

test('Pick-Pack-Date is written whenever a pack date was resolved', () => {
  const a = buildOrderAttributes(RESOLVED);

  assert.strictEqual(a['Pick-Pack-Date'], '2026/08/23');
  assert.strictEqual(a['Pick-Pack-Date'], a['HDS Ship Date'], 'both carry the same pack date');
});

test('Pick-Pack-Date is not silently dropped when other fields are missing', () => {
  // A schedule with no cutoff info loses Charge Offset, but the pack date stands.
  const a = buildOrderAttributes({ ...RESOLVED, option: {} });

  assert.ok(!('Charge Offset' in a));
  assert.strictEqual(a['Pick-Pack-Date'], '2026/08/23');
});

test('Pick-Pack-Date is omitted rather than blank when there is no pack date', () => {
  // Better absent than an empty string: NetSuite reading "" is worse than reading
  // nothing, and the held tag flags the order either way.
  const a = buildOrderAttributes({ ...RESOLVED, pack_date: null });

  assert.ok(!('Pick-Pack-Date' in a));
  assert.ok(!('HDS Ship Date' in a));
});

test('the pack-pack tag matches the Pick-Pack-Date value', () => {
  const a = buildOrderAttributes(RESOLVED);
  const tag = packDateTag(RESOLVED.pack_date);

  // 2026/08/23 -> Pick-Pack-Date-23-08-2026
  const [y, m, d] = a['Pick-Pack-Date'].split('/');
  assert.strictEqual(tag, `Pick-Pack-Date-${d}-${m}-${y}`);
});

// --- the HDS Ship Date rename ------------------------------------------------

test('buildOrderAttributes writes HDS Ship Date, not HDS Pack Date', () => {
  const a = buildOrderAttributes(RESOLVED);

  assert.strictEqual(a['HDS Ship Date'], '2026/08/23');
  assert.ok(!('HDS Pack Date' in a), 'the superseded label must not be written');
  // Pick-Pack-Date is a separate downstream key and keeps its name.
  assert.strictEqual(a['Pick-Pack-Date'], '2026/08/23');
});

test('the superseded label is listed for removal on rewrite', () => {
  assert.ok(SUPERSEDED_ATTRIBUTES.includes('HDS Pack Date'));
});

test('a renamed key is dropped rather than left holding a stale value', () => {
  const merged = mergeNoteAttributes(
    [
      { name: 'HDS Pack Date', value: '2026/08/09' },
      { name: 'Delivery-Time', value: '12:00 AM - 7:00 AM' },
    ],
    { 'HDS Ship Date': '2026/08/23' },
    SUPERSEDED_ATTRIBUTES
  );

  assert.deepStrictEqual(merged, [
    { name: 'Delivery-Time', value: '12:00 AM - 7:00 AM' },
    { name: 'HDS Ship Date', value: '2026/08/23' },
  ]);
});

test('previousTuple reads either label, so older orders still work', () => {
  const renamed = previousTuple(
    attrs({ 'Delivery-Date': '2026/08/10', 'HDS Ship Date': '2026/08/09' })
  );
  const legacy = previousTuple(
    attrs({ 'Delivery-Date': '2026/08/10', 'HDS Pack Date': '2026/08/09' })
  );

  assert.strictEqual(renamed.packGap, 1);
  assert.strictEqual(legacy.packGap, 1);
});

// --- renewal cutoff ----------------------------------------------------------
// For a renewal the cutoff IS the order date: Loop charges at the cutoff, so the
// order existing means the cycle closed. Charge Offset stays the schedule's rule.

test('a cutoff override wins over the schedule-derived cutoff', () => {
  const a = buildOrderAttributes({
    ...RESOLVED,
    cutoff_override: { cutoff_date: '2026-08-19', cutoff_day: 'Wednesday', charge_offset_days: 3 },
  });

  assert.strictEqual(a['HDS Cutoff Date'], '2026/08/19');
  assert.strictEqual(a['HDS Cutoff Day'], 'Wednesday');
  // Still the schedule's offset, not delivery-minus-order-date (which would be 5)
  // — that value is pushed to Loop to correct future charges.
  assert.strictEqual(a['Charge Offset'], '3 Days');
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

test('locationFor accepts Delivery-Location-Id when it is postcode-shaped', () => {
  // A real renewal carried Delivery-Location-Id "2170" and no HDS Postcode.
  const loc = locationFor({
    shipping_address: { city: 'Liverpool' },
    ...attrs({ 'Delivery-Location-Id': '2170', 'Delivery-Location': 'WOM' }),
  });
  assert.deepStrictEqual(loc, { postcode: '2170', suburb: 'Liverpool' });
});

test('the shipping address still wins over Delivery-Location-Id', () => {
  const loc = locationFor({
    shipping_address: { city: 'Prairiewood', zip: '2176' },
    ...attrs({ 'Delivery-Location-Id': '2170' }),
  });
  assert.strictEqual(loc.postcode, '2176');
});

test('isPostcodeShaped admits only four-digit values', () => {
  for (const good of ['2170', '2176', ' 3977 ']) {
    assert.ok(isPostcodeShaped(good), `${good} should be accepted`);
  }
  for (const bad of ['NSW Sydney Metro', '290881', '217', 'WOM', '', null, undefined]) {
    assert.ok(!isPostcodeShaped(bad), `${bad} should be rejected`);
  }
});

test('the shipping address is tried first — it is where the parcel goes', () => {
  // On a renewal the labelled keys are a copy of the FIRST cycle, so a customer
  // who has moved would otherwise be scheduled against the suburb they left.
  const loc = locationFor({
    shipping_address: { city: 'Geebung', zip: '4034' },
    ...attrs({ 'HDS Postcode': '2170', 'HDS Suburb': 'PRESTONS' }),
  });
  assert.deepStrictEqual(loc, { postcode: '4034', suburb: 'Geebung' });
});

test('a moved customer yields both addresses, current one first', () => {
  const candidates = locationCandidatesFor({
    shipping_address: { city: 'Geebung', zip: '4034' },
    ...attrs({ 'HDS Postcode': '2170', 'HDS Suburb': 'PRESTONS' }),
  });

  assert.strictEqual(candidates.length, 2);
  assert.strictEqual(candidates[0].postcode, '4034');
  assert.match(candidates[0].source, /shipping address/);
  // The labelled pair stays as a fallback: it holds HDS's canonical spelling,
  // which resolves when a free-text shipping city does not.
  assert.strictEqual(candidates[1].postcode, '2170');
});

test('matching addresses are not looked up twice', () => {
  const candidates = locationCandidatesFor({
    shipping_address: { city: 'Prestons', zip: '2170' },
    ...attrs({ 'HDS Postcode': '2170', 'HDS Suburb': 'PRESTONS' }),
  });
  assert.strictEqual(candidates.length, 1, 'case differs but the address is the same');
});

test('the labelled pair is used when there is no shipping address', () => {
  const candidates = locationCandidatesFor(
    attrs({ 'HDS Postcode': '2176', 'HDS Suburb': 'PRAIRIEWOOD' })
  );
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].suburb, 'PRAIRIEWOOD');
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

// --- recomputing over a wrong value ------------------------------------------
// The additive default protects what is on the order, which is exactly wrong when
// the thing on the order is the mistake being corrected.

const { fillHdsRecords } = require('../src/lib/renewal-rewrite');

const stubHds = (options) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    success: true,
    region: { id: 7, name: 'VIC Melbourne Metro' },
    suburb: { name: 'CARRUM', postcode: '3197' },
    delivery_options: options,
  }),
});

const FRIDAY_SCHEDULE = [
  {
    schedule_id: 154,
    delivery_day: 'Friday',
    delivery_window: 'AM,Business Hours',
    cutoff_info: 'Monday 11 PM',
    delivery_date: '2026-09-11',
    pack_date: '2026-09-09',
    production_date: '2026-09-08',
  },
];

const HAND_ENTERED = {
  id: 1,
  created_at: '2026-09-03T22:50:00+10:00',
  shipping_address: { city: 'Carrum', zip: '3197' },
  ...attrs({ 'Delivery-Date': '2026/09/11', 'Pick-Pack-Date': '2026/09/05' }),
};

test('overwrite replaces a pack date that was set by hand', async () => {
  const originalFetch = global.fetch;
  global.fetch = stubHds(FRIDAY_SCHEDULE);
  try {
    const out = await fillHdsRecords(HAND_ENTERED, { dryRun: true, overwrite: true });

    assert.equal(out.ok, true);
    // The schedule's own two-day gap, not the 2026/09/05 that was there.
    assert.equal(out.attributes['Pick-Pack-Date'], '2026/09/09');
    // The delivery date it was computed around is unchanged.
    assert.equal(out.attributes['Delivery-Date'], '2026/09/11');
  } finally {
    global.fetch = originalFetch;
  }
});

test('without overwrite the wrong pack date is left exactly as it was', async () => {
  const originalFetch = global.fetch;
  global.fetch = stubHds(FRIDAY_SCHEDULE);
  try {
    const out = await fillHdsRecords(HAND_ENTERED, { dryRun: true });

    assert.equal(out.ok, true);
    assert.ok(
      !('Pick-Pack-Date' in out.attributes),
      'the existing value is protected, which is the default for a reason'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

// --- the window NAME on the order, not just its clock range ------------------
// The order page showed "8:00 AM - 6:00 PM" and nothing said which window that
// was, while the checkout had offered it as "Daytime". Reading an order meant
// knowing the ranges by heart. The configured value may now carry the label too.

const LABELLED_WINDOWS = JSON.stringify({
  AM: { label: 'Morning', time: '12:00 AM - 7:00 AM' },
  'Business Hours': { label: 'Daytime', time: '8:00 AM - 6:00 PM' },
});

const withTimeFormat = (format, fn) => {
  const saved = process.env.DELIVERY_TIME_FORMAT;
  if (format === undefined) delete process.env.DELIVERY_TIME_FORMAT;
  else process.env.DELIVERY_TIME_FORMAT = format;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.DELIVERY_TIME_FORMAT;
    else process.env.DELIVERY_TIME_FORMAT = saved;
  }
};

test('Delivery-Time carries the window name alongside the range', () => {
  withWindowTimes(LABELLED_WINDOWS, () => {
    withTimeFormat(undefined, () => {
      assert.strictEqual(
        buildOrderAttributes(RESOLVED)['Delivery-Time'],
        'Morning 12:00 AM - 7:00 AM'
      );

      const daytime = buildOrderAttributes(RESOLVED, { preferredWindow: 'Business Hours' });
      assert.strictEqual(daytime['Delivery-Time'], 'Daytime 8:00 AM - 6:00 PM');
    });
  });
});

test('the plain string form still means the range alone', () => {
  // Live configuration uses it, so it must keep working untouched.
  withWindowTimes(WINDOW_TIMES, () => {
    assert.strictEqual(buildOrderAttributes(RESOLVED)['Delivery-Time'], '12:00 AM - 7:00 AM');
  });
});

test('the format is a template, so the old value is recoverable without a deploy', () => {
  // Delivery-Time is read downstream. If a consumer turns out to need the bare
  // range, this restores it through configuration rather than a code change.
  withWindowTimes(LABELLED_WINDOWS, () => {
    withTimeFormat('{time}', () => {
      assert.strictEqual(buildOrderAttributes(RESOLVED)['Delivery-Time'], '12:00 AM - 7:00 AM');
    });
    withTimeFormat('{label} ({time})', () => {
      assert.strictEqual(
        buildOrderAttributes(RESOLVED)['Delivery-Time'],
        'Morning (12:00 AM - 7:00 AM)'
      );
    });
  });
});

test('either spelling of the two keys is accepted', () => {
  // Hand-written JSON in an environment variable: rejecting a reasonable
  // spelling would surface as an unmapped window, which says nothing useful.
  withWindowTimes('{"AM":{"name":"Morning","range":"12:00 AM - 7:00 AM"}}', () => {
    assert.strictEqual(timeRangeForWindow('AM'), 'Morning 12:00 AM - 7:00 AM');
  });
});

test('a labelled window tolerates the same casing drift as before', () => {
  withWindowTimes(LABELLED_WINDOWS, () => {
    assert.strictEqual(timeRangeForWindow('am'), 'Morning 12:00 AM - 7:00 AM');
    assert.strictEqual(timeRangeForWindow('BUSINESS HOURS'), 'Daytime 8:00 AM - 6:00 PM');
  });
});

test('half a mapping is written rather than discarded', () => {
  withWindowTimes('{"AM":{"label":"Morning"}}', () => {
    assert.strictEqual(timeRangeForWindow('AM'), 'Morning');
  });
  withWindowTimes('{"AM":{"time":"12:00 AM - 7:00 AM"}}', () => {
    assert.strictEqual(timeRangeForWindow('AM'), '12:00 AM - 7:00 AM');
  });
});

test('an unusable mapping leaves Delivery-Time alone rather than blanking it', () => {
  // Writing an empty string would replace a correct customer-visible value with
  // nothing, which is worse than leaving it as it was.
  withWindowTimes('{"AM":{}}', () => {
    assert.strictEqual(timeRangeForWindow('AM'), null);
    assert.ok(!('Delivery-Time' in buildOrderAttributes(RESOLVED)));
  });
  withWindowTimes('{"AM":42}', () => {
    assert.strictEqual(timeRangeForWindow('AM'), null);
  });
});
