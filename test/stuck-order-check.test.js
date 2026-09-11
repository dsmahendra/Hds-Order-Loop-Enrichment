// checkOrder is the shared verdict both stuck-schedules.js and the alert
// digest rely on, so it gets its own direct coverage rather than only being
// exercised indirectly through either of them.

process.env.SHOPIFY_STORE = 'test-shop.myshopify.com';
process.env.SHOPIFY_ADMIN_TOKEN = 'shpat_testtoken';
process.env.HDS_API_BASE = 'https://hds.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkOrder } = require('../src/lib/stuck-order-check');
const { clearDeliveryOptionsCache } = require('../src/lib/renewal-date');

test.beforeEach(() => clearDeliveryOptionsCache());

const attrs = (pairs) => Object.entries(pairs).map(([name, value]) => ({ name, value }));

// Routes a stubbed fetch by host: Shopify's admin API vs the HDS public API.
function stubFetch({ order, hdsOptions, hdsOk = true }) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/admin/api/')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ order }),
      };
    }
    // HDS
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: hdsOk,
        serviceable: hdsOk,
        region: { name: 'NSW Sydney Metro' },
        suburb: { name: 'Prestons', postcode: '2170' },
        delivery_options: hdsOptions || [],
      }),
    };
  };
  return () => {
    global.fetch = original;
  };
}

test('an order that already has a pack date is "fixed", no HDS call needed to say so', async () => {
  const order = {
    id: 1,
    name: 'WM1',
    created_at: '2026-09-01T00:00:00+10:00',
    shipping_address: { zip: '2170', city: 'Prestons' },
    note_attributes: attrs({ 'Delivery-Date': '2026/09/14', 'Pick-Pack-Date': '2026/09/13' }),
  };
  const restore = stubFetch({ order });
  try {
    const result = await checkOrder(1);
    assert.equal(result.verdict, 'fixed');
  } finally {
    restore();
  }
});

test('an order with no usable address is "skip"', async () => {
  const order = {
    id: 2,
    name: 'WM2',
    created_at: '2026-09-01T00:00:00+10:00',
    shipping_address: null,
    note_attributes: attrs({ 'Delivery-Date': '2026/09/14' }),
  };
  const restore = stubFetch({ order });
  try {
    const result = await checkOrder(2);
    assert.equal(result.verdict, 'skip');
    assert.match(result.detail, /no usable postcode\/suburb/);
  } finally {
    restore();
  }
});

test('HDS still offering the order\'s own weekday is "other", not "stuck"', async () => {
  const order = {
    id: 3,
    name: 'WM3',
    created_at: '2026-09-01T00:00:00+10:00',
    shipping_address: { zip: '2170', city: 'Prestons' },
    note_attributes: attrs({ 'Delivery-Date': '2026/09/14' }), // a Monday
  };
  const restore = stubFetch({ order, hdsOptions: [{ delivery_day: 'Monday' }, { delivery_day: 'Friday' }] });
  try {
    const result = await checkOrder(3);
    assert.equal(result.verdict, 'other');
    assert.match(result.detail, /DOES offer Monday now/);
  } finally {
    restore();
  }
});

test('HDS never offering the order\'s own weekday is "stuck"', async () => {
  const order = {
    id: 4,
    name: 'WM4',
    created_at: '2026-09-01T00:00:00+10:00',
    shipping_address: { zip: '2170', city: 'Prestons' },
    note_attributes: attrs({ 'Delivery-Date': '2026/09/14' }), // a Monday
  };
  const restore = stubFetch({ order, hdsOptions: [{ delivery_day: 'Friday' }, { delivery_day: 'Saturday' }] });
  try {
    const result = await checkOrder(4);
    assert.equal(result.verdict, 'stuck');
    assert.match(result.detail, /anchored to Monday/);
    assert.match(result.detail, /only offers Friday, Saturday there/);
  } finally {
    restore();
  }
});

test('an order Shopify has no record of is "not-found"', async () => {
  const restore = stubFetch({ order: null });
  try {
    const result = await checkOrder(5);
    assert.equal(result.verdict, 'not-found');
  } finally {
    restore();
  }
});
