#!/usr/bin/env node
// Bulk update Pick-Pack-Date for multiple orders.
// Usage: node src/scripts/bulk-packdate-update.js <packDate> <orderName1> <orderName2> ...

const { getOrderByName, updateOrderAttributes } = require('../shopify');

const packDate = process.argv[2];
const orderNames = process.argv.slice(3);

if (!packDate || orderNames.length === 0) {
  console.error('Usage: node src/scripts/bulk-packdate-update.js <packDate> <orderName1> <orderName2> ...');
  console.error('Example: node src/scripts/bulk-packdate-update.js 2026/10/10 WM147603 WM147661 WM147686');
  process.exit(1);
}

async function main() {
  let success = 0;
  let failed = 0;

  console.log(`\n📋 Bulk updating Pick-Pack-Date to ${packDate}`);
  console.log(`📊 Orders to update: ${orderNames.length}\n`);

  for (const name of orderNames) {
    try {
      const order = await getOrderByName(name);
      if (!order) {
        console.log(`❌ ${name} — not found`);
        failed++;
        continue;
      }

      await updateOrderAttributes(order.id, {
        attributes: {
          'Pick-Pack-Date': packDate,
          'HDS Ship Date': packDate,
        },
        order,
      });

      console.log(`✅ ${name} — updated`);
      success++;
    } catch (err) {
      console.log(`❌ ${name} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\n📊 Done: ${success} updated, ${failed} failed (of ${orderNames.length})\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
