// Update Loop subscription values from a LOCAL machine — no server, no public
// URL, no webhook, no database required.
//
// Everything this service does *towards* Loop is an outbound HTTPS call, so it
// works from anywhere with internet + LOOP_API_TOKEN. Only the inbound
// order/upcoming webhook needs a hosted URL; this script replaces it for manual
// / batch runs while Railway is unavailable.
//
// Usage
//   node src/scripts/loop-update.js --order 1234567890
//   node src/scripts/loop-update.js --order 1234567890 --dry-run --verbose
//   node src/scripts/loop-update.js --sub shopify-987 --postcode 2000 --suburb Sydney --charge-date 2026-08-14
//   node src/scripts/loop-update.js --order 1 --order 2 --offset 3
//   node src/scripts/loop-update.js --file ids.txt
//   node src/scripts/loop-update.js --sub shopify-987 --set hds_delivery_date=2026-08-14 --set hds_delivery_window="6am - 10am"
//
// Flags
//   --order <id>        Shopify order id; the Loop subscription is looked up from
//                       it. Repeatable.
//   --sub <id>          Loop subscription id ("shopify-987" or "987"), skipping
//                       the order lookup.
//   --file <path>       File of Shopify order ids, one per line (# comments ok).
//   --postcode <code>   Override the postcode used for the HDS lookup.
//   --suburb <name>     Override the suburb (HDS requires suburb + postcode).
//   --charge-date <iso> Override the charge date the delivery is derived from.
//   --window <text>     Preferred delivery window, e.g. "6am - 10am".
//   --set k=v           Write this attribute verbatim. Repeatable. When given,
//                       the HDS lookup is skipped entirely.
//   --offset <days>     Also PUT the subscription chargeOffset (HDS cutoff days).
//                       Use "auto" to take it from the order's "Charge Offset"
//                       attribute ("3 Days" → 3).
//   --dry-run           Resolve and print, write nothing.
//   --verbose           Print the raw Loop order-lookup response.
//   --audit             Record the attempt in loop_subscription_deliveries
//                       (needs DATABASE_URL).

require('dotenv').config();

const {
  readSubscriptionByOrderId,
  patchCustomAttributes,
  editChargeOffset,
} = require('../loop');
const { resolveRenewalDelivery, buildHdsAttributes } = require('../lib/renewal-date');

function parseArgs(argv) {
  const opts = { orders: [], sets: {} };
  const flagsWithValue = new Set([
    'order', 'sub', 'file', 'postcode', 'suburb', 'charge-date', 'window', 'set', 'offset',
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      // Bare numbers are treated as Shopify order ids.
      opts.orders.push(arg);
      continue;
    }

    let name = arg.slice(2);
    let value = null;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    } else if (flagsWithValue.has(name)) {
      value = argv[i + 1];
      i += 1;
    }

    switch (name) {
      case 'order': opts.orders.push(value); break;
      case 'sub': opts.sub = value; break;
      case 'file': opts.file = value; break;
      case 'postcode': opts.postcode = value; break;
      case 'suburb': opts.suburb = value; break;
      case 'charge-date': opts.chargeDate = value; break;
      case 'window': opts.window = value; break;
      case 'offset': opts.offset = value === 'auto' ? 'auto' : Number(value); break;
      case 'dry-run': opts.dryRun = true; break;
      case 'verbose': opts.verbose = true; break;
      case 'audit': opts.audit = true; break;
      case 'set': {
        const at = String(value || '').indexOf('=');
        if (at === -1) throw new Error(`--set needs key=value, got "${value}"`);
        opts.sets[value.slice(0, at)] = value.slice(at + 1);
        break;
      }
      case 'help': opts.help = true; break;
      default: throw new Error(`unknown flag --${name}`);
    }
  }
  return opts;
}

// Read the order ids out of a plain text file (one per line, # comments ignored).
function readIdFile(path) {
  const lines = require('fs').readFileSync(path, 'utf8').split(/\r?\n/);
  return lines
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

const first = (values) => values.find((v) => v !== undefined && v !== null && v !== '') ?? null;

// Pull subscription id, location and next charge date out of
// GET /orders/shopify-{id}.
//
// Confirmed against a real response: customAttributes sits on `data` (NOT on the
// subscription), carries the checkout extension's LABELLED keys ("HDS Postcode",
// "Charge Offset"), and `data.subscription` is an array whose entries hold
// shopifyId + nextBillingDate and no address. Older/other spellings are kept as
// fallbacks; run with --verbose if a value comes back empty.
function fromOrderLookup(res) {
  const data = res?.data || {};
  const order = data.order || data;
  const sub = (Array.isArray(data.subscription) ? data.subscription[0] : data.subscription) || {};
  const address =
    order.shippingAddress || order.shipping_address ||
    sub.shippingAddress || sub.shipping_address || {};

  const attributes = normaliseAttributes(
    data.customAttributes || data.custom_attributes ||
    order.customAttributes || order.custom_attributes ||
    sub.customAttributes || sub.custom_attributes
  );

  const attr = (names) => first(names.map((n) => attributes[n]));
  const rawId = first([sub.shopifyId, sub.shopify_id, sub.id]);

  return {
    subscriptionId: rawId ? normaliseSubId(rawId) : null,
    postcode: first([
      attr(['HDS Postcode', 'hds_postcode', 'Delivery-Location-Id']),
      address.zip, address.postcode, address.postalCode, address.postal_code,
    ]),
    suburb: first([attr(['HDS Suburb', 'hds_suburb']), address.city, address.suburb]),
    window: attr(['HDS Delivery Window', 'hds_delivery_window', 'Delivery-Time']),
    // "3 Days" → 3. Same parse as the Shopify webhook, so --offset auto pushes
    // the cutoff the checkout extension already stamped on the order.
    chargeOffset: parseOffset(attr(['Charge Offset', 'HDS Cutoff Days', 'hds_cutoff_days'])),
    chargeDateEpoch: first([sub.nextBillingDateEpoch, sub.next_billing_date_epoch]),
    chargeDateIso: first([sub.nextBillingDate, sub.next_billing_date]),
    attributes,
  };
}

function parseOffset(raw) {
  if (raw == null) return null;
  const match = String(raw).match(/\d+/);
  return match ? Number(match[0]) : null;
}

function normaliseSubId(value) {
  const s = String(value);
  return s.startsWith('shopify-') ? s : `shopify-${s}`;
}

function normaliseAttributes(value) {
  const out = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      const key = item?.key ?? item?.name;
      if (key) out[key] = item.value;
    }
  } else if (value && typeof value === 'object') {
    Object.assign(out, value);
  }
  return out;
}

// Audit row, mirroring what the webhook records. Optional: the DB is only
// touched when --audit is passed, so the script runs with LOOP_API_TOKEN alone.
async function audit({ subscriptionId, orderId, resolved, attributes, status, error }) {
  const { pool } = require('../db');
  await pool.query(
    `INSERT INTO loop_subscription_deliveries
       (subscription_id, charge_date, delivery_date, delivery_time,
        delivery_location_id, suburb, status, attempts, error_message, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9)
     ON CONFLICT (subscription_id, charge_date) DO UPDATE SET
       delivery_date        = EXCLUDED.delivery_date,
       delivery_time        = EXCLUDED.delivery_time,
       delivery_location_id = EXCLUDED.delivery_location_id,
       suburb               = EXCLUDED.suburb,
       status               = EXCLUDED.status,
       attempts             = loop_subscription_deliveries.attempts + 1,
       error_message        = EXCLUDED.error_message,
       payload              = EXCLUDED.payload,
       updated_at           = NOW()`,
    [
      String(subscriptionId).replace(/^shopify-/, ''),
      resolved?.charge_date || null,
      resolved?.delivery_date || attributes.hds_delivery_date || null,
      attributes.hds_delivery_window || null,
      resolved?.postcode || attributes.hds_postcode || null,
      resolved?.suburb || attributes.hds_suburb || null,
      status,
      error,
      { source: 'loop-update.js', orderId: orderId || null, attributes },
    ]
  );
  await pool.end();
}

// One subscription: resolve the values, then write them.
async function runOne(target, opts) {
  const label = target.orderId ? `order ${target.orderId}` : `subscription ${target.sub}`;
  let subscriptionId = target.sub ? normaliseSubId(target.sub) : null;
  let context = {};

  if (target.orderId) {
    const res = await readSubscriptionByOrderId(target.orderId);
    if (opts.verbose) console.log(`\n--- raw GET /orders/shopify-${target.orderId} ---\n${JSON.stringify(res, null, 2)}`);
    context = fromOrderLookup(res);
    subscriptionId = subscriptionId || context.subscriptionId;
    if (!subscriptionId) {
      throw new Error(`${label}: no Loop subscription on this order (one-time purchase?) — re-run with --verbose to inspect the payload`);
    }
  }

  if (!subscriptionId) throw new Error('need --order or --sub');

  // Manual mode: --set values are written verbatim, no HDS lookup.
  const manual = Object.keys(opts.sets).length > 0;
  let attributes = opts.sets;
  let resolved = null;

  if (!manual) {
    const postcode = first([opts.postcode, context.postcode]);
    const suburb = first([opts.suburb, context.suburb]);
    if (!postcode) throw new Error(`${label}: no postcode — pass --postcode`);
    // The HDS public API requires BOTH suburb and postcode; a postcode alone
    // comes back 400, so fail here with a message that says what to do.
    if (!suburb) throw new Error(`${label}: no suburb — pass --suburb (the HDS API requires suburb + postcode)`);

    const result = await resolveRenewalDelivery({
      postcode,
      suburb,
      chargeDateEpoch: opts.chargeDate ? null : context.chargeDateEpoch,
      chargeDateIso: opts.chargeDate || context.chargeDateIso,
    });
    if (!result.ok) throw new Error(`${label}: ${result.reason}`);

    resolved = result.data;
    attributes = buildHdsAttributes(resolved, first([opts.window, context.window]));
  }

  // --offset auto: reuse the cutoff the order already carries as "Charge Offset".
  const offset = opts.offset === 'auto' ? context.chargeOffset : opts.offset;
  if (opts.offset === 'auto' && offset == null) {
    console.warn(`  ! ${label}: --offset auto but the order carries no "Charge Offset" — skipping chargeOffset`);
  }

  console.log(`\n${label} → ${subscriptionId}`);
  if (resolved) console.log(`  charge ${resolved.charge_date} → delivery ${resolved.delivery_date} (${resolved.region || 'region ?'} / ${resolved.suburb || '?'})`);
  for (const [k, v] of Object.entries(attributes)) {
    if (v !== null && v !== undefined && v !== '') console.log(`  ${k} = ${v}`);
  }
  if (Number.isFinite(offset)) console.log(`  chargeOffset = ${offset}`);

  if (opts.dryRun) {
    console.log('  [dry-run] nothing written');
    return { subscriptionId, attributes, resolved, written: false };
  }

  await patchCustomAttributes(subscriptionId, attributes);
  console.log('  ✓ custom attributes written (PATCH, existing keys preserved)');

  if (Number.isFinite(offset)) {
    await editChargeOffset(subscriptionId, offset);
    console.log(`  ✓ chargeOffset = ${offset}`);
  }

  return { subscriptionId, attributes, resolved, written: true };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help || (!opts.orders.length && !opts.sub && !opts.file)) {
    console.log(require('fs').readFileSync(__filename, 'utf8').split('\n')
      .filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(opts.help ? 0 : 1);
  }

  if (!process.env.LOOP_API_TOKEN) {
    console.error('LOOP_API_TOKEN is not set (add it to .env)');
    process.exit(1);
  }

  console.log('LOOP_API_BASE:', process.env.LOOP_API_BASE || '(default 2023-10)');
  console.log('HDS_API_BASE :', process.env.HDS_API_BASE || '(not set — needed unless using --set)');

  const orderIds = [...opts.orders, ...(opts.file ? readIdFile(opts.file) : [])];
  const targets = orderIds.length
    ? orderIds.map((orderId) => ({ orderId }))
    : [{ sub: opts.sub }];

  let ok = 0;
  const failures = [];

  for (const target of targets) {
    try {
      const result = await runOne(target, opts);
      ok += 1;
      if (opts.audit && result.written) {
        await audit({ ...result, orderId: target.orderId, status: 'written', error: null });
      }
    } catch (err) {
      failures.push(err.message);
      console.error(`  ✗ ${err.message}`);
    }
  }

  console.log(`\nDone: ${ok} succeeded, ${failures.length} failed (of ${targets.length}).`);
  // exitCode rather than exit(): the API throttle can still hold a pending timer,
  // and tearing that down mid-flight trips a libuv assertion on Windows.
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exitCode = 1;
});
