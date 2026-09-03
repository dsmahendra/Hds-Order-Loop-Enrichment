// One decision, used by the webhook's callers, order:fix and the backfill sweep.
//
// Extracted because the same precedence was starting to be written out in each
// script, and a tag implementation had already drifted that way once. There is one
// answer to "what should happen to this order" and it lives here.
//
// The order of preference:
//
//   1. no delivery date at all      compute one and everything around it. Allowed
//                                   even with rewriting stood down: an order with
//                                   no date has nothing to protect, and refusing
//                                   left it with no pack date either.
//   2. expired delivery date        rewrite it, or hold the order if rewriting is
//                                   stood down. Never derive a pack date from a
//                                   date that has already passed.
//   3. HDS fields missing           add them around the existing date. Additive.
//   4. tags missing                 add them. Needs no HDS call.

const { getNoteAttribute } = require('../shopify');
const { updateOrderAttributes } = require('../shopify');
const {
  needsRewrite,
  rewriteRenewalOrder,
  fillHdsRecords,
  pendingHdsFields,
} = require('./renewal-rewrite');
const { missingTags, taggingEnabled } = require('./order-tags');
const { subscriptionContextForOrder } = require('../loop');

function rewriteEnabled() {
  return String(process.env.REWRITE_RENEWAL_DATES || 'true').toLowerCase() !== 'false';
}

function hasDeliveryDate(order) {
  return Boolean(
    getNoteAttribute(order, 'Delivery-Date') || getNoteAttribute(order, 'HDS Delivery Date')
  );
}

// What would happen, without doing it. Cheap — no API calls.
function planFor(order) {
  const state = needsRewrite(order);
  const noDate = !hasDeliveryDate(order);

  if (state.stale && (rewriteEnabled() || noDate)) {
    return {
      action: 'rewrite',
      reason: noDate
        ? 'no delivery date — one will be computed'
        : `delivery date ${state.current} is expired`,
    };
  }
  if (state.stale) {
    return {
      action: 'hold',
      reason: `delivery date ${state.current} is expired and REWRITE_RENEWAL_DATES=false`,
    };
  }

  const pending = pendingHdsFields(order);
  if (pending.length) {
    return { action: 'fill', reason: `${pending.length} HDS field(s) missing`, pending };
  }
  return { action: 'tags-only', reason: 'dates are complete' };
}

// Apply it. Returns what was done so callers can report consistently.
// recompute: derive the HDS values again and REPLACE what is on the order, for
// correcting a set that was written wrongly. Only meaningful where the order has a
// delivery date to compute around; without one the rewrite path handles it anyway.
async function applyHdsToOrder(
  order,
  { dryRun = false, atCreation = false, force = false, recompute = false } = {}
) {
  const orderId = order?.id;
  if (!orderId) return { ok: false, action: 'none', reason: 'order payload has no id' };

  let plan = planFor(order);
  if (force && hasDeliveryDate(order) && rewriteEnabled()) {
    plan = { action: 'rewrite', reason: 'forced' };
  } else if (recompute && hasDeliveryDate(order)) {
    // Keep the delivery date, replace everything derived from it.
    plan = { action: 'fill', reason: 'recomputing the HDS values around the existing delivery date' };
  }

  const result = { action: plan.action, reason: plan.reason, wrote: null, tagsAdded: [] };

  if (plan.action === 'hold') return { ...result, ok: false };

  // --- dates and fields ----------------------------------------------------
  if (plan.action === 'rewrite') {
    const out = await rewriteRenewalOrder(order, { dryRun });
    if (!out.ok) return { ...result, ok: false, reason: out.reason };
    result.wrote = out.attributes;
    result.resolved = out.resolved;
    result.tagsAdded = out.tags || [];
  } else if (plan.action === 'fill') {
    const out = await fillHdsRecords(order, { dryRun, overwrite: recompute });
    if (!out.ok) return { ...result, ok: false, reason: out.reason };
    result.wrote = out.attributes;
    result.resolved = out.resolved;
    result.tagsAdded = out.tags || [];
  }

  // --- tags ----------------------------------------------------------------
  // Only when the write above did not already tag. Its own tags cover the dates
  // it just set; this covers an order that needed no date work at all.
  if (taggingEnabled() && plan.action === 'tags-only') {
    let context = null;
    try {
      context = await subscriptionContextForOrder(orderId);
    } catch {
      // Not a subscription, or Loop has not ingested it. Date tags still apply.
    }

    const missing = missingTags(order, context, { atCreation });
    if (missing.length) {
      if (!dryRun) await updateOrderAttributes(orderId, { addTags: missing, order });
      result.tagsAdded = missing;
    }
  }

  return { ...result, ok: true, dryRun };
}

module.exports = { applyHdsToOrder, planFor, rewriteEnabled, hasDeliveryDate };
