// Backfill the note-attribute label rename across EXISTING orders.
//
//   node src/scripts/labels-rename.js --dry-run
//   node src/scripts/labels-rename.js --since 2026-06-01
//   node src/scripts/labels-rename.js --max 500
//
// New orders are renamed as they arrive by the orders/create webhook; this walks
// what is already there. Only the label moves — the value is carried across
// untouched, so a customer's chosen date never changes.
//
// Flags
//   --dry-run     list what would change, write nothing
//   --since <date> only orders created on/after this date (ISO, e.g. 2026-06-01)
//   --max <n>     stop after scanning n orders (default: no limit)
//   --limit <n>   page size, max 250 (default 250)
//
// Needs SHOPIFY_STORE + an Admin API token with read_orders and write_orders.

require('dotenv').config();
const { listOrders, updateOrderAttributes } = require('../shopify');
const { legacyLabelUpdates, describeUpdates, LEGACY_LABEL_MAP } = require('../lib/legacy-labels');

// Shopify allows 2 REST calls/second sustained. Each rename is one write, so a
// gap just over 500ms keeps a long backfill inside the limit without retries.
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
    else throw new Error(`unknown flag ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log('store    :', process.env.SHOPIFY_STORE || 'MISSING');
  console.log('renaming :', Object.entries(LEGACY_LABEL_MAP).map(([o, n]) => `"${o}" -> "${n}"`).join(', '));
  console.log('mode     :', opts.dryRun ? 'DRY RUN (nothing written)' : 'writing');
  if (opts.since) console.log('since    :', opts.since);
  if (opts.max) console.log('max scan :', opts.max);
  console.log('');

  let pageInfo = null;
  let scanned = 0;
  let changed = 0;
  let failed = 0;
  let page = 0;

  do {
    const res = await listOrders({
      limit: opts.limit,
      pageInfo,
      createdAtMin: pageInfo ? null : opts.since || null,
      // note_attributes is what we rewrite; name/created_at are for the log.
      fields: pageInfo ? null : 'id,name,created_at,note_attributes',
    });

    page += 1;
    pageInfo = res.pageInfo;
    if (!res.orders.length) break;

    for (const order of res.orders) {
      if (opts.max && scanned >= opts.max) {
        pageInfo = null;
        break;
      }
      scanned += 1;

      const updates = legacyLabelUpdates(order);
      if (!updates) continue;

      const label = `${order.name || order.id} (${String(order.created_at).slice(0, 10)})`;
      if (opts.dryRun) {
        console.log(`  would update ${label}: ${describeUpdates(updates)}`);
        changed += 1;
        continue;
      }

      try {
        await updateOrderAttributes(order.id, {
          attributes: updates.attributes,
          removeAttributes: updates.remove,
          order,
        });
        changed += 1;
        console.log(`  updated ${label}: ${describeUpdates(updates)}`);
        await sleep(WRITE_GAP_MS);
      } catch (err) {
        failed += 1;
        console.error(`  FAILED ${label}: ${err.message.split('\n')[0]}`);
        // A 403 means the token cannot write at all, so every remaining order
        // would fail the same way — stop rather than hammer the API.
        if (/failed 403/.test(err.message)) {
          console.error('\nStopping: the token lacks write_orders.');
          pageInfo = null;
          break;
        }
      }
    }
  } while (pageInfo);

  console.log(
    `\nScanned ${scanned} order(s) over ${page} page(s): ` +
      `${changed} ${opts.dryRun ? 'would change' : 'updated'}, ${failed} failed.`
  );
  if (!opts.dryRun && changed) {
    console.log('New orders are renamed automatically by the orders/create webhook.');
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exitCode = 1;
});
