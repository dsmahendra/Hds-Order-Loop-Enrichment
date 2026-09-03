// Make sure every order has a pack date.
//
//   node src/scripts/packdates-backfill.js --dry-run
//   node src/scripts/packdates-backfill.js --since 2026-09-01
//   node src/scripts/packdates-backfill.js --max 200
//
// The webhook handles orders as they arrive, but anything it missed stays missed:
// an HDS outage, a wrong HDS_API_BASE, a Shopify write that failed, or orders that
// predate the service. This walks what is already there and fixes what it can, so
// "every order has a pack date" is something you can verify rather than assume.
//
// Safe to re-run: an order that already has everything is skipped without an API
// call, and every write is additive.
//
// Flags
//   --dry-run       report what would change, write nothing
//   --since <date>  only orders created on/after this date (ISO)
//   --max <n>       stop after scanning n orders
//   --limit <n>     page size, max 250 (default 250)
//   --held-only     only orders tagged HDS-Dates-Held, i.e. known failures

require('dotenv').config();
const { listOrders, getNoteAttribute } = require('../shopify');
const { applyHdsToOrder, planFor } = require('../lib/apply-hds');
const { HELD_TAG } = require('../lib/renewal-rewrite');

// Shopify allows 2 REST calls/second sustained. Each order costs a read (already
// paid by the page fetch) plus up to two writes, so pace the writes.
const WRITE_GAP_MS = Number(process.env.SHOPIFY_WRITE_GAP_MS || 550);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = { limit: 250 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--since') opts.since = argv[++i];
    else if (a === '--max') opts.max = Number(argv[++i]);
    else if (a === '--limit') opts.limit = Math.min(Number(argv[++i]) || 250, 250);
    else if (a === '--held-only') opts.heldOnly = true;
    else throw new Error(`unknown flag ${a}`);
  }
  return opts;
}

const packDateOf = (order) =>
  getNoteAttribute(order, 'Pick-Pack-Date') ||
  getNoteAttribute(order, 'HDS Ship Date') ||
  getNoteAttribute(order, 'HDS Pack Date');

const isHeld = (order) =>
  String(order?.tags || '')
    .split(',')
    .some((t) => t.trim() === HELD_TAG);

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log('store   :', process.env.SHOPIFY_STORE || 'MISSING');
  console.log('mode    :', opts.dryRun ? 'DRY RUN (nothing written)' : 'writing');
  if (opts.since) console.log('since   :', opts.since);
  if (opts.max) console.log('max     :', opts.max);
  if (opts.heldOnly) console.log('filter  : only orders tagged', HELD_TAG);
  console.log('');

  let pageInfo = null;
  let scanned = 0;
  let alreadyOk = 0;
  let fixed = 0;
  let held = 0;
  let failed = 0;
  const failures = [];

  do {
    const res = await listOrders({
      limit: opts.limit,
      pageInfo,
      createdAtMin: pageInfo ? null : opts.since || null,
      fields: pageInfo ? null : 'id,name,created_at,tags,note_attributes,shipping_address,line_items',
    });
    pageInfo = res.pageInfo;
    if (!res.orders.length) break;

    for (const order of res.orders) {
      if (opts.max && scanned >= opts.max) {
        pageInfo = null;
        break;
      }
      scanned += 1;

      if (opts.heldOnly && !isHeld(order)) continue;

      const label = `${order.name || order.id} (${String(order.created_at).slice(0, 10)})`;

      // Already has a pack date and nothing pending — leave it entirely alone.
      const plan = planFor(order);
      if (packDateOf(order) && plan.action === 'tags-only') {
        alreadyOk += 1;
        continue;
      }

      try {
        // atCreation is false: a backfill must not stamp today's billing cycle on
        // an order charged weeks ago.
        const out = await applyHdsToOrder(order, { dryRun: opts.dryRun, atCreation: false });

        if (!out.ok && out.action === 'hold') {
          held += 1;
          console.log(`  HELD    ${label}: ${out.reason}`);
          continue;
        }
        if (!out.ok) {
          failed += 1;
          failures.push(`${label}: ${out.reason}`);
          console.log(`  FAILED  ${label}: ${out.reason}`);
          continue;
        }

        fixed += 1;
        const pack = out.wrote?.['Pick-Pack-Date'] || packDateOf(order) || '(unchanged)';
        console.log(
          `  ${opts.dryRun ? 'WOULD  ' : 'FIXED  '} ${label}: ${out.action}, pack ${pack}` +
            (out.tagsAdded.length ? `, tags ${out.tagsAdded.join(', ')}` : '')
        );

        if (!opts.dryRun) await sleep(WRITE_GAP_MS);
      } catch (err) {
        failed += 1;
        const reason = err.message.split('\n')[0];
        failures.push(`${label}: ${reason}`);
        console.log(`  FAILED  ${label}: ${reason}`);

        // A scope or auth problem will fail identically on every remaining order.
        if (/failed 40[13]/.test(err.message)) {
          console.error('\nStopping: the token cannot write to orders.');
          pageInfo = null;
          break;
        }
      }
    }
  } while (pageInfo);

  console.log(
    `\nScanned ${scanned}: ${alreadyOk} already complete, ` +
      `${fixed} ${opts.dryRun ? 'would be fixed' : 'fixed'}, ${held} held, ${failed} failed.`
  );

  if (held) {
    console.log('\nHeld orders have an expired delivery date and REWRITE_RENEWAL_DATES=false.');
    console.log('Set it true to let those be recomputed, then re-run.');
  }
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures.slice(0, 20)) console.log('  ' + f);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exitCode = 1;
});
