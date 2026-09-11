// buildDigestEmail is pure and DB/SMTP-free on purpose — these test it
// directly, with no database or mail server involved.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SHOPIFY_STORE = 'workoutmeals.myshopify.com';

const { buildDigestEmail } = require('../src/jobs/alert-digest');

test('no outstanding rows means no email at all', () => {
  assert.equal(buildDigestEmail([]), null);
});

test('one outstanding row produces a subject naming the count and a body naming the order', () => {
  const email = buildDigestEmail([
    {
      order_id: 6805214560299,
      subscription_id: 65704558635,
      status: 'failed',
      attempts: 5,
      error_message: 'Mulgrave (290879) is not available for delivery',
      updated_at: new Date('2026-09-11T00:00:00Z'),
    },
  ]);

  assert.ok(email);
  assert.match(email.subject, /1 order/);
  assert.match(email.text, /6805214560299/);
  assert.match(email.text, /subscription 65704558635/);
  assert.match(email.text, /Mulgrave \(290879\) is not available for delivery/);
  assert.match(email.text, /2026-09-11/);
  // A clickable admin link, built from SHOPIFY_STORE.
  assert.match(email.text, /https:\/\/admin\.shopify\.com\/store\/workoutmeals\/orders\/6805214560299/);
});

test('an order with no resolved subscription is still listed, just without one', () => {
  const email = buildDigestEmail([
    {
      order_id: 111,
      subscription_id: null,
      status: 'failed',
      attempts: 2,
      error_message: 'no Delivery-Date',
      updated_at: new Date('2026-09-01T00:00:00Z'),
    },
  ]);

  assert.match(email.text, /order 111/);
  assert.ok(!email.text.includes('subscription'), 'no subscription id to name');
});

test('rows beyond the cap are summarised, not all listed', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    order_id: 1000 + i,
    subscription_id: null,
    status: 'failed',
    attempts: 1,
    error_message: 'stuck',
    updated_at: new Date('2026-09-01T00:00:00Z'),
  }));

  const email = buildDigestEmail(rows);

  assert.match(email.subject, /30 order/);
  // Default cap is 25 — the 30th row's id (1029) must not appear, but an
  // overflow note must.
  assert.ok(!email.text.includes('order 1029'), 'must not list every row past the cap');
  assert.match(email.text, /5 more not shown/);
});

test('a missing error message does not produce a blank or broken line', () => {
  const email = buildDigestEmail([
    {
      order_id: 222,
      subscription_id: null,
      status: 'failed',
      attempts: 1,
      error_message: null,
      updated_at: new Date('2026-09-01T00:00:00Z'),
    },
  ]);

  assert.match(email.text, /\(no error message recorded\)/);
});
