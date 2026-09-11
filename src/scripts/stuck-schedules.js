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
// NOT for their recorded postcode/suburb. delivery_location_id there is
// whatever the webhook grabbed first, which for these orders is very often
// the raw "Delivery-Location-Id" note attribute — a Zapiet/Shop-Pay internal
// location id ("290879"), not a real postcode (fillHdsRecords itself never
// trusts that field unless it's actually postcode-shaped; see
// locationCandidatesFor in renewal-rewrite.js). Feeding that straight to HDS
// answers "not available for delivery" for an unrelated reason and drowns out
// the real answer, so this fetches each order fresh from Shopify and resolves
// its location exactly the way fillHdsRecords does.
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
const { fetchDeliveryOptions } = require('../lib/renewal-date');
const { weekdayOf, locationCandidatesFor, locationFor } = require('../lib/renewal-rewrite');
const { getOrder, getNoteAttribute, normalizeDate } = require('../shopify');

const packDateOf = (order) =>
  getNoteAttribute(order, 'Pick-Pack-Date') ||
  getNoteAttribute(order, 'HDS Ship Date') ||
  getNoteAttribute(order, 'HDS Pack Date');

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
        order_id, subscription_id, status, attempts, error_message, updated_at
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

    let order;
    try {
      order = (await getOrder(row.order_id))?.order;
    } catch (err) {
      otherCause += 1;
      console.log(`  ?       ${label}: could not fetch the order from Shopify — ${err.message.split('\n')[0]}`);
      continue;
    }
    if (!order) {
      skipped += 1;
      console.log(`  SKIP    ${label}: order not found in Shopify (deleted?)`);
      continue;
    }

    if (packDateOf(order)) {
      // Fixed since this row was recorded — by a manual order:fix, a later
      // successful sweep pass, or someone correcting it by hand.
      alreadyFixed += 1;
      continue;
    }

    const candidates = locationCandidatesFor(order);
    if (!candidates.length) {
      const partial = locationFor(order);
      skipped += 1;
      console.log(
        `  SKIP    ${label}: no usable postcode/suburb on the order ` +
          `(shipping address / HDS attributes) — best guess ${partial.suburb || '?'} / ${partial.postcode || '?'}`
      );
      continue;
    }

    const rawDelivery = getNoteAttribute(order, 'Delivery-Date') || getNoteAttribute(order, 'HDS Delivery Date');
    const deliveryDate = rawDelivery ? normalizeDate(rawDelivery) : null;
    const wanted = deliveryDate ? weekdayOf(deliveryDate) : null;
    if (!wanted) {
      skipped += 1;
      console.log(`  SKIP    ${label}: no parseable Delivery-Date on the order`);
      continue;
    }

    // Same fallback order fillHdsRecords itself tries: shipping address, then
    // the labelled HDS attributes — so this reaches the identical verdict.
    let offered = null;
    let checkedWith = null;
    let hdsFailure = null;
    for (const candidate of candidates) {
      const res = await fetchDeliveryOptions({ postcode: candidate.postcode, suburb: candidate.suburb });
      if (!res.ok) {
        hdsFailure = `${candidate.suburb} ${candidate.postcode} (${candidate.source}): ${res.reason}`;
        continue;
      }
      offered = [...new Set((res.data.delivery_options || []).map((o) => o.delivery_day))];
      checkedWith = candidate;
      if (offered.some((d) => String(d).toLowerCase() === wanted.toLowerCase())) break;
    }

    if (!offered) {
      otherCause += 1;
      console.log(`  ?       ${label}: could not check HDS for any candidate address — ${hdsFailure}`);
      continue;
    }

    const isOffered = offered.some((d) => String(d).toLowerCase() === wanted.toLowerCase());
    if (isOffered) {
      // HDS offers this weekday now, so whatever failed was something else —
      // a transient blip at the time, an address HDS didn't recognise, etc.
      // Worth listing, but not the "permanently stuck" class this exists to find.
      otherCause += 1;
      console.log(
        `  OTHER   ${label}: ${checkedWith.suburb} ${checkedWith.postcode} DOES offer ${wanted} now — ` +
          `different cause (${row.error_message || row.status})`
      );
      continue;
    }

    stuck += 1;
    console.log(
      `  STUCK   ${label}: anchored to ${wanted} for ${checkedWith.suburb} ${checkedWith.postcode}, ` +
        `but HDS now only offers ${offered.join(', ') || 'nothing'} there`
    );
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
