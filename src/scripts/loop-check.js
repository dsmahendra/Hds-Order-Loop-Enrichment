// Manual verification tool for the Loop charge-offset flow.
//
//   node src/scripts/loop-check.js <shopifyOrderId> [chargeOffsetToSet]
//
// - Prints the raw response of GET /orders/shopify-{orderId}
// - Shows the resolved Loop subscription id (shopify-{contractId})
// - If a chargeOffset is given, PUTs it and prints the raw response
//
// Read-only unless you pass the second argument. Uses LOOP_API_BASE +
// LOOP_API_TOKEN from .env — set LOOP_API_BASE to the 2026-04 admin base.

require('dotenv').config();
const {
  readSubscriptionByOrderId,
  subscriptionIdForOrder,
  editChargeOffset,
} = require('../loop');

function pretty(label, value) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const orderId = process.argv[2];
  const offsetArg = process.argv[3];

  if (!orderId) {
    console.error('Usage: node src/scripts/loop-check.js <shopifyOrderId> [chargeOffsetToSet]');
    process.exit(1);
  }

  console.log('LOOP_API_BASE :', process.env.LOOP_API_BASE || '(default 2023-10)');
  console.log('LOOP_API_TOKEN:', process.env.LOOP_API_TOKEN ? 'set' : 'MISSING');

  const read = await readSubscriptionByOrderId(orderId);
  pretty(`GET /orders/shopify-${orderId}`, read);

  const subId = await subscriptionIdForOrder(orderId);
  console.log('\nResolved Loop subscription id:', subId || '(none — order has no subscription)');

  if (offsetArg != null) {
    if (!subId) {
      console.error('\nCannot set charge offset: this order has no associated subscription.');
      process.exit(1);
    }
    const res = await editChargeOffset(subId, Number(offsetArg));
    pretty(`PUT /subscription/${subId}  { chargeOffset: ${Number(offsetArg)} }`, res);
  } else {
    console.log('\n(no chargeOffset argument given — skipped the write. Pass a number to test it.)');
  }
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exit(1);
});
