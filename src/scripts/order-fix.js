// Recompute a Loop renewal's delivery dates from the ORDER's date and write them
// back onto the Shopify order — the job Arigato Automation was doing.
//
//   node src/scripts/order-fix.js --order 8219641675874 --dry-run
//   node src/scripts/order-fix.js --order 8219641675874
//   node src/scripts/order-fix.js --order 1 --order 2 --force
//
// Flags
//   --order <id>   Shopify order id. Repeatable.
//   --dry-run      Resolve and print the before/after, write nothing.
//   --force        Rewrite even when the current Delivery-Date looks valid.
//   --allow-rewrite Permit a date-replacing rewrite on a deployment where
//                  REWRITE_RENEWAL_DATES=false. Without it, such a run is refused
//                  and falls back to adding only what is missing.
//   --no-requeue   Don't touch the enrichment queue row (default: requeue it
//                  when DATABASE_URL is set, so the stale enrichment is redone).
//
// Needs SHOPIFY_STORE + SHOPIFY_ADMIN_TOKEN (write_orders) and HDS_API_BASE.

require('dotenv').config();
const { getOrder, getNoteAttribute, describeAdminToken } = require('../shopify');
const { resolveAdminToken } = require('../shopify-tokens');
const {
  needsRewrite,
  rewriteRenewalOrder,
  locationFor,
  hasHdsRecords,
  fillHdsRecords,
  ensureDateTags,
  missingDateTags,
} = require('../lib/renewal-rewrite');
const { buildHdsAttributes } = require('../lib/renewal-date');

function parseArgs(argv) {
  const opts = { orders: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--order') opts.orders.push(argv[++i]);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--allow-rewrite') opts.allowRewrite = true;
    else if (a === '--no-requeue') opts.noRequeue = true;
    else if (!a.startsWith('--')) opts.orders.push(a);
    else throw new Error(`unknown flag ${a}`);
  }
  return opts;
}

// Keep the enrichment pipeline honest: the stale attributes already produced an
// order_enrichments row, so reset the queue entry to pending with the corrected
// values and let the normal processor redo it.
async function requeue(orderId, resolved, attributes) {
  const { pool } = require('../db');
  const hds = buildHdsAttributes(resolved, attributes['HDS Delivery Window']);
  const { rowCount } = await pool.query(
    `UPDATE orders_to_enrich
        SET delivery_date = $2, delivery_time = COALESCE(delivery_time, $3),
            suburb = $4, delivery_location_id = $5, source_attributes = $6,
            status = 'pending', attempts = 0, error_message = NULL, updated_at = NOW()
      WHERE order_id = $1`,
    [
      orderId,
      resolved.delivery_date,
      attributes['HDS Delivery Window'] || null,
      resolved.suburb,
      resolved.postcode,
      hds,
    ]
  );
  await pool.end();
  return rowCount;
}

async function runOne(orderId, opts) {
  const res = await getOrder(orderId);
  const order = res?.order;
  if (!order) throw new Error(`order ${orderId} not found in Shopify`);

  const { postcode, suburb } = locationFor(order);
  const state = needsRewrite(order);

  console.log(`\n=== order ${orderId} (${order.name || ''}) ===`);
  console.log(`  ordered        : ${String(order.created_at).slice(0, 10)}`);
  console.log(`  location       : ${postcode || '?'} / ${suburb || '?'}`);
  console.log(`  current dates  : Delivery-Date ${getNoteAttribute(order, 'Delivery-Date') || '(none)'}` +
              `, Pick-Pack-Date ${getNoteAttribute(order, 'Pick-Pack-Date') || '(none)'}`);
  console.log(`  verdict        : ${state.stale ? 'STALE' : 'looks valid'} — ${state.reason}`);

  const missingHds = !hasHdsRecords(order);
  console.log(`  HDS records    : ${missingHds ? 'MISSING — will be filled in' : 'present'}`);

  // Three cases: stale dates get recomputed; a valid date missing its HDS fields
  // gets those filled in around it; anything else needs --force.
  let action = state.stale || opts.force ? 'rewrite' : missingHds ? 'fill' : 'skip';

  // The rewrite REPLACES dates. When the service is configured not to do that -
  // because another system owns this store's dates - the CLI must not quietly do
  // it either, or a single --force undoes the guarantee for that order.
  const rewriteStoodDown =
    String(process.env.REWRITE_RENEWAL_DATES || 'true').toLowerCase() === 'false';

  if (action === 'rewrite' && rewriteStoodDown && !opts.allowRewrite) {
    console.log('  REFUSED — this would REPLACE existing dates, but REWRITE_RENEWAL_DATES=false');
    console.log('            on this deployment, so dates are owned elsewhere.');
    if (missingHds) {
      console.log('            Filling in the missing records instead (adds only, changes nothing).');
      action = 'fill';
    } else {
      console.log('            Pass --allow-rewrite if replacing them is genuinely intended.');
      return { skipped: true };
    }
  }

  if (action === 'skip') {
    // The dates are all present, but the tags may still be absent — which is the
    // normal state of a checkout order now that nothing else tags them.
    const missing = missingDateTags(order);
    if (missing.length) {
      console.log(`  action         : dates are complete; adding the missing tags`);
      console.log(`  tags to add    : ${missing.join(', ')}`);
      if (opts.dryRun) {
        console.log('  [dry-run] nothing written');
        return { dryRun: true };
      }
      await ensureDateTags(order);
      console.log('  ✓ tags written to the Shopify order');
      return { written: true };
    }

    console.log('  skipped — dates and tags are all present');
    console.log('            (pass --force to recompute the dates anyway)');
    return { skipped: true };
  }

  const out =
    action === 'fill'
      ? await fillHdsRecords(order, { dryRun: opts.dryRun })
      : await rewriteRenewalOrder(order, { dryRun: opts.dryRun });

  if (action === 'fill') console.log('  action         : keeping the delivery date, adding the HDS records');
  if (!out.ok) {
    throw new Error(out.reason + (out.schedule ? ` (schedule from ${out.schedule.derivedFrom})` : ''));
  }

  if (out.schedule) console.log(
    `  keeping        : ${out.schedule.deliveryDay || '?'} deliveries` +
      ` (schedule ${out.schedule.scheduleId || 'n/a'}, from ${out.schedule.derivedFrom})` +
      ` -> matched on ${out.resolved.matched_by}`
  );
  console.log('  new values     :');
  for (const [k, v] of Object.entries(out.attributes)) console.log(`     ${k} = ${v}`);
  const written = out.tags || (out.tag ? [out.tag] : []);
  if (written.length) console.log(`     tags: ${written.join(', ')}`);

  if (opts.dryRun) {
    console.log('  [dry-run] nothing written');
    return { dryRun: true };
  }

  console.log('  ✓ written to the Shopify order');

  if (!opts.noRequeue && process.env.DATABASE_URL) {
    const n = await requeue(orderId, out.resolved, out.attributes);
    console.log(n ? '  ✓ enrichment queue row reset to pending' : '  (no queue row for this order)');
  }
  return { written: true };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.orders.length) {
    console.error('Usage: node src/scripts/order-fix.js --order <shopifyOrderId> [--dry-run] [--force]');
    process.exitCode = 1;
    return;
  }

  // Print the config before doing anything: a missing variable is by far the most
  // common reason this script cannot run, and it is cheaper to see than to infer.
  console.log('SHOPIFY_STORE       :', process.env.SHOPIFY_STORE || 'MISSING');
  const resolved = process.env.SHOPIFY_STORE
    ? await resolveAdminToken(process.env.SHOPIFY_STORE)
    : { token: null, source: 'none' };
  console.log('token source        :', resolved.source);
  console.log('token               :', describeAdminToken(resolved.token));
  console.log('HDS_API_BASE        :', process.env.HDS_API_BASE || 'MISSING');
  console.log('DATABASE_URL        :', process.env.DATABASE_URL ? 'set (queue row will be reset)' : 'not set (Shopify only)');

  let ok = 0;
  const failures = [];
  for (const orderId of opts.orders) {
    try {
      await runOne(orderId, opts);
      ok += 1;
    } catch (err) {
      failures.push(`${orderId}: ${err.message}`);
      console.error(`  ✗ ${err.message}`);
    }
  }

  console.log(`\nDone: ${ok} handled, ${failures.length} failed (of ${opts.orders.length}).`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exitCode = 1;
});
