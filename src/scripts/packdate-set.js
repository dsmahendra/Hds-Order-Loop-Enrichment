// Set one pack date across a range of orders, by order name.
//
//   node src/scripts/packdate-set.js --from WM141076 --to WM141141 --date 2026/09/05 --dry-run
//   node src/scripts/packdate-set.js --from WM141076 --to WM141141 --date 2026/09/05
//
// A manual override: the date is taken as given, NOT computed from HDS. That is
// the point — it is for a batch that shares one production run and needs the same
// pack date regardless of what a schedule would say.
//
// Additive by default: an order that already has a Pick-Pack-Date is left alone,
// so a re-run cannot change what a previous run set. --overwrite replaces it.
//
// The dry run prints each order's own delivery date beside the date being set, and
// flags any where the pack date would land after the delivery — which is almost
// always a sign the range or the date is wrong.
//
// Flags
//   --from <name>   first order name in the range, e.g. WM141076
//   --to <name>     last order name in the range, inclusive
//   --date <date>   the pack date to set, yyyy/mm/dd or yyyy-mm-dd
//   --dry-run       report only
//   --overwrite     replace an existing Pick-Pack-Date
//   --since <date>  bound the scan (ISO). Defaults to 60 days back.
//   --no-tag        do not add the Pick-Pack-Date-DD-MM-YYYY tag

require('dotenv').config();
const { listOrders, getNoteAttribute, updateOrderAttributes, normalizeDate } = require('../shopify');
const { packDateTag, deliveryDateTag } = require('../lib/order-tags');

const WRITE_GAP_MS = Number(process.env.SHOPIFY_WRITE_GAP_MS || 550);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--from') opts.from = argv[++i];
    else if (a === '--to') opts.to = argv[++i];
    else if (a === '--date') opts.date = argv[++i];
    else if (a === '--since') opts.since = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--overwrite') opts.overwrite = true;
    else if (a === '--no-tag') opts.noTag = true;
    else throw new Error(`unknown flag ${a}`);
  }
  return opts;
}

// "WM141076" -> { prefix: 'WM', number: 141076 }. Compared numerically, so
// WM141099 to WM141101 behaves as expected rather than as a string range.
function parseName(name) {
  const m = String(name || '').trim().match(/^([^\d]*)(\d+)$/);
  return m ? { prefix: m[1], number: Number(m[2]) } : null;
}

function inRange(orderName, from, to) {
  const n = parseName(orderName);
  if (!n) return false;
  if (n.prefix.toLowerCase() !== from.prefix.toLowerCase()) return false;
  return n.number >= from.number && n.number <= to.number;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const from = parseName(opts.from);
  const to = parseName(opts.to);
  if (!from || !to || !opts.date) {
    console.error('Usage: --from WM141076 --to WM141141 --date 2026/09/05 [--dry-run] [--overwrite]');
    process.exitCode = 1;
    return;
  }
  if (from.number > to.number) {
    console.error(`--from ${opts.from} is after --to ${opts.to}`);
    process.exitCode = 1;
    return;
  }

  const packIso = normalizeDate(opts.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(packIso)) {
    console.error(`--date ${opts.date} is not a date (expected yyyy/mm/dd)`);
    process.exitCode = 1;
    return;
  }
  const packSlash = packIso.replace(/-/g, '/');
  const tag = packDateTag(packIso);

  // Default to 60 days so a range of recent orders is found without walking the
  // whole store; write_orders is limited to about that window anyway.
  const since =
    opts.since || new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);

  console.log('store    :', process.env.SHOPIFY_STORE || 'MISSING');
  console.log('range    :', `${opts.from} .. ${opts.to}`, `(${to.number - from.number + 1} names)`);
  console.log('pack date:', packSlash, tag ? `(tag ${tag})` : '');
  console.log('mode     :', opts.dryRun ? 'DRY RUN (nothing written)' : 'writing');
  console.log('existing :', opts.overwrite ? 'WILL BE REPLACED' : 'left alone');
  console.log('scanning since:', since, '\n');

  let pageInfo = null;
  let scanned = 0;
  const found = [];

  do {
    const res = await listOrders({
      limit: 250,
      pageInfo,
      createdAtMin: pageInfo ? null : since,
      fields: pageInfo ? null : 'id,name,created_at,tags,note_attributes',
    });
    pageInfo = res.pageInfo;
    if (!res.orders.length) break;

    scanned += res.orders.length;
    for (const order of res.orders) {
      if (inRange(order.name, from, to)) found.push(order);
    }
  } while (pageInfo);

  found.sort((a, b) => (parseName(a.name)?.number || 0) - (parseName(b.name)?.number || 0));

  console.log(`scanned ${scanned} order(s); ${found.length} in range\n`);
  if (!found.length) {
    console.log('Nothing matched. Widen --since if the orders are older than the window above.');
    return;
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let suspicious = 0;

  for (const order of found) {
    const existing = getNoteAttribute(order, 'Pick-Pack-Date');
    const delivery =
      getNoteAttribute(order, 'Delivery-Date') || getNoteAttribute(order, 'HDS Delivery Date');
    const deliveryIso = delivery ? normalizeDate(delivery) : null;

    // A pack date on or after the delivery date cannot be right.
    const wrongWayRound = deliveryIso && packIso >= deliveryIso;
    if (wrongWayRound) suspicious += 1;

    const label = `${order.name} (${String(order.created_at).slice(0, 10)})`;
    const context = `delivery ${deliveryIso || '(none)'}`;

    if (existing && !opts.overwrite) {
      skipped += 1;
      console.log(`  SKIP    ${label}: already has ${existing}   ${context}`);
      continue;
    }

    const attributes = { 'Pick-Pack-Date': packSlash };
    const addTags = [];
    if (!opts.noTag && tag) addTags.push(tag);
    // Add the delivery-date tag too if the order has a date and no tag for it.
    if (!opts.noTag && deliveryIso) {
      const dTag = deliveryDateTag(deliveryIso);
      if (dTag) addTags.push(dTag);
    }

    const note = wrongWayRound ? '   ** pack is not before delivery **' : '';

    if (opts.dryRun) {
      updated += 1;
      console.log(`  WOULD   ${label}: set ${packSlash}${existing ? ` (was ${existing})` : ''}   ${context}${note}`);
      continue;
    }

    try {
      await updateOrderAttributes(order.id, { attributes, addTags, order });
      updated += 1;
      console.log(`  SET     ${label}: ${packSlash}${existing ? ` (was ${existing})` : ''}   ${context}${note}`);
      await sleep(WRITE_GAP_MS);
    } catch (err) {
      failed += 1;
      const reason = err.message.split('\n')[0];
      console.log(`  FAILED  ${label}: ${reason}`);
      if (/failed 40[13]/.test(err.message)) {
        console.error('\nStopping: the token cannot write to orders.');
        break;
      }
    }
  }

  console.log(
    `\n${opts.dryRun ? 'Would update' : 'Updated'} ${updated}, skipped ${skipped}, failed ${failed}.`
  );
  if (suspicious) {
    console.log(
      `\n${suspicious} order(s) would get a pack date on or after their delivery date.` +
        '\nCheck the range and the date before writing — that combination cannot be right.'
    );
  }
  const missing = to.number - from.number + 1 - found.length;
  if (missing > 0) console.log(`\n${missing} name(s) in the range were not found in the scanned window.`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exitCode = 1;
});
