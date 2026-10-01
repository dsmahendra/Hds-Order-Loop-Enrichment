// A per-order audit trail: what the checkout sent, and every change the backend
// made to the order afterwards, with the before and after of each value.
//
// Written to Postgres (order_audit_log) so it can be read back for any order with
// `npm run order:audit -- --name WM146416`, and echoed as one [audit] line to the
// service log. Best effort throughout: auditing must never break order handling,
// so a DB problem is logged once and the order carries on.
//
// Stages:
//   checkout_received  the order exactly as the webhook received it (all
//                      attributes), i.e. what came through checkout
//   backend_write      one write the backend made to the order: attributes added,
//                      changed and removed (from -> to), plus tag changes. This
//                      is recorded inside shopify.updateOrderAttributes, so it
//                      covers the webhook, the rewrite/fill, the sweep, the
//                      retry job and order-fix alike
//   sweep_check        the order as the sweep's one check found it (all
//                      attributes) and the verdict — what was actually on the
//                      order a few minutes later, after every writer had run
//   backend_failed     a fix attempt (webhook or sweep) that could not complete

const { AsyncLocalStorage } = require('node:async_hooks');

const store = new AsyncLocalStorage();

// Who is doing the work, for everything that happens below this call in the same
// async chain. Set once at the top of a webhook, a job tick or a script.
function setSource(name) {
  store.enterWith({ source: name });
}
const currentSource = () => store.getStore()?.source || 'unknown';

const norm = (n) =>
  String(n || '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');

const asMap = (list) => {
  const m = new Map();
  for (const a of Array.isArray(list) ? list : []) {
    if (a?.name) m.set(norm(a.name), { name: a.name, value: a.value == null ? '' : String(a.value) });
  }
  return m;
};

// Attributes as a plain { name: value } object, for storing.
function attributesObject(list) {
  const out = {};
  for (const a of Array.isArray(list) ? list : []) if (a?.name) out[a.name] = a.value == null ? '' : String(a.value);
  return out;
}

// What changed between two attribute lists (Shopify's [{name, value}] shape).
function diffAttributes(before, after) {
  const b = asMap(before);
  const a = asMap(after);
  const added = [];
  const changed = [];
  const removed = [];
  for (const [key, cur] of a) {
    const prev = b.get(key);
    if (!prev) added.push({ name: cur.name, value: cur.value });
    else if (prev.value !== cur.value) changed.push({ name: cur.name, from: prev.value, to: cur.value });
  }
  for (const [key, prev] of b) if (!a.has(key)) removed.push({ name: prev.name, value: prev.value });
  return { added, changed, removed };
}

function splitTags(tags) {
  return String(tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function diffTags(before, after) {
  const b = new Set(splitTags(before));
  const a = new Set(splitTags(after));
  return {
    added: [...a].filter((t) => !b.has(t)),
    removed: [...b].filter((t) => !a.has(t)),
  };
}

let dbWarned = false;
async function insert({ orderId, orderName, stage, source, detail }) {
  if (!process.env.DATABASE_URL) return;
  try {
    const { pool } = require('../db');
    await pool.query(
      `INSERT INTO order_audit_log (order_id, order_name, stage, source, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [orderId, orderName || null, stage, source, JSON.stringify(detail || {})]
    );
  } catch (err) {
    if (!dbWarned) {
      dbWarned = true;
      console.warn(`[audit] could not write the audit log (further errors suppressed): ${err.message}`);
    }
  }
}

function summary(stage, detail) {
  if (stage === 'backend_write') {
    const c = detail.attributes || {};
    return (
      `+${(c.added || []).length} ~${(c.changed || []).length} -${(c.removed || []).length} attributes` +
      (detail.tags && (detail.tags.added.length || detail.tags.removed.length)
        ? `, tags +${detail.tags.added.length} -${detail.tags.removed.length}`
        : '')
    );
  }
  if (stage === 'sweep_check') return detail.verdict || '';
  if (stage === 'backend_failed') return detail.reason || '';
  if (stage === 'checkout_received') return `${Object.keys(detail.attributes || {}).length} attributes`;
  return '';
}

// Never throws. Safe to call without await.
async function record({ order = null, orderId = null, orderName = null, stage, source = null, detail = {} }) {
  try {
    const id = orderId || order?.id;
    if (!id) return;
    const name = orderName || order?.name || null;
    const src = source || currentSource();
    console.log(`[audit] ${name || id} ${stage} via ${src}: ${summary(stage, detail)}`);
    await insert({ orderId: id, orderName: name, stage, source: src, detail });
  } catch (err) {
    console.warn(`[audit] failed: ${err.message || err}`);
  }
}

// The order exactly as the webhook received it.
const recordCheckout = (order, extra = {}) =>
  record({
    order,
    stage: 'checkout_received',
    detail: {
      attributes: attributesObject(order?.note_attributes),
      tags: order?.tags || '',
      created_at: order?.created_at || null,
      ...extra,
    },
  });

// One write the backend made, as a before/after.
const recordWrite = ({ order, existing, afterAttributes, afterTags }) =>
  record({
    orderId: order?.id || existing?.id,
    orderName: existing?.name || order?.name,
    stage: 'backend_write',
    detail: {
      attributes: diffAttributes(existing?.note_attributes, afterAttributes),
      tags: afterTags === undefined ? { added: [], removed: [] } : diffTags(existing?.tags, afterTags),
    },
  });

// The order as one check found it.
const recordCheck = (order, verdict, extra = {}) =>
  record({
    order,
    stage: 'sweep_check',
    detail: { verdict, attributes: attributesObject(order?.note_attributes), tags: order?.tags || '', ...extra },
  });

// Old audit rows are dropped so the table cannot grow without bound.
async function prune() {
  if (!process.env.DATABASE_URL) return;
  const days = Number(process.env.AUDIT_RETENTION_DAYS || 60);
  if (!(days > 0)) return;
  try {
    const { pool } = require('../db');
    await pool.query(`DELETE FROM order_audit_log WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`, [days]);
  } catch {
    // Housekeeping only.
  }
}

module.exports = {
  setSource,
  currentSource,
  record,
  recordCheckout,
  recordWrite,
  recordCheck,
  diffAttributes,
  diffTags,
  attributesObject,
  prune,
};
