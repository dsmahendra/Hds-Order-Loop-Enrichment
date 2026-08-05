const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveRenewalDelivery,
  buildHdsAttributes,
  toChargeDate,
  addDays,
} = require('../src/lib/renewal-date');
const { parseUpcoming } = require('../src/routes/loop-webhooks');

function stubOptions(options, extra = {}) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      serviceable: true,
      region: { name: 'Sydney' },
      suburb: { name: 'Bondi', postcode: '2026' },
      delivery_options: options,
      ...extra,
    }),
  });
}

test('toChargeDate prefers the epoch and handles seconds or milliseconds', () => {
  // 2026-08-14T00:00:00Z
  assert.equal(toChargeDate({ epoch: 1786665600 }), '2026-08-14');
  assert.equal(toChargeDate({ epoch: 1786665600000 }), '2026-08-14');
  assert.equal(toChargeDate({ iso: '2026-08-14T09:30:00Z' }), '2026-08-14');
  // Epoch wins when both are present.
  assert.equal(toChargeDate({ epoch: 1786665600, iso: '2030-01-01' }), '2026-08-14');
  assert.equal(toChargeDate({}), null);
});

test('addDays rolls across month boundaries in UTC', () => {
  assert.equal(addDays('2026-08-30', 3), '2026-09-02');
  assert.equal(addDays('2026-08-30', 0), '2026-08-30');
});

test('picks the earliest delivery option on or after the charge date', async () => {
  const originalFetch = global.fetch;
  global.fetch = stubOptions([
    { delivery_date: '2026-08-20', pack_date: '2026-08-18', production_date: '2026-08-17' },
    { delivery_date: '2026-08-13', pack_date: '2026-08-11', production_date: '2026-08-10' },
    { delivery_date: '2026-08-15', pack_date: '2026-08-13', production_date: '2026-08-12' },
  ]);

  try {
    const result = await resolveRenewalDelivery({
      postcode: '2026',
      suburb: 'Bondi',
      chargeDateEpoch: 1786665600, // 2026-08-14
    });

    assert.equal(result.ok, true);
    // 08-13 is before the charge date; 08-15 is the earliest valid one.
    assert.equal(result.data.delivery_date, '2026-08-15');
    assert.equal(result.data.charge_date, '2026-08-14');
    assert.equal(result.data.pack_date, '2026-08-13');
    assert.equal(result.data.region, 'Sydney');
    assert.equal(result.data.postcode, '2026');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fails cleanly when no option falls on or after the charge date', async () => {
  const originalFetch = global.fetch;
  global.fetch = stubOptions([{ delivery_date: '2026-08-01', pack_date: '2026-07-30' }]);

  try {
    const result = await resolveRenewalDelivery({
      postcode: '2026',
      chargeDateIso: '2026-08-14T00:00:00Z',
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no HDS delivery option/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('reports a missing charge date rather than guessing one', async () => {
  const result = await resolveRenewalDelivery({ postcode: '2026' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing next charge date');
});

test('propagates an unserviceable suburb from HDS', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ serviceable: false, error: 'suburb not covered' }),
  });

  try {
    const result = await resolveRenewalDelivery({
      postcode: '9999',
      chargeDateEpoch: 1786665600,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'suburb not covered');
  } finally {
    global.fetch = originalFetch;
  }
});

test('parseUpcoming reads a nested subscription payload', () => {
  const parsed = parseUpcoming({
    subscription: {
      id: 8811,
      nextBillingDateEpoch: 1786665600,
      shippingAddress: { zip: '2026', city: 'Bondi' },
      customAttributes: [{ key: 'hds_delivery_window', value: 'Business Hours' }],
    },
  });

  assert.equal(parsed.subscriptionId, 8811);
  assert.equal(parsed.chargeDateEpoch, 1786665600);
  assert.equal(parsed.postcode, '2026');
  assert.equal(parsed.suburb, 'Bondi');
  assert.equal(parsed.deliveryWindow, 'Business Hours');
});

// Mirrors the live HDS response for postcode 2170 / CASULA.
const REAL_OPTION = {
  schedule_id: 10,
  delivery_day: 'Sunday',
  delivery_window: 'AM,Business Hours',
  cutoff_info: 'Thursday 11 PM',
  delivery_date: '2026-08-09',
  pack_date: '2026-08-08',
  pack_day: 'Saturday',
  production_date: '2026-08-07',
  formatted_date: 'Sunday 9 August 2026',
};

test('builds the full hds_* attribute set the checkout extension writes', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      suburb: { name: 'CASULA', postcode: '2170', state: 'NSW' },
      region: { id: 1, name: 'NSW Sydney Metro' },
      delivery_options: [REAL_OPTION],
    }),
  });

  try {
    const result = await resolveRenewalDelivery({
      postcode: '2170',
      suburb: 'CASULA',
      chargeDateIso: '2026-08-05T00:00:00Z',
    });
    assert.equal(result.ok, true);

    const attrs = buildHdsAttributes(result.data, 'Business Hours');
    assert.deepEqual(attrs, {
      hds_delivery_date: '2026-08-09',
      hds_delivery_formatted: 'Sunday 9 August 2026',
      hds_delivery_day: 'Sunday',
      hds_delivery_window: 'Business Hours',
      hds_schedule_id: 10,
      hds_pack_date: '2026-08-08',
      hds_production_date: '2026-08-07',
      hds_region: 'NSW Sydney Metro',
      hds_suburb: 'CASULA',
      hds_postcode: '2170',
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('falls back to the first offered window when the customer has no saved one', () => {
  // The API lists every window the schedule offers; an order carries just one.
  const attrs = buildHdsAttributes({ ...REAL_OPTION, delivery_window: 'AM,Business Hours' }, null);
  assert.equal(attrs.hds_delivery_window, 'AM');
});

test('parseUpcoming reads a flat snake_case payload', () => {
  const parsed = parseUpcoming({
    subscription_id: 4242,
    next_billing_date: '2026-08-14T00:00:00Z',
    shipping_address: { postcode: '3000', suburb: 'Brunswick' },
  });

  assert.equal(parsed.subscriptionId, 4242);
  assert.equal(parsed.chargeDateIso, '2026-08-14T00:00:00Z');
  assert.equal(parsed.postcode, '3000');
  assert.equal(parsed.suburb, 'Brunswick');
});

test('parseUpcoming prefers an existing Delivery-Location-Id attribute over the address', () => {
  const parsed = parseUpcoming({
    subscriptionId: 7,
    shippingAddress: { zip: '9999' },
    customAttributes: [{ key: 'Delivery-Location-Id', value: '2026' }],
  });

  assert.equal(parsed.postcode, '2026');
});

test('parseUpcoming returns a null subscription id for an unrecognised body', () => {
  assert.equal(parseUpcoming({ foo: 'bar' }).subscriptionId, null);
  assert.equal(parseUpcoming(null).subscriptionId, null);
});
