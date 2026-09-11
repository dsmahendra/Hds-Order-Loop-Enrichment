// buildDigestEmail is pure and DB/Shopify/SMTP-free on purpose — these test it
// directly, with no database, live check, or mail server involved.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SHOPIFY_STORE = 'workoutmeals.myshopify.com';

const { buildDigestEmail } = require('../src/jobs/alert-digest');

test('no stuck orders means no email at all', () => {
  assert.equal(buildDigestEmail([]), null);
});

test('one stuck order produces a subject naming the count and a body naming the order', () => {
  const email = buildDigestEmail([
    {
      orderId: 6805214560299,
      orderName: 'WM142344',
      subscriptionId: 65704558635,
      detail: 'anchored to Tuesday for Mulgrave 3170, but HDS now only offers Saturday, Sunday, Monday, Thursday, Friday there',
    },
  ]);

  assert.ok(email);
  assert.match(email.subject, /1 order/);
  assert.match(email.text, /WM142344/);
  assert.match(email.text, /subscription 65704558635/);
  assert.match(email.text, /HDS now only offers Saturday/);
  // A clickable admin link, built from SHOPIFY_STORE.
  assert.match(email.text, /https:\/\/admin\.shopify\.com\/store\/workoutmeals\/orders\/6805214560299/);
});

test('an order with no resolved subscription is still listed, just without one', () => {
  const email = buildDigestEmail([
    {
      orderId: 111,
      orderName: 'WM100111',
      subscriptionId: null,
      detail: 'anchored to Monday, but HDS offers nothing there',
    },
  ]);

  assert.match(email.text, /order WM100111/);
  assert.ok(!email.text.includes('subscription'), 'no subscription id to name');
});

test('an order with no resolved name falls back to its id', () => {
  const email = buildDigestEmail([
    { orderId: 222, orderName: null, subscriptionId: null, detail: 'stuck' },
  ]);
  assert.match(email.text, /order 222/);
});

test('orders beyond the cap are summarised, not all listed', () => {
  const stuckOrders = Array.from({ length: 30 }, (_, i) => ({
    orderId: 1000 + i,
    orderName: `WM${1000 + i}`,
    subscriptionId: null,
    detail: 'stuck',
  }));

  const email = buildDigestEmail(stuckOrders);

  assert.match(email.subject, /30 order/);
  // Default cap is 25 — the 30th order's name must not appear, but an
  // overflow note must.
  assert.ok(!email.text.includes('WM1029'), 'must not list every row past the cap');
  assert.match(email.text, /5 more not shown/);
});
