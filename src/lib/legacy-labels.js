// Renaming note-attribute labels across ALL orders, not just renewals.
//
// "HDS Pack Date" became "HDS Ship Date". Renewals get the new label for free,
// because the date rewrite replaces that whole set anyway — but a first-time
// checkout order is never rewritten (its dates are correct), so the rename has to
// happen on its own.
//
// The VALUE is carried across untouched. This is a rename, not a recalculation:
// touching the date on a checkout order would change what the customer chose.

const { getNoteAttribute } = require('../shopify');

// old label -> new label. Add future renames here; everything else follows.
const LEGACY_LABEL_MAP = {
  'HDS Pack Date': 'HDS Ship Date',
};

function isEnabled() {
  return String(process.env.RENAME_LEGACY_LABELS || 'true').toLowerCase() !== 'false';
}

// What would need writing to bring this order's labels up to date?
// Returns null when there is nothing to do, so callers can skip the API call.
function legacyLabelUpdates(order) {
  const attributes = {};
  const remove = [];

  for (const [oldLabel, newLabel] of Object.entries(LEGACY_LABEL_MAP)) {
    const oldValue = getNoteAttribute(order, oldLabel);
    if (oldValue === null || oldValue === undefined || oldValue === '') continue;

    remove.push(oldLabel);

    // If both labels are present, the new one is already authoritative — drop the
    // old one rather than overwriting a fresher value with a stale one.
    const existingNew = getNoteAttribute(order, newLabel);
    if (existingNew === null || existingNew === undefined || existingNew === '') {
      attributes[newLabel] = oldValue;
    }
  }

  if (!remove.length) return null;
  return { attributes, remove };
}

// One-line summary for logs.
function describeUpdates(updates) {
  if (!updates) return 'nothing to rename';
  const moved = Object.entries(updates.attributes).map(([k, v]) => `${k}=${v}`);
  return [
    moved.length ? `set ${moved.join(', ')}` : null,
    `removed ${updates.remove.join(', ')}`,
  ]
    .filter(Boolean)
    .join('; ');
}

module.exports = { LEGACY_LABEL_MAP, legacyLabelUpdates, describeUpdates, isEnabled };
