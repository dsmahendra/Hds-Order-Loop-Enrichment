// The tags an order should carry, now that Arigato and Zapiet no longer add them.
//
// Taken from the live orders before the cutover:
//
//   06-09-2026                              delivery date        <- derived here
//   Pick-Pack-Date-22-08-2026               pack date            <- derived here
//   Subscription                            it is a subscription <- derived here
//   Subscription Recurring Order            a renewal, not the first order
//   Subscription #71277740075               the Loop contract id
//   Deliver every 1 WEEK                    Loop deliveryPolicy
//   Pay every 1 WEEK                        Loop billingPolicy
//   Billing cycle #3                        completedOrdersCount + 1, at creation
//   Subscription First Order                completedOrdersCount === 0
//   VIC_Mon_Thu_Sat                         NOT derived — see below
//   Zapiet Delivery                         obsolete with Zapiet gone
//   Imported By Robust NetSuite Integrator  NetSuite adds this itself
//
// Billing cycle #N is correct only AT CREATION. Loop reports
// completedOrdersCount as it is now, and at the moment an order is created that
// count is the number of cycles BEFORE it — so this order is count + 1. Observed:
// a first order carries "Billing cycle #1" with a count of 0, and an order with
// two behind it carries "Billing cycle #3". Backfilling an old order would stamp
// today's count on it, so atCreation gates it: the webhook passes true, order:fix
// does not.
//
// VIC_Mon_Thu_Sat — the state is available, but Mon/Thu/Sat is not something HDS
// publishes. VIC Melbourne Metro offers Mon, Thu, Fri, Sat and Sun, so this is a
// narrower per-customer or per-plan pattern held somewhere we cannot see. Inventing
// it from the offered days would produce a different tag than fulfilment expects.

const { getNoteAttribute, normalizeDate } = require('../shopify');

// ISO 2026-09-06 -> "06-09-2026", the bare form already on the live orders.
function deliveryDateTag(deliveryDate) {
  if (!deliveryDate) return null;
  const [y, m, d] = String(deliveryDate).slice(0, 10).split('-');
  return y && m && d ? `${d}-${m}-${y}` : null;
}

function packDateTag(packDate) {
  if (!packDate) return null;
  const [y, m, d] = String(packDate).slice(0, 10).split('-');
  return y && m && d ? `Pick-Pack-Date-${d}-${m}-${y}` : null;
}

// The two date tags, read off whatever dates the order already carries.
function dateTags(order) {
  const delivery =
    getNoteAttribute(order, 'Delivery-Date') || getNoteAttribute(order, 'HDS Delivery Date');
  const pack =
    getNoteAttribute(order, 'Pick-Pack-Date') ||
    getNoteAttribute(order, 'HDS Ship Date') ||
    getNoteAttribute(order, 'HDS Pack Date');

  return [
    delivery ? deliveryDateTag(normalizeDate(delivery)) : null,
    pack ? packDateTag(normalizeDate(pack)) : null,
  ].filter(Boolean);
}

// "WEEK" + 1 -> "1 WEEK"; "WEEK" + 2 -> "2 WEEK", matching the observed casing.
function intervalPhrase(policy) {
  const interval = policy?.interval;
  const count = policy?.intervalCount;
  if (!interval || !Number.isFinite(Number(count))) return null;
  return `${Number(count)} ${String(interval).toUpperCase()}`;
}

// What the Loop subscription tells us about the order.
//
// context comes from subscriptionContextForOrder(); passing null simply yields no
// subscription tags rather than failing, so an order Loop has not ingested yet
// still gets its date tags.
function subscriptionTags(context, { atCreation = false } = {}) {
  if (!context) return [];

  const tags = ['Subscription'];

  const id = String(context.subscriptionId || '').replace(/^shopify-/, '');
  if (id) tags.push(`Subscription #${id}`);

  // completedOrdersCount > 0 means at least one order has already shipped on this
  // subscription, so this one is a renewal rather than the first purchase.
  const completed = Number(context.completedOrdersCount);
  if (Number.isFinite(completed)) {
    tags.push(completed > 0 ? 'Subscription Recurring Order' : 'Subscription First Order');
    // Only meaningful while the count still describes THIS order — see the note above.
    if (atCreation) tags.push(`Billing cycle #${completed + 1}`);
  }

  const delivery = intervalPhrase(context.deliveryPolicy);
  if (delivery) tags.push(`Deliver every ${delivery}`);

  const billing = intervalPhrase(context.billingPolicy);
  if (billing) tags.push(`Pay every ${billing}`);

  return tags;
}

// Everything the order should have, dates plus subscription.
function tagsForOrder(order, context = null, opts = {}) {
  return [...dateTags(order), ...subscriptionTags(context, opts)];
}

// Only the ones it does not already have. Compared case-insensitively, since
// Shopify keeps the case a tag was first created with.
function missingTags(order, context = null, opts = {}) {
  const existing = String(order?.tags || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const wanted = tagsForOrder(order, context, opts);
  // Deduplicate within the wanted set too, in case two sources produce the same tag.
  const seen = new Set();
  return wanted.filter((t) => {
    const key = t.toLowerCase();
    if (existing.includes(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function taggingEnabled() {
  return String(process.env.TAG_ORDER_DATES || 'true').toLowerCase() !== 'false';
}

module.exports = {
  deliveryDateTag,
  packDateTag,
  dateTags,
  subscriptionTags,
  intervalPhrase,
  tagsForOrder,
  missingTags,
  taggingEnabled,
};
