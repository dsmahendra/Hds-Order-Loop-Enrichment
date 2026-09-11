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
// Read-only: only queries orders_to_enrich and the live HDS API. Nothing here
// writes to Shopify, Loop, or our own tables.
//
// Source of truth is our own queue table, not a fresh Shopify scan — every row
// worth reporting already failed enrichment and recorded its suburb/postcode/
// delivery_date at the time, so this needs no Shopify API calls at all (fast,
// and unaffected by whatever the order looks like now).
//
// Flags
//   --hours <n>   how far back to look at orders_to_enrich.updated_at.
//                 Defaults to 720 (30 days): a row that exhausted its retries
//                 stops updating from that point on, so "recently failed" is
//                 the wrong filter for "currently stuck" — a wide default
//                 catches ones that went quiet weeks ago and were never fixed.
//
// Needs DATABASE_URL and HDS_API_BASE.

require('dotenv').config();
const { pool } = require('../db');
const { fetchDeliveryOptions } = require('../lib/renewal-date');
const { weekdayOf } = require('../lib/renewal-rewrite');

// pg returns DATE/TIMESTAMPTZ columns as JS Date objects, not strings — so
// String(value).slice(0, 10) silently produces "Mon Sep 15 2026 ..." instead
// of "2026-09-15", and weekdayOf() (which expects the latter) fails on it.
// Same helper as enrich-orders-queue.js's toISODate(), which exists for
// exactly this reason.
function toISODate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

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

  console.log('window  :', `orders_to_enrich rows touched in the last ${opts.hours}h`);
  console.log('HDS_API_BASE:', process.env.HDS_API_BASE || 'MISSING');
  console.log('');

  // One row per distinct subscription (or per order, when Loop hasn't resolved
  // a subscription id for it yet) — the most recently touched failing attempt,
  // which carries the suburb/postcode/delivery_date that failure was judged
  // against.
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (COALESCE(subscription_id::text, order_id::text))
        order_id, subscription_id, delivery_date, delivery_location_id, suburb,
        status, attempts, error_message, source, updated_at
       FROM orders_to_enrich
      WHERE (status = 'failed' OR hds_write_ok = FALSE)
        AND updated_at >= NOW() - ($1::int * INTERVAL '1 hour')
      ORDER BY COALESCE(subscription_id::text, order_id::text), updated_at DESC`,
    [opts.hours]
  );

  console.log(`${rows.length} distinct failing subscription/order(s) to check\n`);

  let stuck = 0;
  let otherCause = 0;
  let skipped = 0;

  for (const row of rows) {
    const label = row.subscription_id
      ? `subscription ${row.subscription_id} (order ${row.order_id})`
      : `order ${row.order_id} (no subscription resolved)`;

    const postcode = row.delivery_location_id;
    const suburb = row.suburb;
    const deliveryDate = toISODate(row.delivery_date);
    const wanted = deliveryDate ? weekdayOf(deliveryDate) : null;

    if (!postcode || !suburb || !wanted) {
      skipped += 1;
      console.log(
        `  SKIP    ${label}: not enough recorded data to check ` +
          `(postcode ${postcode || '?'}, suburb ${suburb || '?'}, weekday ${wanted || '?'})`
      );
      continue;
    }

    const res = await fetchDeliveryOptions({ postcode, suburb });
    if (!res.ok) {
      otherCause += 1;
      console.log(`  ?       ${label}: could not check HDS right now — ${res.reason}`);
      continue;
    }

    const offered = [...new Set((res.data.delivery_options || []).map((o) => o.delivery_day))];
    const isOffered = offered.some((d) => String(d).toLowerCase() === wanted.toLowerCase());

    if (isOffered) {
      // HDS offers this weekday now, so whatever failed was something else —
      // a transient blip, a bad suburb spelling, etc. Worth listing, but it's
      // not the "permanently stuck" class this report exists to find.
      otherCause += 1;
      console.log(
        `  OTHER   ${label}: ${suburb} ${postcode} DOES offer ${wanted} now — different cause ` +
          `(${row.error_message || row.status})`
      );
      continue;
    }

    stuck += 1;
    console.log(
      `  STUCK   ${label}: anchored to ${wanted} for ${suburb} ${postcode}, but HDS now only offers ` +
        `${offered.join(', ') || 'nothing'} there (${row.attempts} attempt(s) already failed, ` +
        `last ${toISODate(row.updated_at)})`
    );
  }

  console.log(
    `\n${stuck} stuck on a withdrawn weekday, ${otherCause} failing for another reason, ${skipped} skipped (not enough data).`
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
