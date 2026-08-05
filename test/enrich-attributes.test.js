const test = require('node:test');
const assert = require('node:assert/strict');
const { enrichFromAttributes } = require('../src/lib/enrich');
const { getHdsAttributes } = require('../src/shopify');

// The exact attribute set the checkout extension writes, as seen on a real
// Shopify order under "Additional details".
const ORDER_ATTRS = {
  hds_delivery_date: '2026-07-24',
  hds_delivery_formatted: 'Friday 24 July 2026',
  hds_delivery_day: 'Friday',
  hds_delivery_window: 'Business Hours',
  hds_schedule_id: '8',
  hds_pack_date: '2026-07-23',
  hds_production_date: '2026-07-22',
  hds_region: 'NSW Sydney Metro',
  hds_suburb: 'CASULA',
  hds_postcode: '2170',
};

test('enriches straight from a complete attribute set, no API call', () => {
  const result = enrichFromAttributes(ORDER_ATTRS);

  assert.equal(result.ok, true);
  assert.equal(result.data.hds_delivery_date, '2026-07-24');
  assert.equal(result.data.hds_pack_date, '2026-07-23');
  assert.equal(result.data.hds_production_date, '2026-07-22');
  assert.equal(result.data.hds_region, 'NSW Sydney Metro');
  assert.equal(result.data.hds_suburb, 'CASULA');
  assert.equal(result.data.hds_postcode, '2170');

  // Non-core fields are kept rather than dropped.
  assert.deepEqual(result.data.hds_additional_parameters, {
    hds_delivery_formatted: 'Friday 24 July 2026',
    hds_delivery_day: 'Friday',
    hds_delivery_window: 'Business Hours',
    hds_schedule_id: '8',
  });
  assert.equal(result.data.hds_response.source, 'order_attributes');
});

test('falls back when a core attribute is missing', () => {
  const { hds_pack_date, ...partial } = ORDER_ATTRS;
  const result = enrichFromAttributes(partial);

  assert.equal(result.ok, false);
  assert.match(result.reason, /missing hds_pack_date/);
});

test('falls back when the order carries no hds_* attributes at all', () => {
  assert.equal(enrichFromAttributes(null).ok, false);
  assert.equal(enrichFromAttributes({}).ok, false);
});

test('an unknown future attribute is carried through, not dropped', () => {
  const result = enrichFromAttributes({ ...ORDER_ATTRS, hds_cutoff_info: 'Thursday 11 PM' });

  assert.equal(result.ok, true);
  assert.equal(result.data.hds_additional_parameters.hds_cutoff_info, 'Thursday 11 PM');
});

test('getHdsAttributes picks only hds_* attributes off the order payload', () => {
  const order = {
    note_attributes: [
      { name: 'hds_delivery_date', value: '2026-07-24' },
      { name: 'hds_postcode', value: '2170' },
      { name: 'Some-Other-App-Field', value: 'ignore me' },
      { name: 'hds_empty', value: '' },
    ],
  };

  assert.deepEqual(getHdsAttributes(order), {
    hds_delivery_date: '2026-07-24',
    hds_postcode: '2170',
  });
});

test('getHdsAttributes returns null when the order has none', () => {
  assert.equal(getHdsAttributes({ note_attributes: [] }), null);
  assert.equal(getHdsAttributes({}), null);
});
