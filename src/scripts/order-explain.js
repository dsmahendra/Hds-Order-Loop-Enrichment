// Why does this order have these dates?
//
//   node src/scripts/order-explain.js --order 8248635228258
//
// Read-only. Everything that feeds the decision, in the order it is consulted, so
// a questioned date can be traced to its input rather than guessed at:
//
//   1. the Shopify order        what it carries now
//   2. the Loop subscription    its Delivery-Date — the only weekday Loop records
//   3. weekday resolution       which source won, and what it said
//   4. HDS availability         what was actually on offer for that suburb
//   5. both selection modes     what each rule would produce
//   6. the queue row            what we recorded at the time
//
// Works with Loop alone; Shopify and Postgres sections are skipped if their
// credentials are absent.

require('dotenv').config();
const { getOrder, getNoteAttribute } = require('../shopify');
const { subscriptionContextForOrder, readSubscriptionByOrderId } = require('../loop');
const { scheduleFor, rewriteRenewalOrder, needsRewrite, locationFor, weekdayOf } = require('../lib/renewal-rewrite');

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--order') opts.order = argv[++i];
    else if (!argv[i].startsWith('--')) opts.order = argv[i];
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  return opts;
}

const heading = (n, text) => console.log(`\n${n}. ${text}\n${'-'.repeat(text.length + 3)}`);
// Annotate only values that really are dates — "2170" would otherwise parse as a
// year and come back labelled with a weekday.
const dayOf = (v) => {
  const s = String(v == null ? '' : v);
  if (!/^\d{4}[-/]\d{2}[-/]\d{2}/.test(s)) return null;
  return weekdayOf(s.slice(0, 10).replace(/\//g, '-'));
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.order) {
    console.error('Usage: node src/scripts/order-explain.js --order <shopifyOrderId>');
    process.exitCode = 1;
    return;
  }

  console.log(`Explaining order ${opts.order}`);

  // --- 1. the Shopify order --------------------------------------------------
  heading(1, 'The Shopify order');
  let order = null;
  try {
    order = (await getOrder(opts.order))?.order;
    console.log(`   ${order.name}  created ${order.created_at}  (${dayOf(order.created_at)})`);
    console.log('   note attributes now on the order:');
    for (const a of order.note_attributes || []) {
      const d = dayOf(a.value);
      console.log(`     ${String(a.name).padEnd(24)} = ${String(a.value).padEnd(22)}${d ? `(${d})` : ''}`);
    }
  } catch (err) {
    console.log(`   (skipped: ${err.message.split('\n')[0]})`);
  }

  // --- 2. the Loop subscription ---------------------------------------------
  heading(2, 'The Loop subscription');
  let context = null;
  try {
    context = await subscriptionContextForOrder(opts.order);
    if (!context) {
      console.log('   no subscription attached to this order (one-time purchase?)');
    } else {
      console.log(`   ${context.subscriptionId}`);
      console.log(`   chargeOffset ${context.chargeOffset}  |  completed cycles ${context.completedOrdersCount}` +
                  `  |  ${JSON.stringify(context.deliveryPolicy)}`);
      if (context.nextBillingDateEpoch) {
        const next = new Date(context.nextBillingDateEpoch * 1000);
        console.log(`   next billing ${next.toISOString().slice(0, 10)} (${weekdayOf(next.toISOString())})`);
      }
      console.log('   subscription attributes — Loop stamps these onto every renewal:');
      const keys = Object.keys(context.attributes);
      if (!keys.length) console.log('     (none)');
      for (const k of keys) {
        const d = dayOf(context.attributes[k]);
        console.log(`     ${k.padEnd(24)} = ${String(context.attributes[k]).padEnd(22)}${d ? `(${d})` : ''}`);
      }
    }
  } catch (err) {
    console.log(`   (failed: ${err.message.split('\n')[0]})`);
  }

  // Fall back to Loop's copy of the order when Shopify is unavailable.
  if (!order) {
    try {
      const res = await readSubscriptionByOrderId(opts.order);
      const d = res?.data || {};
      order = {
        id: opts.order,
        created_at: d.shopifyCreatedAt,
        note_attributes: (d.customAttributes || []).map((a) => ({ name: a.key, value: a.value })),
        shipping_address: null,
      };
      console.log(`\n   (using Loop's copy of the order; created ${order.created_at})`);
    } catch {
      console.log('\n   could not read the order from Shopify or Loop — stopping here.');
      process.exitCode = 1;
      return;
    }
  }

  // --- 3. weekday resolution -------------------------------------------------
  heading(3, 'Which weekday the renewal is held to');
  const schedule = scheduleFor(order, context?.attributes || null);
  console.log(`   delivery day : ${schedule.deliveryDay || '(none found)'}`);
  console.log(`   taken from   : ${schedule.derivedFrom}`);
  console.log(`   schedule id on the order: ${schedule.scheduleId || 'none'} (read for reference; it no longer constrains the search)`);

  const state = needsRewrite(order);
  console.log(`   stale?       : ${state.stale ? 'YES' : 'no'} — ${state.reason}`);

  // A "not stale" verdict on a renewal usually means we already rewrote it: the
  // order now holds our corrected date, not the one Loop stamped. Say so, or the
  // verdict reads as though nothing was ever wrong.
  if (!state.stale && getNoteAttribute(order, 'Pick-Pack-Date')) {
    console.log('   note         : this order already carries Pick-Pack-Date, so the rewrite has run —');
    console.log('                  the date above is our output, not what Loop originally stamped.');
  }

  // --- 4. HDS availability ---------------------------------------------------
  heading(4, 'What HDS was offering');
  const loc = locationFor(order);
  const postcode = loc.postcode || context?.attributes?.['Delivery-Location-Id'] || null;
  const suburb = loc.suburb || null;
  console.log(`   suburb / postcode: ${suburb || '?'} / ${postcode || '?'}`);

  if (postcode && suburb) {
    const base = (process.env.HDS_API_BASE || '').replace(/\/+$/, '');
    const url = `${base}/api/public/delivery-options?postcode=${encodeURIComponent(postcode)}&suburb=${encodeURIComponent(suburb)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await res.json().catch(() => null);
    const options = (data?.delivery_options || []).sort((a, b) => a.delivery_date.localeCompare(b.delivery_date));

    console.log(`   region: ${data?.region?.name || '?'}  |  ${options.length} options`);
    console.log('   earliest 6:');
    for (const o of options.slice(0, 6)) {
      const mark = schedule.deliveryDay && o.delivery_day.toLowerCase() === schedule.deliveryDay.toLowerCase() ? ' <- their weekday' : '';
      console.log(`     ${o.delivery_date} ${o.delivery_day.padEnd(9)} pack ${o.pack_date}  sched ${String(o.schedule_id).padEnd(3)} cutoff ${o.cutoff_info}${mark}`);
    }
    if (schedule.deliveryDay) {
      const match = options.find((o) => o.delivery_day.toLowerCase() === schedule.deliveryDay.toLowerCase());
      console.log(`   first ${schedule.deliveryDay}: ${match ? `${match.delivery_date} (pack ${match.pack_date})` : 'NONE offered'}`);
      console.log(`   earliest any day: ${options[0]?.delivery_date} ${options[0]?.delivery_day} (pack ${options[0]?.pack_date})`);
    }
  } else {
    console.log('   (cannot query HDS without both suburb and postcode)');
  }

  // --- 5. both selection modes ----------------------------------------------
  heading(5, 'What each rule would write');
  const saved = process.env.RENEWAL_DELIVERY_SELECTION;
  for (const mode of ['keep-weekday', 'earliest']) {
    process.env.RENEWAL_DELIVERY_SELECTION = mode;
    const out = await rewriteRenewalOrder(order, { dryRun: true, subscriptionAttributes: context?.attributes || null });
    const active = (saved || 'keep-weekday') === mode ? '  <- ACTIVE' : '';
    if (!out.ok) {
      console.log(`   ${mode.padEnd(13)} FAILS: ${out.reason}${active}`);
      continue;
    }
    const a = out.attributes;
    console.log(
      `   ${mode.padEnd(13)} delivery ${a['Delivery-Date']} (${a['HDS Delivery Day']})` +
      `  pick-pack ${a['Pick-Pack-Date']}  cutoff ${a['HDS Cutoff Date']}  offset ${a['Charge Offset']}${active}`
    );
  }
  if (saved === undefined) delete process.env.RENEWAL_DELIVERY_SELECTION;
  else process.env.RENEWAL_DELIVERY_SELECTION = saved;

  // --- 6. the queue row -----------------------------------------------------
  heading(6, 'What we recorded at the time');
  if (!process.env.DATABASE_URL) {
    console.log('   (no DATABASE_URL — run on the Railway shell to see this)');
    return;
  }
  const { pool } = require('../db');
  try {
    const { rows } = await pool.query('SELECT * FROM orders_to_enrich WHERE order_id = $1', [opts.order]);
    if (!rows.length) {
      console.log('   no queue row — the orders/create webhook never processed this order');
    } else {
      const r = rows[0];
      console.log(`   status ${r.status} (${r.source})  attempts ${r.attempts}`);
      console.log(`   delivery_date   : ${r.delivery_date ? String(r.delivery_date).slice(0, 10) : '(none)'}`);
      if (r.previous_delivery_date) console.log(`   arrived with    : ${String(r.previous_delivery_date).slice(0, 10)}`);
      if (r.rewrite_schedule_source) console.log(`   weekday from    : ${r.rewrite_schedule_source}`);
      if (r.rewrite_matched_by) console.log(`   matched on      : ${r.rewrite_matched_by}`);
      if (r.error_message) console.log(`   error           : ${r.error_message}`);
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exitCode = 1;
});
