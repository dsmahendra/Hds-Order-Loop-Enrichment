// classifyOrder's four categories, matching exactly what admin asked to see
// in the per-order status report: done / missing-pack / missing-other / stale.

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyOrder } = require('../src/lib/order-status');

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
