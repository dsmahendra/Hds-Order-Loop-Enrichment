// Check subscription run results - list all orders created in last N minutes
// Shows: passed, failed, missing pack dates, stale pack dates
//
// Usage:
//   node src/scripts/subs-results-report.js [--minutes 15]

require('dotenv').config();
const { pool } = require('../db');
const { getOrder, getNoteAttribute } = require('../shopify');
const { classifyOrderWithReason } = require('../lib/order-status');

const MINUTES = Number(process.argv[2] === '--minutes' ? process.argv[3] : 30);

async function run() {
  console.log(`\n📊 SUBSCRIPTION RUN RESULTS REPORT`);
  console.log(`Checking orders from last ${MINUTES} minutes...\n`);

  try {
    // Get all orders created in the last N minutes
    const { rows: orderRows } = await pool.query(
      `SELECT DISTINCT order_id, created_at, status, error_message, hds_write_ok
        FROM orders_to_enrich
       WHERE created_at >= NOW() - ($1::int * INTERVAL '1 minute')
       ORDER BY created_at DESC`,
      [MINUTES]
    );

    if (orderRows.length === 0) {
      console.log('❌ No orders found in last', MINUTES, 'minutes');
      process.exit(0);
    }

    console.log(`Found ${orderRows.length} order(s)\n`);

    const results = {
      done: [],
      missingPack: [],
      missingOther: [],
      stale: [],
      error: [],
    };

    // Check each order
    for (const row of orderRows) {
      try {
        const order = (await getOrder(row.order_id))?.order;
        if (!order) {
          results.error.push({
            orderId: row.order_id,
            reason: 'Order not found in Shopify',
          });
          continue;
        }

        const c = await classifyOrderWithReason(order);
        const result = {
          orderId: row.order_id,
          orderName: order.name,
          createdAt: row.created_at,
          status: c.status,
          reason: c.reason,
        };

        if (c.status === 'done') {
          results.done.push(result);
        } else if (c.status === 'missing-pack') {
          results.missingPack.push(result);
        } else if (c.status === 'missing-other') {
          results.missingOther.push(result);
        } else if (c.status === 'stale') {
          results.stale.push(result);
        } else {
          results.error.push(result);
        }
      } catch (err) {
        results.error.push({
          orderId: row.order_id,
          reason: err.message.split('\n')[0],
        });
      }
    }

    // Print report
    console.log(`═══════════════════════════════════════════════════════════════════════════════\n`);

    if (results.done.length) {
      console.log(`✅ ENRICHED (${results.done.length}):`);
      for (const r of results.done) {
        console.log(`   ${r.orderName || r.orderId}`);
      }
      console.log();
    }

    if (results.missingPack.length) {
      console.log(`⚠️  MISSING PACK DATE (${results.missingPack.length}):`);
      for (const r of results.missingPack) {
        console.log(`   ${r.orderName || r.orderId}`);
        if (r.reason) console.log(`      → ${r.reason}`);
      }
      console.log();
    }

    if (results.missingOther.length) {
      console.log(`⚠️  MISSING OTHER FIELDS (${results.missingOther.length}):`);
      for (const r of results.missingOther) {
        console.log(`   ${r.orderName || r.orderId}`);
        if (r.reason) console.log(`      → ${r.reason}`);
      }
      console.log();
    }

    if (results.stale.length) {
      console.log(`🔴 STALE PACK DATE (${results.stale.length}):`);
      for (const r of results.stale) {
        console.log(`   ${r.orderName || r.orderId}`);
        if (r.reason) console.log(`      → ${r.reason}`);
      }
      console.log();
    }

    if (results.error.length) {
      console.log(`❌ ERRORS (${results.error.length}):`);
      for (const r of results.error) {
        console.log(`   ${r.orderName || r.orderId}`);
        if (r.reason) console.log(`      → ${r.reason}`);
      }
      console.log();
    }

    // Summary
    console.log(`═══════════════════════════════════════════════════════════════════════════════\n`);
    console.log(`📈 SUMMARY:`);
    console.log(`   Total:        ${orderRows.length}`);
    console.log(`   ✅ Enriched:   ${results.done.length} (${Math.round(results.done.length / orderRows.length * 100)}%)`);
    console.log(`   ⚠️  Issues:    ${results.missingPack.length + results.missingOther.length + results.stale.length}`);
    console.log(`   ❌ Errors:    ${results.error.length}`);
    console.log();

    // Failed orders bulk fix command
    const failed = [...results.missingPack, ...results.missingOther, ...results.stale, ...results.error];
    if (failed.length > 0) {
      console.log(`🔧 TO FIX ALL FAILED ORDERS:`);
      const names = failed
        .filter(r => r.orderName)
        .map(r => `--name ${r.orderName}`)
        .join(' ');
      console.log(`   node src/scripts/order-fix.js ${names}\n`);
    }

    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

run();
