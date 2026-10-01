// Success / failure report for a run of orders by display name. Read-only.
//
//   node src/scripts/orders-range-report.js --from 146097 --to 146336
//   node src/scripts/orders-range-report.js --from 146097 --to 146336 --prefix WM
//
// Each order is classified the same way the other reports do it; anything not
// "done" carries the live reason (what a fix would resolve to, or why HDS cannot
// resolve it). Makes one Shopify read per order and nothing else.

require('dotenv').config();
const { getOrderByName } = require('../shopify');
const { classifyOrderWithReason } = require('../lib/order-status');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const prefix = arg('prefix', 'WM');
const from = Number(arg('from'));
const to = Number(arg('to'));

if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
  console.error('Usage: node src/scripts/orders-range-report.js --from 146097 --to 146336 [--prefix WM]');
  process.exit(1);
}

async function run() {
  const ok = [];
  const failed = [];

  for (let n = from; n <= to; n += 1) {
    const name = `${prefix}${n}`;
    try {
      const order = await getOrderByName(name);
      if (!order) {
        failed.push({ name, status: 'not-found', reason: 'no order with this name' });
        continue;
      }
      const c = await classifyOrderWithReason(order);
      (c.status === 'done' ? ok : failed).push({ name, status: c.status, reason: c.reason || '' });
    } catch (err) {
      failed.push({ name, status: 'error', reason: (err.message || String(err)).split('\n')[0] });
    }
  }

  console.log(`\nOrders ${prefix}${from} - ${prefix}${to}: ${ok.length + failed.length} checked`);
  console.log(`  SUCCESS: ${ok.length}`);
  console.log(`  FAILED : ${failed.length}\n`);

  if (failed.length) {
    console.log('FAILED ORDERS');
    for (const f of failed) console.log(`  ${f.name}  [${f.status}]  ${f.reason}`);

    const byReason = {};
    for (const f of failed) byReason[f.status] = (byReason[f.status] || 0) + 1;
    console.log('\nFailures by status:', byReason);
  }
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error('report failed:', err.message || err);
    process.exit(1);
  }
);
