// planFor's staleness check: an order can have every HDS_FIELD technically
// present (Loop copies the subscription's whole attribute set verbatim onto
// every renewal) and still be wrong — all of it frozen at the very first
// cycle. pendingHdsFields only ever sees "missing", never "present but no
// longer true", so this is the check that catches the rest.

const test = require('node:test');
const assert = require('node:assert/strict');

const { planFor, packDateStaleness } = require('../src/lib/apply-hds');

function daysFromNow(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10).replace(/-/g, '/');
}

const attrs = (pairs) => ({
  note_attributes: Object.entries(pairs).map(([name, value]) => ({ name, value })),
});

// Every HDS_FIELD present and mutually consistent — a genuinely complete,
// trustworthy record. Individual tests override just the field(s) under test.
function completeOrder(overrides = {}) {
  const delivery = daysFromNow(10);
  const pack = daysFromNow(9);
  return {
    id: 1,
    created_at: `${daysFromNow(-3).replace(/\//g, '-')}T09:00:00+10:00`,
    ...attrs({
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
    }),
  };
}

test('a fully complete, self-consistent order needs nothing', () => {
  const plan = planFor(completeOrder());
  assert.equal(plan.action, 'tags-only');
  assert.equal(packDateStaleness(completeOrder()), null);
});

test('a pack date on or before today is caught even though nothing is "missing"', () => {
  const order = completeOrder({ 'Pick-Pack-Date': daysFromNow(0), 'HDS Ship Date': daysFromNow(0) });
  const plan = planFor(order);
  assert.equal(plan.action, 'fill');
  assert.equal(plan.recompute, true);
  assert.match(plan.reason, /on or before today/);
});

test('a pack date in the past is caught the same way', () => {
  const order = completeOrder({ 'Pick-Pack-Date': daysFromNow(-5), 'HDS Ship Date': daysFromNow(-5) });
  const plan = planFor(order);
  assert.equal(plan.action, 'fill');
  assert.equal(plan.recompute, true);
});

test('a pack date on or after the delivery date is caught', () => {
  // Delivery-Date is daysFromNow(10) in the fixture; a pack date the same day
  // or later can never be right regardless of whether it's still in the future.
  const order = completeOrder({ 'Pick-Pack-Date': daysFromNow(10), 'HDS Ship Date': daysFromNow(10) });
  const plan = planFor(order);
  assert.equal(plan.action, 'fill');
  assert.equal(plan.recompute, true);
  assert.match(plan.reason, /not before the delivery date/);
});

test('Pick-Pack-Date and HDS Ship Date disagreeing is caught even when both are future dates', () => {
  const order = completeOrder({ 'Pick-Pack-Date': daysFromNow(9), 'HDS Ship Date': daysFromNow(8) });
  const plan = planFor(order);
  assert.equal(plan.action, 'fill');
  assert.equal(plan.recompute, true);
  assert.match(plan.reason, /disagree/);
});

test('a genuinely missing field is still reported as missing, not as staleness', () => {
  const order = completeOrder();
  order.note_attributes = order.note_attributes.filter((a) => a.name !== 'HDS Region');
  const plan = planFor(order);
  assert.equal(plan.action, 'fill');
  assert.ok(!plan.recompute, 'a missing field is additive, not a forced recompute');
  assert.match(plan.reason, /HDS field\(s\) missing/);
});

test('no pack date at all is not staleness — pendingHdsFields already covers it', () => {
  assert.equal(packDateStaleness({ note_attributes: [] }), null);
});
