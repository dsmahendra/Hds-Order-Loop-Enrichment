// Send the real-time per-order status email for one order right now, without
// waiting for a webhook — useful for confirming SMTP/PER_ORDER_EMAIL_ENABLED
// actually work before trusting them to fire automatically.
//
//   node src/scripts/order-notify-now.js --order 6811051327531
//   node src/scripts/order-notify-now.js --name WM142738
//
// Ignores PER_ORDER_EMAIL_ENABLED's own gate — that flag controls whether the
// webhook calls this automatically, not whether this manual trigger can.

require('dotenv').config();
const { getOrder, getOrderByName } = require('../shopify');
const { notifyOrderStatus } = require('../lib/order-notify');
const { isConfigured } = require('../lib/mailer');

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--order') opts.id = argv[++i];
    else if (a === '--name') opts.name = argv[++i];
    else throw new Error(`unknown flag ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.id && !opts.name) {
    console.error('Usage: node src/scripts/order-notify-now.js (--order <shopifyOrderId> | --name <orderName>)');
    process.exitCode = 1;
    return;
  }

  console.log('SHOPIFY_STORE :', process.env.SHOPIFY_STORE || 'MISSING');
  console.log('SMTP configured:', isConfigured() ? 'yes' : 'no — this will log what it would send and stop there');
  console.log('');

  const order = opts.id ? (await getOrder(opts.id))?.order : await getOrderByName(opts.name);
  if (!order) throw new Error(`order ${opts.id || opts.name} not found in Shopify`);

  // Bypasses PER_ORDER_EMAIL_ENABLED — this script IS the manual override for
  // testing, so it always attempts the send regardless of that flag.
  const result = await notifyOrderStatus(order, { force: true });
  console.log(result);
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exitCode = 1;
});
