const test = require('node:test');
const assert = require('node:assert/strict');

const { tagsForOrder, missingTags, intervalPhrase, subscriptionTags } = require('../src/lib/order-tags');

const attrs = (pairs) => ({
  note_attributes: Object.entries(pairs).map(([name, value]) => ({ name, value })),
});

// Exactly what Loop returns for a live renewal.
const CONTEXT = {
  subscriptionId: 'shopify-69448171563',
  completedOrdersCount: 8,
  deliveryPolicy: { interval: 'WEEK', intervalCount: 1 },
  billingPolicy: { interval: 'WEEK', intervalCount: 1, anchorDay: null },
};

const ORDER = attrs({ 'Delivery-Date': '2026/09/07', 'HDS Ship Date': '2026/09/05' });

test('a renewal gets the full set the live orders used to carry', () => {
  assert.deepStrictEqual(tagsForOrder(ORDER, CONTEXT), [
    '07-09-2026',
    'Pick-Pack-Date-05-09-2026',
    'Subscription',
    'Subscription #69448171563',
    'Subscription Recurring Order',
    'Deliver every 1 WEEK',
    'Pay every 1 WEEK',
  ]);
});

test('the first order on a subscription is not tagged as a recurring one', () => {
  const tags = tagsForOrder(ORDER, { ...CONTEXT, completedOrdersCount: 0 });
  assert.ok(tags.includes('Subscription'));
  assert.ok(!tags.includes('Subscription Recurring Order'));
});

test('the interval is read from Loop, so fortnightly says fortnightly', () => {
  const tags = tagsForOrder(ORDER, {
    ...CONTEXT,
    deliveryPolicy: { interval: 'WEEK', intervalCount: 2 },
    billingPolicy: { interval: 'WEEK', intervalCount: 2 },
  });
  assert.ok(tags.includes('Deliver every 2 WEEK'));
  assert.ok(tags.includes('Pay every 2 WEEK'));
});

test('the date tags land even when Loop is unreachable', () => {
  // A subscription lookup failure must not cost the tags that come off the order.
  assert.deepStrictEqual(tagsForOrder(ORDER, null), ['07-09-2026', 'Pick-Pack-Date-05-09-2026']);
});

test('only the missing tags are returned, matched case-insensitively', () => {
  const partly = { ...ORDER, tags: '07-09-2026, subscription, Imported By Robust NetSuite Integrator' };
  const missing = missingTags(partly, CONTEXT);

  assert.ok(!missing.includes('07-09-2026'));
  assert.ok(!missing.some((t) => t.toLowerCase() === 'subscription'));
  assert.ok(missing.includes('Pick-Pack-Date-05-09-2026'));
});

test('a fully tagged order needs nothing', () => {
  const tagged = { ...ORDER, tags: tagsForOrder(ORDER, CONTEXT).join(', ') };
  assert.deepStrictEqual(missingTags(tagged, CONTEXT), []);
});

test('an order with no dates yields no date tags rather than broken ones', () => {
  const bare = { note_attributes: [], tags: '' };
  assert.deepStrictEqual(tagsForOrder(bare, null), []);
});

test('an incomplete Loop policy contributes no interval tag', () => {
  assert.strictEqual(intervalPhrase({ interval: 'WEEK' }), null);
  assert.strictEqual(intervalPhrase(null), null);

  const tags = subscriptionTags({ ...CONTEXT, deliveryPolicy: null, billingPolicy: null });
  assert.ok(!tags.some((t) => t.startsWith('Deliver every')));
  assert.ok(tags.includes('Subscription'));
});

// --- billing cycle -----------------------------------------------------------
// Correct only at creation, when completedOrdersCount still describes this order.

test('the billing cycle is the completed count plus one, at creation', () => {
  const order = attrs({ 'Delivery-Date': '2026/09/07', 'Pick-Pack-Date': '2026/09/05' });

  // A first order: 0 completed, so cycle 1 — matching the live order's tags.
  const first = tagsForOrder(order, { ...CONTEXT, completedOrdersCount: 0 }, { atCreation: true });
  assert.ok(first.includes('Billing cycle #1'));
  assert.ok(first.includes('Subscription First Order'));
  assert.ok(!first.includes('Subscription Recurring Order'));

  // Two behind it, so cycle 3 — matching the other live order.
  const third = tagsForOrder(order, { ...CONTEXT, completedOrdersCount: 2 }, { atCreation: true });
  assert.ok(third.includes('Billing cycle #3'));
  assert.ok(third.includes('Subscription Recurring Order'));
});

test('a backfill omits the billing cycle rather than stamping today count on it', () => {
  const order = attrs({ 'Delivery-Date': '2026/09/07' });
  const tags = tagsForOrder(order, CONTEXT); // no atCreation

  assert.ok(!tags.some((t) => t.startsWith('Billing cycle')));
  // The rest still applies — only the count-dependent tag is withheld.
  assert.ok(tags.includes('Subscription Recurring Order'));
});

test('an absent count yields neither a cycle nor a first/recurring tag', () => {
  const tags = subscriptionTags({ subscriptionId: 'shopify-1' }, { atCreation: true });
  assert.deepStrictEqual(tags, ['Subscription', 'Subscription #1']);
});
