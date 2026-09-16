// classifyOrder's four categories, matching exactly what admin asked to see
// in the per-order status report: done / missing-pack / missing-other / stale.

process.env.SHOPIFY_STORE = 'test-shop.myshopify.com';
process.env.HDS_API_BASE = 'https://hds.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyOrder, classifyOrderWithReason } = require('../src/lib/order-status');
const { clearDeliveryOptionsCache } = require('../src/lib/renewal-date');

function daysFromNow(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10).replace(/-/g, '/');
}

const attrs = (pairs) => ({
  note_attributes: Object.entries(pairs).map(([name, value]) => ({ name, value })),
});

function completeOrder(overrides = {}) {
  const delivery = daysFromNow(10);
  const pack = daysFromNow(9);
  return attrs({
    'Delivery-Date': delivery,
    'Pick-Pack-Date': pack,
    'HDS Delivery Date': delivery,
    'HDS Delivery Formatted': 'whatever',
    'HDS Delivery Day': 'Monday',
    'HDS Delivery Window': 'AM',
    'HDS Schedule ID': '141',
    'HDS Cutoff Day': 'Friday',
    'HDS Cutoff Date': daysFromNow(6),
    'Charge Offset': '3 Days',
    'HDS Ship Date': pack,
    'HDS Production Date': daysFromNow(8),
    'HDS Region': 'NSW Sydney Metro',
    'HDS Suburb': 'PRESTONS',
    'HDS Postcode': '2170',
    ...overrides,
  });
}

test('a fully complete, self-consistent order is "done"', () => {
  assert.equal(classifyOrder(completeOrder()).status, 'done');
});

test('no pack date at all, but everything else present, is "missing-pack"', () => {
  const order = completeOrder();
  order.note_attributes = order.note_attributes.filter((a) => !['Pick-Pack-Date', 'HDS Ship Date'].includes(a.name));
  assert.equal(classifyOrder(order).status, 'missing-pack');
});

test('a pack date present but other HDS fields missing is "missing-other"', () => {
  const order = completeOrder();
  order.note_attributes = order.note_attributes.filter((a) => a.name !== 'HDS Region');
  const result = classifyOrder(order);
  assert.equal(result.status, 'missing-other');
  assert.match(result.label, /HDS Region/);
});

test('neither the pack date nor the rest of the set is "missing-both"', () => {
  assert.equal(classifyOrder({ note_attributes: [] }).status, 'missing-both');
});

test('a pack date on or before today, with everything else present, is "stale"', () => {
  const order = completeOrder({ 'Pick-Pack-Date': daysFromNow(0), 'HDS Ship Date': daysFromNow(0) });
  const result = classifyOrder(order);
  assert.equal(result.status, 'stale');
  assert.match(result.label, /on or before today/);
});

test('a pack date not before the delivery date is "stale"', () => {
  const order = completeOrder({ 'Pick-Pack-Date': daysFromNow(10), 'HDS Ship Date': daysFromNow(10) });
  assert.equal(classifyOrder(order).status, 'stale');
});

test('Pick-Pack-Date and HDS Ship Date disagreeing is "stale"', () => {
  const order = completeOrder({ 'Pick-Pack-Date': daysFromNow(9), 'HDS Ship Date': daysFromNow(8) });
  assert.equal(classifyOrder(order).status, 'stale');
});

// classifyOrderWithReason adds the ACTUAL live reason for anything not
// 'done' — a real dry-run through applyHdsToOrder, not just the category.

test('a "done" order never makes an HDS call — no reason attached, no fetch needed', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('must not be called for a done order');
  };
  try {
    const result = await classifyOrderWithReason(completeOrder());
    assert.equal(result.status, 'done');
    assert.equal(result.reason, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a stale pack date gets the live "would resolve to" reason attached', async () => {
  // Find a future delivery date and its weekday, then mock HDS to offer that weekday
  const deliveryDate = daysFromNow(10);
  const { weekdayOf } = require('../src/lib/renewal-rewrite');
  const deliveryWeekday = weekdayOf(deliveryDate.replace(/\//g, '-'));

  const staleOrder = {
    id: 42,
    created_at: `${daysFromNow(-3).replace(/\//g, '-')}T09:00:00+10:00`,
    shipping_address: { zip: '2170', city: 'Prestons' },
    ...completeOrder({ 'Pick-Pack-Date': daysFromNow(0), 'HDS Ship Date': daysFromNow(0), 'Delivery-Date': deliveryDate, 'HDS Delivery Date': deliveryDate }),
  };

  const originalFetch = global.fetch;
  clearDeliveryOptionsCache();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      region: { name: 'NSW Sydney Metro' },
      suburb: { name: 'Prestons', postcode: '2170' },
      delivery_options: [
        {
          schedule_id: 141,
          delivery_day: deliveryWeekday, // matches the calculated delivery date weekday
          cutoff_info: 'Friday 11 PM',
          delivery_date: deliveryDate,
          pack_date: daysFromNow(9),
          production_date: daysFromNow(8),
        },
      ],
    }),
  });
  try {
    const result = await classifyOrderWithReason(staleOrder);
    assert.equal(result.status, 'stale');
    assert.match(result.reason, /would resolve to Pick-Pack-Date/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('an order HDS cannot resolve at all gets that failure as its reason', async () => {
  const order = {
    id: 43,
    created_at: `${daysFromNow(-3).replace(/\//g, '-')}T09:00:00+10:00`,
    shipping_address: { zip: '2170', city: 'Prestons' },
    ...completeOrder(),
  };
  order.note_attributes = order.note_attributes.filter((a) => a.name !== 'HDS Region');

  const originalFetch = global.fetch;
  clearDeliveryOptionsCache();
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: false, error: 'Prestons (2170) is not available for delivery' }),
  });
  try {
    const result = await classifyOrderWithReason(order);
    assert.equal(result.status, 'missing-other');
    assert.match(result.reason, /not available for delivery/);
  } finally {
    global.fetch = originalFetch;
  }
});
