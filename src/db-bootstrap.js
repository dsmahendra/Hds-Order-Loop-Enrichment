// Apply the schema at boot.
//
// db/schema.sql is written to be idempotent — every statement is CREATE/ALTER
// ... IF NOT EXISTS — so running it on every start is safe and costs
// milliseconds. It is done here because the alternative bit: a column added to
// the INSERT in the webhook handler is a HARD dependency, and a deploy that
// forgot `npm run migrate` would fail every queue write with "column does not
// exist" until someone noticed. Nothing about the pipeline should depend on
// remembering a manual step.
//
// Failure is not fatal. The service's own writes onto Shopify orders — the pack
// dates — do not need our tables at all, so a database problem must not stop the
// orders being fixed.

const fs = require('fs');
const path = require('path');

async function applySchema() {
  if (!process.env.DATABASE_URL) {
    console.log('[schema] skipped: no DATABASE_URL');
    return false;
  }
  if (String(process.env.AUTO_MIGRATE || 'true').toLowerCase() === 'false') {
    console.log('[schema] skipped (AUTO_MIGRATE=false) — run `npm run migrate` by hand');
    return false;
  }

  try {
    const { pool } = require('./db');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('[schema] up to date');
    return true;
  } catch (err) {
    console.error(
      `[schema] could not apply db/schema.sql — ${err.message}\n` +
        '  -> the queue and the retry job may not work until this is fixed\n' +
        '  -> writes onto Shopify orders are unaffected'
    );
    return false;
  }
}

module.exports = { applySchema };
