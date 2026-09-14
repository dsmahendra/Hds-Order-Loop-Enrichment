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

const { getNoteAttribute, normalizeDate } = require('../shopify');
const { updateOrderAttributes } = require('../shopify');
const {
  needsRewrite,
  rewriteRenewalOrder,
  fillHdsRecords,
  pendingHdsFields,
  DEFAULT_DELIVERY_TIME,
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

// A pack date can be technically PRESENT and still wrong. Loop copies the
// subscription's entire attribute set verbatim onto every renewal, so an
// order can arrive with every HDS_FIELD non-empty — internally consistent
// with itself, but all of it frozen at the very first cycle. pendingHdsFields
// only ever sees "missing", never "present but no longer true", so an order
// like that used to reach planFor() looking complete and stay that way
// forever, until someone happened to notice the pack date made no sense.
// Cheap: reads the order's own attributes, no API call — the actual
// recompute, if this finds something, still goes through fillHdsRecords like
// any other fill.
function packDateStaleness(order) {
  const packRaw =
    getNoteAttribute(order, 'Pick-Pack-Date') ||
    getNoteAttribute(order, 'HDS Ship Date') ||
    getNoteAttribute(order, 'HDS Pack Date');
  if (!packRaw) return null;
  const packIso = normalizeDate(packRaw);

  const todayIso = new Date().toISOString().slice(0, 10);
  if (packIso <= todayIso) return `Pick-Pack-Date ${packIso} is on or before today`;

  const deliveryRaw = getNoteAttribute(order, 'Delivery-Date') || getNoteAttribute(order, 'HDS Delivery Date');
  if (deliveryRaw) {
    const deliveryIso = normalizeDate(deliveryRaw);
    if (packIso >= deliveryIso) {
      return `Pick-Pack-Date ${packIso} is not before the delivery date ${deliveryIso}`;
    }
  }

  // Two names for the same fact (see renewal-rewrite.js's fillHdsRecords) —
  // if they disagree, at least one of them is wrong.
  const pickRaw = getNoteAttribute(order, 'Pick-Pack-Date');
  const shipRaw = getNoteAttribute(order, 'HDS Ship Date');
  if (pickRaw && shipRaw && normalizeDate(pickRaw) !== normalizeDate(shipRaw)) {
    return `Pick-Pack-Date ${normalizeDate(pickRaw)} and HDS Ship Date ${normalizeDate(shipRaw)} disagree`;
  }

  return null;
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

  const staleness = packDateStaleness(order);
  if (staleness) {
    return { action: 'fill', reason: staleness, recompute: true };
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
    // planFor() itself asks for overwrite when it found a pack date that's
    // present but wrong (plan.recompute) — the caller didn't have to know to
    // ask for that; it falls out of what's actually broken.
    const out = await fillHdsRecords(order, { dryRun, overwrite: recompute || Boolean(plan.recompute) });
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

  // --- delivery time ---------------------------------------------------------
  // A rewrite or fill above already resolved Delivery-Time (see
  // buildOrderAttributes). An order whose dates were already complete never
  // goes through that path, so an order that still has no Delivery-Time needs
  // it added directly here — no HDS call needed, since the default is a fixed
  // clock range rather than anything derived from the schedule.
  if (plan.action === 'tags-only' && !getNoteAttribute(order, 'Delivery-Time')) {
    if (!dryRun) {
      await updateOrderAttributes(orderId, {
        attributes: { 'Delivery-Time': DEFAULT_DELIVERY_TIME },
        order,
      });
    }
    result.deliveryTimeAdded = DEFAULT_DELIVERY_TIME;
  }

  return { ...result, ok: true, dryRun };
}

module.exports = { applyHdsToOrder, planFor, rewriteEnabled, hasDeliveryDate, packDateStaleness };
