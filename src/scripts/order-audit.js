// Show the audit trail for one order: what came through checkout, and every
// change the backend made afterwards.
//
//   node src/scripts/order-audit.js --name WM146416
//   node src/scripts/order-audit.js --order 18915999121451
//   node src/scripts/order-audit.js --name WM146416 --all     # every attribute, not just dates
//
// Read-only. Reads the order_audit_log table, so it needs DATABASE_URL (run it on
// the Railway shell) and does not call Shopify.

require('dotenv').config();
const { pool } = require('../db');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : undefined;
};
const wantsAll = args.includes('--all');

// The attributes that decide delivery and packing. Everything else is hidden
// unless --all is given, so the timeline stays readable.
const KEY = /^(delivery[-_ ]|pick[-_ ]pack|hds[-_ ]|charge[-_ ]offset|checkout[-_ ]method)/i;
const interesting = (name) => wantsAll || KEY.test(name);

const stamp = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 19) + 'Z';

function printAttributes(attrs) {
  const names = Object.keys(attrs || {}).filter(interesting).sort();
  if (!names.length) return console.log('      (no delivery/pack attributes)');
  for (const n of names) console.log(`      ${n.padEnd(24)} ${attrs[n] || '(empty)'}`);
}

function printWrite(detail) {
  const a = detail.attributes || {};
  const t = detail.tags || { added: [], removed: [] };
  const added = (a.added || []).filter((x) => interesting(x.name));
  const changed = (a.changed || []).filter((x) => interesting(x.name));
  const removed = (a.removed || []).filter((x) => interesting(x.name));
  if (!added.length && !changed.length && !removed.length && !t.added.length && !t.removed.length) {
    return console.log('      (no change to delivery/pack values)');
  }
  for (const x of added) console.log(`      + ${x.name.padEnd(24)} ${x.value}`);
  for (const x of changed) console.log(`      ~ ${x.name.padEnd(24)} ${x.from || '(empty)'}  →  ${x.to}`);
  for (const x of removed) console.log(`      - ${x.name.padEnd(24)} ${x.value}   (removed)`);
  if (t.added.length) console.log(`      tags added  : ${t.added.join(', ')}`);
  if (t.removed.length) console.log(`      tags removed: ${t.removed.join(', ')}`);
}

// A value by label, looking at either spelling checkout and the backend use.
function pick(attrs, names) {
  const wanted = names.map((n) => n.toLowerCase().replace(/[-\s]/g, '_'));
  for (const [k, v] of Object.entries(attrs || {})) {
    if (wanted.includes(k.toLowerCase().replace(/[-\s]/g, '_')) && v) return v;
  }
  return null;
}

async function main() {
  const name = flag('name');
  const id = flag('order');
  if (!name && !id) {
    console.error('Usage: node src/scripts/order-audit.js (--name WM146416 | --order <shopifyOrderId>) [--all]');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — the audit trail lives in Postgres. Run this on the Railway shell.');
    process.exit(1);
  }

  const { rows } = await pool.query(
    name
      ? `SELECT * FROM order_audit_log WHERE order_name = $1 ORDER BY created_at, id`
      : `SELECT * FROM order_audit_log WHERE order_id = $1 ORDER BY created_at, id`,
    [name || id]
  );

  if (!rows.length) {
    console.log(`No audit entries for ${name || id}.`);
    console.log('Either it predates the audit log, or the webhook never delivered it (see orders-recent.js).');
    return;
  }

  console.log(`\nAudit trail for ${rows[0].order_name || rows[0].order_id} (order ${rows[0].order_id})\n`);

  for (const r of rows) {
    console.log(`${stamp(r.created_at)}  ${r.stage}  [${r.source}]`);
    const d = r.detail || {};
    if (r.stage === 'checkout_received') {
      console.log('    what checkout sent:');
      printAttributes(d.attributes);
      if (d.tags) console.log(`      tags: ${d.tags}`);
    } else if (r.stage === 'backend_write') {
      console.log('    what the backend changed:');
      printWrite(d);
    } else if (r.stage === 'sweep_check') {
      console.log(`    verdict: ${d.verdict}`);
      console.log('    order at the time of the check:');
      printAttributes(d.attributes);
    } else if (r.stage === 'backend_failed') {
      console.log(`    could not complete: ${d.reason}${d.was ? `   (was: ${d.was})` : ''}`);
    }
    console.log('');
  }

  // The one-glance answer: first thing checkout sent vs the last known state.
  const first = rows.find((r) => r.stage === 'checkout_received');
  const lastCheck = [...rows].reverse().find((r) => r.stage === 'sweep_check');
  if (first && lastCheck) {
    const f = first.detail.attributes;
    const l = lastCheck.detail.attributes;
    console.log('Checkout vs after the check:');
    for (const [label, names] of [
      ['delivery date', ['Delivery-Date', 'HDS Delivery Date', 'hds_delivery_date']],
      ['pack date', ['Pick-Pack-Date', 'HDS Ship Date', 'hds_pack_date']],
    ]) {
      const a = pick(f, names);
      const b = pick(l, names);
      console.log(`  ${label.padEnd(14)} ${a || '(none)'}  →  ${b || '(none)'}${a !== b ? '   ← changed' : ''}`);
    }
    console.log('');
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('audit failed:', err.message || err);
    process.exit(1);
  });
