// What did the service actually record for recent orders?
//
//   node src/scripts/orders-recent.js            # last 10 queued orders
//   node src/scripts/orders-recent.js --limit 25
//   node src/scripts/orders-recent.js --order 8215626678370
//
// Read-only. Run it on the Railway shell to tell apart the three ways the
// orders/create path can fail silently:
//
//   no row at all        -> the webhook never ran: HMAC rejected (401), Shopify
//                           never delivered, or the tables don't exist yet
//   row, subscription_id NULL -> webhook ran, Loop lookup failed (ingest lag or
//                           wrong LOOP_API_BASE/token)
//   row, subscription_id set  -> lookup worked; the offset push either succeeded
//                           or the order carried no "Charge Offset" attribute
//                           (check source_attributes)

require('dotenv').config();
const { pool } = require('../db');

function parseArgs(argv) {
  const opts = { limit: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') opts.limit = Number(argv[i + 1] || 10);
    else if (argv[i] === '--order') opts.order = argv[i + 1];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — run this where the service runs (e.g. the Railway shell).');
    process.exitCode = 1;
    return;
  }

  const { rows } = opts.order
    ? await pool.query(
        `SELECT * FROM orders_to_enrich WHERE order_id = $1`,
        [opts.order]
      )
    : await pool.query(
        `SELECT * FROM orders_to_enrich ORDER BY id DESC LIMIT $1`,
        [opts.limit]
      );

  if (!rows.length) {
    console.log(
      opts.order
        ? `No row for order ${opts.order}. The orders/create webhook never reached the handler —\n` +
          'check Shopify → Settings → Notifications → Webhooks for failed deliveries, and the\n' +
          'Railway Console for "[webhook] HMAC verification failed".'
        : 'orders_to_enrich is empty — no webhook has ever been processed.'
    );
    return;
  }

  for (const r of rows) {
    const attrs = r.source_attributes || {};
    console.log(`\n--- order ${r.order_id} ---`);
    console.log(`  created         : ${r.created_at?.toISOString?.() || r.created_at}`);
    console.log(`  source / status : ${r.source || '?'} / ${r.status}   (attempts ${r.attempts})`);
    console.log(`  delivery_date   : ${r.delivery_date ? String(r.delivery_date).slice(0, 10) : '(none)'}`);
    console.log(`  postcode/suburb : ${r.delivery_location_id || '?'} / ${r.suburb || '?'}`);
    console.log(`  subscription_id : ${r.subscription_id || '(not resolved — Loop lookup failed)'}`);
    console.log(`  hds_* attrs     : ${Object.keys(attrs).length ? Object.keys(attrs).join(', ') : '(none — order had no HDS note attributes)'}`);
    if (r.error_message) console.log(`  error           : ${r.error_message}`);
  }

  const { rows: counts } = await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM orders_to_enrich GROUP BY status ORDER BY n DESC`
  );
  console.log(`\nTotals by status: ${counts.map((c) => `${c.status}=${c.n}`).join('  ') || '(none)'}`);
}

main()
  .catch((err) => {
    if (/relation .* does not exist/i.test(err.message)) {
      console.error(
        `Tables are missing: ${err.message}\n` +
        'Run `npm run migrate` once against this database — the start command never applies the schema.'
      );
    } else {
      console.error('ERROR:', err.message);
    }
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => {}));
