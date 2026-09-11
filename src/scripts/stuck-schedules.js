// Find every subscription/order stuck on a weekday HDS no longer offers for its
// suburb at all — the class of problem order:explain diagnosed on WM142249
// (Sunbury/VIC, anchored to Monday, HDS now only offers Friday/Saturday/Thursday
// there). These do not self-heal: fillHdsRecords correctly refuses to invent a
// delivery slot that doesn't exist, so the SAME "no such weekday" failure
// repeats every renewal, forever, until a human moves the subscription to a day
// HDS actually services. Nothing surfaces that on its own — each one is only
// found today by noticing one missing pack date at a time.
//
//   node src/scripts/stuck-schedules.js
//   node src/scripts/stuck-schedules.js --hours 720
//
// Read-only: fetches orders from Shopify and checks against the live HDS API.
// Nothing here writes to Shopify, Loop, our own tables, or the HDS API.
//
// orders_to_enrich is used ONLY to find which order ids are worth checking —
// the actual verdict comes from checkOrder() (src/lib/stuck-order-check.js),
// shared with the alert digest, which fetches each order fresh and resolves
// its location the way fillHdsRecords itself does (not the DB's own recorded
// postcode/suburb, which is often the Zapiet/Shop-Pay internal location id
// rather than a real postcode).
//
// Flags
//   --hours <n>   how far back to look at orders_to_enrich.updated_at to find
//                 CANDIDATE order ids. Defaults to 720 (30 days): a row that
//                 exhausted its retries stops updating from that point on, so
//                 "recently failed" is the wrong filter for "currently
//                 stuck" — a wide default catches ones that went quiet weeks
//                 ago and were never fixed.
//
// Needs DATABASE_URL, SHOPIFY_STORE + SHOPIFY_ADMIN_TOKEN, and HDS_API_BASE.

require('dotenv').config();
const { pool } = require('../db');
const { checkOrder } = require('../lib/stuck-order-check');

function parseArgs(argv) {
  const opts = { hours: 24 * 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--hours') opts.hours = Number(argv[++i]);
    else throw new Error(`unknown flag ${a}`);
  }
  if (!Number.isFinite(opts.hours) || opts.hours <= 0) {
    throw new Error(`--hours must be a positive number, got ${opts.hours}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — this report reads orders_to_enrich, run it where that is configured.');
    process.exitCode = 1;
    return;
  }

  console.log('store   :', process.env.SHOPIFY_STORE || 'MISSING');
  console.log('window  :', `orders_to_enrich rows touched in the last ${opts.hours}h`);
  console.log('HDS_API_BASE:', process.env.HDS_API_BASE || 'MISSING');
  console.log('');

  // One row per distinct subscription (or per order, when Loop hasn't resolved
  // a subscription id for it yet) — just to find which order ids are worth
  // fetching fresh. Everything else about the order comes from Shopify below.
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (COALESCE(subscription_id::text, order_id::text))
        order_id, subscription_id
       FROM orders_to_enrich
      WHERE (status = 'failed' OR hds_write_ok = FALSE)
        AND updated_at >= NOW() - ($1::int * INTERVAL '1 hour')
      ORDER BY COALESCE(subscription_id::text, order_id::text), updated_at DESC`,
    [opts.hours]
  );

  console.log(`${rows.length} distinct failing subscription/order(s) to check\n`);

  let stuck = 0;
  let alreadyFixed = 0;
  let otherCause = 0;
  let skipped = 0;

  for (const row of rows) {
    const label = row.subscription_id
      ? `subscription ${row.subscription_id} (order ${row.order_id})`
      : `order ${row.order_id} (no subscription resolved)`;

    const result = await checkOrder(row.order_id);

    switch (result.verdict) {
      case 'fetch-failed':
        otherCause += 1;
        console.log(`  ?       ${label}: could not fetch the order from Shopify — ${result.detail}`);
        break;
      case 'not-found':
        skipped += 1;
        console.log(`  SKIP    ${label}: order not found in Shopify (deleted?)`);
        break;
      case 'fixed':
        alreadyFixed += 1;
        break;
      case 'skip':
        skipped += 1;
        console.log(`  SKIP    ${label}: ${result.detail}`);
        break;
      case 'other':
        otherCause += 1;
        console.log(`  OTHER   ${label}: ${result.detail}`);
        break;
      case 'stuck':
        stuck += 1;
        console.log(`  STUCK   ${label}: ${result.detail}`);
        break;
    }
  }

  console.log(
    `\n${stuck} stuck on a withdrawn weekday, ${alreadyFixed} already fixed since, ` +
      `${otherCause} failing for another reason, ${skipped} skipped (not enough data).`
  );
  if (stuck) {
    console.log('\nThese will not self-heal — retrying computes the identical "no such weekday" answer every time.');
    console.log('Each needs a human decision on which day to move it to. To fix one order right now:');
    console.log('  RENEWAL_DELIVERY_SELECTION=earliest node src/scripts/order-fix.js --order <order_id> --force --dry-run');
    console.log("Then update that subscription's own Delivery-Date in Loop, or the next renewal fails the same way.");
  }
}

main()
  .catch((err) => {
    console.error('\nERROR:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
