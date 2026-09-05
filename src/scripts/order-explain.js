// Why does this order have these dates?
//
//   node src/scripts/order-explain.js --order 8248635228258
//
// Read-only. Everything that feeds the decision, in the order it is consulted, so
// a questioned date can be traced to its input rather than guessed at:
//
//   0. configuration            the switches that decide the outcome
//   1. the Shopify order        what it carries now
//   2. the Loop subscription    its Delivery-Date — the only weekday Loop records
//   3. weekday resolution       which source won, and what it said
//   4. HDS availability         what was actually on offer for that suburb
//   5. both selection modes     what each rule would produce
//   6. the verdict              what would happen now, and what is blocking it
//   7. the queue row            what we recorded at the time
//
// Works with Loop alone; Shopify and Postgres sections are skipped if their
// credentials are absent.

require('dotenv').config();
const { getOrder, getNoteAttribute } = require('../shopify');
const { subscriptionContextForOrder, readSubscriptionByOrderId } = require('../loop');
const { scheduleFor, rewriteRenewalOrder, needsRewrite, locationFor, weekdayOf } = require('../lib/renewal-rewrite');
const { fillHdsRecords } = require('../lib/renewal-rewrite');
const { planFor } = require('../lib/apply-hds');

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

  // --- 0. the switches -------------------------------------------------------
  // Printed first because they decide the outcome, and because a value set on one
  // environment and not another is invisible from the order page. Most "no pack
  // date" reports come down to a line in here.
  heading(0, 'Configuration in this environment');
  const flag = (name, fallback) => {
    const raw = process.env[name];
    return raw === undefined || raw === '' ? `${fallback} (default)` : raw;
  };
  console.log(`   REWRITE_RENEWAL_DATES : ${flag('REWRITE_RENEWAL_DATES', 'true')}`);
  console.log(`   FILL_HDS_RECORDS      : ${flag('FILL_HDS_RECORDS', 'true')}`);
  console.log(`   FILL_HDS_ATTRIBUTES   : ${flag('FILL_HDS_ATTRIBUTES', 'all-missing')}`);
  console.log(`   HDS_API_BASE          : ${process.env.HDS_API_BASE || 'MISSING'}`);
  console.log(`   SHOPIFY_STORE         : ${process.env.SHOPIFY_STORE || 'MISSING'}`);

  if (String(process.env.REWRITE_RENEWAL_DATES || '').toLowerCase() === 'false') {
    console.log('');
    console.log('   WARNING: rewriting is stood down. A Loop renewal arrives carrying the');
    console.log("   subscription's FIRST-cycle dates, which are already in the past, so with");
    console.log('   this false those orders are HELD and never get a pack date. This is the');
    console.log('   most common cause of "no pack date on any renewal".');
  }

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
    const body = await res.text().catch(() => '');
    let data = null;
    try {
      data = body ? JSON.parse(body) : null;
    } catch {
      // Non-JSON: the base URL is not the HDS API.
    }

    // Report the failure and carry on: sections 5 and 6 are still worth printing,
    // and the queue row in 6 is often the most useful part when HDS is unreachable.
    const options = !data
      ? (console.log(`   HTTP ${res.status} and the body is not JSON — HDS_API_BASE is not the HDS API`),
         console.log(`   base tried: ${base}`),
         console.log(`   body      : ${body.replace(/\s+/g, ' ').slice(0, 120)}`),
         [])
      : data.success === false
        ? (console.log(`   HTTP ${res.status}  ${data.error || data.message}`), [])
        : (data.delivery_options || []).sort((a, b) => a.delivery_date.localeCompare(b.delivery_date));

    // With no options there is nothing to list, and printing an empty table under
    // an error reads as though HDS answered and had nothing — which is a different
    // problem from not having reached HDS at all.
    if (options.length) {
      console.log(`   region: ${data?.region?.name || '?'}  |  ${options.length} options`);
      console.log('   earliest 6:');
      for (const o of options.slice(0, 6)) {
        const mark =
          schedule.deliveryDay && o.delivery_day.toLowerCase() === schedule.deliveryDay.toLowerCase()
            ? ' <- their weekday'
            : '';
        console.log(
          `     ${o.delivery_date} ${o.delivery_day.padEnd(9)} pack ${o.pack_date}  sched ${String(o.schedule_id).padEnd(3)} cutoff ${o.cutoff_info}${mark}`
        );
      }
      if (schedule.deliveryDay) {
        const match = options.find((o) => o.delivery_day.toLowerCase() === schedule.deliveryDay.toLowerCase());
        console.log(`   first ${schedule.deliveryDay}: ${match ? `${match.delivery_date} (pack ${match.pack_date})` : 'NONE offered'}`);
        console.log(`   earliest any day: ${options[0].delivery_date} ${options[0].delivery_day} (pack ${options[0].pack_date})`);
      }
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
  // --- 6. the verdict --------------------------------------------------------
  // The point of the whole report. Everything above is inputs; this is what the
  // service would actually DO with this order right now, and — when the answer is
  // "nothing" — which switch is responsible. "No pack date" has several causes
  // that look identical on the order page, and guessing between them by reading
  // sections 1 to 5 was the slow part.
  heading(6, 'What would happen to this order now');

  const packNow = getNoteAttribute(order, 'Pick-Pack-Date');
  const plan = planFor(order);
  console.log(`   pack date now : ${packNow || 'NONE'}`);
  console.log(`   action        : ${plan.action} — ${plan.reason}`);

  if (plan.action === 'hold') {
    console.log('');
    console.log('   THIS IS WHY THERE IS NO PACK DATE.');
    console.log('   The delivery date has already passed, so a pack date cannot be derived');
    console.log('   from it, and REWRITE_RENEWAL_DATES=false forbids computing a new one.');
    console.log('');
    console.log('   Every Loop renewal arrives in this state: Loop copies the subscription');
    console.log("   attributes verbatim, so the order carries the FIRST cycle's dates, which");
    console.log('   are in the past by definition. With rewriting stood down, none of them');
    console.log('   can be given a pack date.');
    console.log('');
    console.log('   Fix: set REWRITE_RENEWAL_DATES=true, then re-run the backfill.');
  } else if (plan.action === 'fill') {
    const out = await fillHdsRecords(order, { dryRun: true, overwrite: true });
    if (out.ok) {
      console.log(`   would write   : Pick-Pack-Date ${out.attributes['Pick-Pack-Date']}`);
      console.log(`   from          : ${out.resolved.matched_by}`);
      console.log('');
      console.log('   The values are available, so a pack date is NOT blocked by data — if the');
      console.log('   order still has none, the write itself never ran or never landed.');
      console.log('   Check section 7: no queue row means the webhook never processed it.');
    } else {
      console.log('');
      console.log(`   THIS IS WHY THERE IS NO PACK DATE: ${out.reason}`);
      if (/no postcode and suburb/.test(out.reason)) {
        console.log('   The order has no shipping address and no HDS Postcode/Suburb, so there');
        console.log('   is nothing to look the schedule up by.');
      } else if (/no .* schedule/.test(out.reason)) {
        console.log('   HDS does not offer that weekday for this suburb, so the delivery date');
        console.log('   on the order cannot be matched to a schedule. Section 4 lists what it');
        console.log('   does offer.');
      }
    }
  } else if (plan.action === 'rewrite') {
    console.log('   Section 5 shows what the rewrite would write. If the order still has no');
    console.log('   pack date, the write never ran or never landed — check section 7.');
  } else {
    console.log('   Nothing to do: the dates are complete.');
  }

  heading(7, 'What we recorded at the time');
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
