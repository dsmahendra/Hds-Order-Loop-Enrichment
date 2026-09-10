// Manually set the pack date on orders placed in a time window, an explicit
// named list, or a range of order names.
//
//   node src/scripts/packdate-manual.js --from "2026-09-04 3:55 pm" --to "2026-09-04 4:07 pm" --dry-run
//   node src/scripts/packdate-manual.js --from "2026-09-04 15:55" --to "2026-09-04 16:07" --date 2026/09/05
//   node src/scripts/packdate-manual.js --name WM141937 --name WM141926 --date 2026/09/11 --overwrite
//   node src/scripts/packdate-manual.js --from-name WM142033 --to-name WM142220 --date 2026/09/12
//
// Deliberately standalone. It reads the same helpers the service uses but changes
// none of them, and nothing in the webhook, the queue or the retry job calls into
// this file — so running it, or getting it wrong, cannot affect how orders are
// handled as they arrive.
//
// Three ways to pick WHICH orders (pick exactly one):
//
//   --from/--to             every order created in that store-time window
//   --name                  only the named orders, repeatable — for a specific
//                           list off a spreadsheet rather than everything from
//                           a burst
//   --from-name/--to-name   every order whose NAME falls in that range,
//                           inclusive — for "these ~190 consecutive orders",
//                           where listing each one by --name would be
//                           impractical. Order doesn't matter: given backwards
//                           (the higher number first) it is normalised.
//
// Two ways to pick the DATE:
//
//   --date given    write exactly that date to every matched order. A shared
//                   production run, where one date is correct for all of them.
//   --date omitted  compute each order's own pack date from the HDS schedule for
//                   its suburb and delivery date. Different orders get different
//                   dates, which is usually what is actually wanted.
//
// Times are STORE time, matching what the Shopify order page shows. Shopify's
// created_at carries the store's offset — "2026-09-04T15:55:12+10:00" — so the part
// before the offset already IS local time and no conversion is involved. Treating
// those as UTC would shift a Sydney window by ten hours and silently match the
// wrong orders.
//
// Flags
//   --from <when>     start of the window, inclusive. Mutually exclusive with
//                     --name and --from-name/--to-name.
//   --to <when>       end of the window, inclusive.
//   --name <name>     an order name, e.g. WM141937. Repeatable.
//   --from-name <n>   low end of an order-name range, inclusive.
//   --to-name <n>     high end of an order-name range, inclusive.
//   --since <date>    bound the scan for --from-name/--to-name to orders
//                     created on/after this ISO date — much faster when the
//                     range is recent. Omit to scan the whole store.
//   --date <date>     the pack date to write. Omit to compute per order.
//   --dry-run         report what would change, write nothing
//   --overwrite       replace a pack date the order already has
//   --tags            also add the Pick-Pack-Date-DD-MM-YYYY tag. Off by
//                     default, so by default this touches one attribute and
//                     nothing else.

require('dotenv').config();
const {
  listOrders,
  getOrderByName,
  getNoteAttribute,
  updateOrderAttributes,
  normalizeDate,
} = require('../shopify');
const { fillHdsRecords, packDateTag } = require('../lib/renewal-rewrite');

const WRITE_GAP_MS = Number(process.env.SHOPIFY_WRITE_GAP_MS || 550);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = { names: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--from') opts.from = argv[++i];
    else if (a === '--to') opts.to = argv[++i];
    else if (a === '--name') opts.names.push(argv[++i]);
    else if (a === '--from-name') opts.fromName = argv[++i];
    else if (a === '--to-name') opts.toName = argv[++i];
    else if (a === '--since') opts.since = argv[++i];
    else if (a === '--date') opts.date = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--overwrite') opts.overwrite = true;
    else if (a === '--tags') opts.tags = true;
    else throw new Error(`unknown flag ${a}`);
  }
  return opts;
}

// "WM141076" -> { prefix: 'WM', number: 141076 }, compared numerically so a
// range does not misbehave the moment digit counts differ.
function parseName(name) {
  const m = String(name || '').trim().match(/^([^\d]*)(\d+)$/);
  return m ? { prefix: m[1], number: Number(m[2]) } : null;
}

function inNameRange(orderName, from, to) {
  const n = parseName(orderName);
  if (!n) return false;
  if (from && n.prefix.toLowerCase() !== from.prefix.toLowerCase()) return false;
  if (from && n.number < from.number) return false;
  if (to && n.number > to.number) return false;
  return true;
}

// Accepts what a person would actually type from the order page:
//   "2026-09-04 3:55 pm"   "2026-09-04 15:55"   "2026-09-04T15:55:12"   "2026-09-04"
// end=true pads missing precision upward, so a "4:07 pm" bound includes 16:07:59.
// Without that, 16:07:30 > "2026-09-04T16:07" and the final minute drops out.
function parseWhen(value, { end = false } = {}) {
  if (!value) return null;
  const raw = String(value).trim();

  const m = raw.match(
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?)?$/i
  );
  if (!m) return null;

  const [, date, hRaw, minRaw, secRaw, meridiem] = m;
  if (hRaw === undefined) return `${date}T${end ? '23:59:59' : '00:00:00'}`;

  let hour = Number(hRaw);
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    const pm = meridiem.toLowerCase() === 'pm';
    hour = pm ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour;
  }
  if (hour > 23) return null;

  const minute = minRaw === undefined ? (end ? 59 : 0) : Number(minRaw);
  const second = secRaw === undefined ? (end ? 59 : 0) : Number(secRaw);
  if (minute > 59 || second > 59) return null;

  const pad = (n) => String(n).padStart(2, '0');
  return `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

// "2026-09-04T15:55:12+10:00" -> "2026-09-04T15:55:12"
function localPart(createdAt) {
  const m = String(createdAt || '').match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function withinWindow(order, from, to) {
  const local = localPart(order?.created_at);
  if (!local) return false;
  return local >= from && local <= to;
}

const packDateOf = (order) =>
  getNoteAttribute(order, 'Pick-Pack-Date') ||
  getNoteAttribute(order, 'HDS Ship Date') ||
  getNoteAttribute(order, 'HDS Pack Date');

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const byName = opts.names.length > 0;
  const byNameRange = Boolean(opts.fromName || opts.toName);
  const byWindow = Boolean(opts.from || opts.to);

  const modesUsed = [byName, byNameRange, byWindow].filter(Boolean).length;
  if (modesUsed > 1) {
    console.error(
      '--name, --from-name/--to-name and --from/--to are three different ways to pick orders — use only one.'
    );
    process.exitCode = 1;
    return;
  }

  let from = null;
  let to = null;
  let nameFrom = null;
  let nameTo = null;

  if (byNameRange) {
    if (!opts.fromName || !opts.toName) {
      console.error('--from-name and --to-name must be given together.');
      process.exitCode = 1;
      return;
    }
    nameFrom = parseName(opts.fromName);
    nameTo = parseName(opts.toName);
    if (!nameFrom) {
      console.error(`--from-name ${opts.fromName} is not an order name`);
      process.exitCode = 1;
      return;
    }
    if (!nameTo) {
      console.error(`--to-name ${opts.toName} is not an order name`);
      process.exitCode = 1;
      return;
    }
    // Order doesn't matter to a person reading it off a spreadsheet — normalise
    // rather than silently matching nothing when it's given high-to-low.
    if (nameFrom.number > nameTo.number) [nameFrom, nameTo] = [nameTo, nameFrom];
  } else if (!byName) {
    from = parseWhen(opts.from);
    to = parseWhen(opts.to, { end: true });

    if (!from || !to) {
      console.error('Usage:');
      console.error('  --from "2026-09-04 3:55 pm" --to "2026-09-04 4:07 pm" [--date 2026/09/05]');
      console.error('  --from "2026-09-04 15:55"   --to "2026-09-04 16:07"');
      console.error('  --name WM141937 --name WM141926 --date 2026/09/11');
      console.error('  --from-name WM142033 --to-name WM142220 --date 2026/09/12');
      if (opts.from && !from) console.error(`\n--from ${opts.from} is not a date/time`);
      if (opts.to && !to) console.error(`\n--to ${opts.to} is not a date/time`);
      process.exitCode = 1;
      return;
    }
    if (from > to) {
      console.error(`--from ${from} is after --to ${to}`);
      process.exitCode = 1;
      return;
    }
  }

  let packSlash = null;
  if (opts.date) {
    const iso = normalizeDate(opts.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      console.error(`--date ${opts.date} is not a date (expected yyyy/mm/dd)`);
      process.exitCode = 1;
      return;
    }
    packSlash = iso.replace(/-/g, '/');
  }

  console.log('store    :', process.env.SHOPIFY_STORE || 'MISSING');
  console.log(
    'selection:',
    byName
      ? `${opts.names.length} named order(s)`
      : byNameRange
        ? `${nameFrom.prefix}${nameFrom.number} .. ${nameTo.prefix}${nameTo.number}`
        : `${from} .. ${to} (store time)`
  );
  console.log('pack date:', packSlash || 'computed per order from HDS');
  console.log('mode     :', opts.dryRun ? 'DRY RUN (nothing written)' : 'writing');
  console.log('existing :', opts.overwrite ? 'WILL BE REPLACED' : 'left alone');
  console.log(
    'changes  : Pick-Pack-Date' +
      (opts.tags
        ? ' + its tag (every existing tag kept)'
        : ' only — no tags, no other attribute')
  );
  console.log('');

  let scanned = 0;
  let notFound = 0;
  const matched = [];

  if (byName) {
    for (const name of opts.names) {
      scanned += 1;
      const order = await getOrderByName(name);
      if (!order) {
        notFound += 1;
        console.log(`  NOT FOUND ${name}`);
        continue;
      }
      matched.push(order);
    }
  } else if (byNameRange) {
    let pageInfo = null;
    do {
      const res = await listOrders({
        limit: 250,
        pageInfo,
        createdAtMin: pageInfo ? null : opts.since || null,
        fields: pageInfo ? null : 'id,name,created_at,tags,note_attributes,shipping_address',
      });
      pageInfo = res.pageInfo;
      if (!res.orders.length) break;

      scanned += res.orders.length;
      for (const order of res.orders) {
        if (inNameRange(order.name, nameFrom, nameTo)) matched.push(order);
      }
    } while (pageInfo);
  } else {
    // The window names its own day, so start the scan there.
    const since = from.slice(0, 10);
    let pageInfo = null;

    do {
      const res = await listOrders({
        limit: 250,
        pageInfo,
        createdAtMin: pageInfo ? null : since,
        fields: pageInfo ? null : 'id,name,created_at,tags,note_attributes,shipping_address',
      });
      pageInfo = res.pageInfo;
      if (!res.orders.length) break;

      scanned += res.orders.length;
      for (const order of res.orders) {
        if (withinWindow(order, from, to)) matched.push(order);
      }
    } while (pageInfo);
  }

  matched.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

  console.log(
    byName
      ? `${matched.length} of ${scanned} named order(s) found\n`
      : byNameRange
        ? `scanned ${scanned} order(s); ${matched.length} in the name range\n`
        : `scanned ${scanned} order(s) from ${from.slice(0, 10)}; ${matched.length} inside the window\n`
  );
  if (!matched.length) {
    console.log(
      byName
        ? 'None of the given names were found — check the spelling against the order page.'
        : byNameRange
          ? 'Nothing matched that name range. Pass --since if the range is recent, to make sure the scan reaches it, or check the prefix/numbers.'
          : 'Nothing matched. Check the times against the order page — they are store time, and the window is inclusive at both ends.'
    );
    if (notFound) process.exitCode = 1;
    return;
  }

  let updated = 0;
  let skipped = 0;
  let failed = notFound;
  let suspicious = 0;

  for (const order of matched) {
    const label = `${order.name} (${String(order.created_at).slice(0, 16).replace('T', ' ')})`;
    const existing = packDateOf(order);
    const delivery =
      getNoteAttribute(order, 'Delivery-Date') || getNoteAttribute(order, 'HDS Delivery Date');
    const deliveryIso = delivery ? normalizeDate(delivery) : null;

    if (existing && !opts.overwrite) {
      skipped += 1;
      console.log(`  SKIP    ${label}: already has ${existing}`);
      continue;
    }

    // Work out this order's pack date: the given one, or HDS's for its own schedule.
    let pack = packSlash;
    if (!pack) {
      const out = await fillHdsRecords(order, { dryRun: true, overwrite: true });
      if (!out.ok) {
        failed += 1;
        console.log(`  FAILED  ${label}: ${out.reason}`);
        continue;
      }
      pack = out.attributes['Pick-Pack-Date'];
      if (!pack) {
        failed += 1;
        console.log(`  FAILED  ${label}: HDS returned no pack date for its schedule`);
        continue;
      }
    }

    const packIso = normalizeDate(pack);
    const wrongWayRound = deliveryIso && packIso >= deliveryIso;
    if (wrongWayRound) suspicious += 1;

    const detail =
      `delivery ${deliveryIso || '(none)'}` +
      (existing && existing !== pack ? `, was ${existing}` : '') +
      (wrongWayRound ? '   ** pack is not before delivery **' : '');

    if (opts.dryRun) {
      updated += 1;
      console.log(`  WOULD   ${label}: set ${pack}   ${detail}`);
      continue;
    }

    try {
      await updateOrderAttributes(order.id, {
        attributes: { 'Pick-Pack-Date': pack },
        addTags: opts.tags && packDateTag(packIso) ? [packDateTag(packIso)] : [],
        order,
      });
      updated += 1;
      console.log(`  SET     ${label}: ${pack}   ${detail}`);
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
    `\n${opts.dryRun ? 'Would set' : 'Set'} ${updated}, skipped ${skipped}, failed ${failed}.`
  );
  if (suspicious) {
    console.log(
      `\n${suspicious} order(s) would get a pack date on or after their delivery date.` +
        '\nThat cannot be right — check the window and the date before writing.'
    );
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exitCode = 1;
});
