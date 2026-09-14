// Classify one order's HDS data into a status a human can act on directly,
// for the "every Loop order" status report (see jobs/alert-digest.js).
//
// Pure and DB/Shopify-free: takes an already-fetched order, decides from its
// note attributes alone (same cost discipline as planFor() — no API call to
// classify).
//
//   done            every HDS field present and mutually consistent
//   missing-pack    pack date missing, but the rest of the HDS set is present
//   missing-other   pack date present, but other HDS field(s) are missing
//   missing-both    neither the pack date nor the rest of the HDS set is present
//   stale           everything technically present, but the pack date is
//                   wrong — before today, not before delivery, or Pick-Pack-
//                   Date/HDS Ship Date (two names for the same fact) disagree

const { getNoteAttribute } = require('../shopify');
const { HDS_FIELDS } = require('./renewal-rewrite');
const { packDateStaleness } = require('./apply-hds');

const PACK_KEYS = ['Pick-Pack-Date', 'HDS Ship Date'];
const OTHER_KEYS = HDS_FIELDS.filter((k) => !PACK_KEYS.includes(k));

function classifyOrder(order) {
  const hasPack = PACK_KEYS.some((k) => getNoteAttribute(order, k));
  const missingOther = OTHER_KEYS.filter((k) => !getNoteAttribute(order, k));
  const otherComplete = missingOther.length === 0;

  if (!hasPack && !otherComplete) {
    return { status: 'missing-both', label: 'pack date not updated and other information not added' };
  }
  if (!hasPack) {
    return { status: 'missing-pack', label: 'pack date not updated but other information added' };
  }
  if (!otherComplete) {
    return {
      status: 'missing-other',
      label: `pack date updated but other information not (missing ${missingOther.join(', ')})`,
    };
  }

  const staleness = packDateStaleness(order);
  if (staleness) {
    return { status: 'stale', label: `pack date updated but wrong — ${staleness}` };
  }

  return { status: 'done', label: 'all data updated' };
}

module.exports = { classifyOrder };
