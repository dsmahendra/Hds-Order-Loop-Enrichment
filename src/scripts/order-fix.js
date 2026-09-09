// Recompute a Loop renewal's delivery dates from the ORDER's date and write them
// back onto the Shopify order — the job Arigato Automation was doing.
//
//   node src/scripts/order-fix.js --order 8219641675874 --dry-run
//   node src/scripts/order-fix.js --order 8219641675874
//   node src/scripts/order-fix.js --order 1 --order 2 --force
//   node src/scripts/order-fix.js --name WM141937 --name WM141926
//   node src/scripts/order-fix.js --name WM141907 --name WM141921 --recompute
//
// Flags
//   --order <id>   Shopify order id. Repeatable.
//   --name <name>  Shopify order name, e.g. WM141907 (looked up for you).
//                  Repeatable, and freely mixable with --order.
//   --dry-run      Resolve and print the before/after, write nothing.
//   --force        Rewrite even when the current Delivery-Date looks valid.
//   --recompute    Keep the existing Delivery-Date but REPLACE everything
//                  derived from it (Pick-Pack-Date included) with a fresh HDS
//                  lookup. For an order whose pack date is simply WRONG, where
//                  --force would needlessly also risk moving the delivery date.
//   --allow-rewrite Permit a date-replacing rewrite on a deployment where
//                  REWRITE_RENEWAL_DATES=false. Without it, such a run is refused
//                  and falls back to adding only what is missing.
//   --no-requeue   Don't touch the enrichment queue row (default: requeue it
//                  when DATABASE_URL is set, so the stale enrichment is redone).
//
// Needs SHOPIFY_STORE + SHOPIFY_ADMIN_TOKEN (write_orders) and HDS_API_BASE.

require('dotenv').config();
const { getOrder, getOrderByName, getNoteAttribute, describeAdminToken } = require('../shopify');
const { resolveAdminToken } = require('../shopify-tokens');
const { needsRewrite, locationFor } = require('../lib/renewal-rewrite');
const { applyHdsToOrder, planFor, rewriteEnabled, hasDeliveryDate } = require('../lib/apply-hds');
const { buildHdsAttributes } = require('../lib/renewal-date');

function parseArgs(argv) {
  const opts = { refs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--order') opts.refs.push({ id: argv[++i] });
    else if (a === '--name') opts.refs.push({ name: argv[++i] });
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--recompute') opts.recompute = true;
    else if (a === '--allow-rewrite') opts.allowRewrite = true;
    else if (a === '--no-requeue') opts.noRequeue = true;
    else if (!a.startsWith('--')) opts.refs.push({ id: a });
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

async function runOne(ref, opts) {
  const label = ref.id || ref.name;
  const order = ref.id ? (await getOrder(ref.id))?.order : await getOrderByName(ref.name);
  if (!order) throw new Error(`order ${label} not found in Shopify`);
  const orderId = order.id;

  const { postcode, suburb } = locationFor(order);
  const state = needsRewrite(order);

  console.log(`
=== order ${orderId} (${order.name || ''}) ===`);
  console.log(`  ordered        : ${String(order.created_at).slice(0, 10)}`);
  console.log(`  location       : ${postcode || '?'} / ${suburb || '?'}`);
  console.log(
    `  current dates  : Delivery-Date ${getNoteAttribute(order, 'Delivery-Date') || '(none)'}` +
      `, Pick-Pack-Date ${getNoteAttribute(order, 'Pick-Pack-Date') || '(none)'}`
  );
  console.log(`  verdict        : ${state.stale ? 'STALE' : 'looks valid'} — ${state.reason}`);

  const plan = planFor(order);
  console.log(`  plan           : ${plan.action} — ${plan.reason}`);

  // A forced rewrite REPLACES dates. When the deployment is configured not to,
  // the CLI must not quietly do it either.
  if (opts.force && !rewriteEnabled() && hasDeliveryDate(order) && !opts.allowRewrite) {
    console.log('  REFUSED — --force would REPLACE existing dates, but REWRITE_RENEWAL_DATES=false');
    console.log('            Pass --allow-rewrite if that is genuinely intended.');
    console.log('            Continuing without --force instead.');
    opts.force = false;
  }

  if (plan.action === 'hold') {
    console.log('  held — an expired date cannot be recomputed while rewriting is stood down');
    console.log('         set REWRITE_RENEWAL_DATES=true, or pass --allow-rewrite');
    if (!opts.allowRewrite) return { skipped: true };
  }

  // atCreation stays false: a backfill must not stamp today's billing cycle on an
  // order charged weeks ago.
  const out = await applyHdsToOrder(order, {
    dryRun: opts.dryRun,
    atCreation: false,
    force: opts.force,
    recompute: opts.recompute,
  });

  if (!out.ok) throw new Error(out.reason);

  if (out.wrote && Object.keys(out.wrote).length) {
    console.log('  new values     :');
    for (const [k, v] of Object.entries(out.wrote)) console.log(`     ${k.padEnd(24)} ${v}`);
  }
  if (out.tagsAdded.length) console.log(`  tags           : ${out.tagsAdded.join(', ')}`);
  if (out.deliveryTimeAdded) console.log(`  Delivery-Time  : ${out.deliveryTimeAdded} (defaulted — order had none)`);

  if (!out.wrote && !out.tagsAdded.length && !out.deliveryTimeAdded) {
    console.log('  nothing to do — dates, tags and Delivery-Time are all present');
    return { skipped: true };
  }

  if (opts.dryRun) {
    console.log('  [dry-run] nothing written');
    return { dryRun: true };
  }

  console.log('  ✓ written to the Shopify order');

  if (!opts.noRequeue && process.env.DATABASE_URL && out.resolved) {
    const n = await requeue(orderId, out.resolved, out.wrote || {});
    console.log(n ? '  ✓ enrichment queue row reset to pending' : '  (no queue row for this order)');
  }
  return { written: true };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.refs.length) {
    console.error(
      'Usage: node src/scripts/order-fix.js (--order <shopifyOrderId> | --name <orderName>) [--dry-run] [--force | --recompute]'
    );
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
  for (const ref of opts.refs) {
    try {
      await runOne(ref, opts);
      ok += 1;
    } catch (err) {
      failures.push(`${ref.id || ref.name}: ${err.message}`);
      console.error(`  ✗ ${err.message}`);
    }
  }

  console.log(`\nDone: ${ok} handled, ${failures.length} failed (of ${opts.refs.length}).`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exitCode = 1;
});
