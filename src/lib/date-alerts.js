// Tell admin when an order's delivery or pack date is wrong, or changes.
//
// Fed by the sweep (every few minutes, today's orders only). For each order it
// remembers the delivery date, pack date and problem it last saw, and emails ONE
// message per pass listing what is new since then:
//
//   PROBLEM  the order has no pack date, or its pack date is in the past /
//            not before delivery. Reported once per distinct problem, not on
//            every pass it stays broken.
//   CHANGED  the delivery date or pack date differs from last time — whether
//            this service fixed it or anyone else edited the order.
//
// Recipients are the same two lists the failure emails use: ALERT_EMAIL_TO and
// FAILURE_EMAIL_ADMINS. An order seen for the first time with nothing wrong is
// recorded silently, so a deploy does not announce every healthy order.

const { getNoteAttribute, normalizeDate } = require('../shopify');
const { packDateStaleness } = require('./apply-hds');
const mailer = require('./mailer');
const { orderUrl } = require('./order-notify');

function isEnabled() {
  return String(process.env.DATE_ALERT_EMAILS_ENABLED || 'true').toLowerCase() !== 'false';
}

function recipients() {
  const out = new Set(mailer.config().to || []);
  String(process.env.FAILURE_EMAIL_ADMINS || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .forEach((e) => out.add(e));
  return Array.from(out);
}

function tidy(value) {
  if (!value) return null;
  try {
    return normalizeDate(value) || String(value);
  } catch {
    return String(value);
  }
}

// What matters about an order, read from its own attributes (no API call).
function snapshotOf(order) {
  const pack = tidy(getNoteAttribute(order, 'Pick-Pack-Date') || getNoteAttribute(order, 'HDS Ship Date'));
  const delivery = tidy(getNoteAttribute(order, 'Delivery-Date') || getNoteAttribute(order, 'HDS Delivery Date'));

  let issue = null;
  if (!pack) issue = 'no pack date';
  else {
    const why = packDateStaleness(order);
    if (why) issue = why;
  }
  return { delivery, pack, issue };
}

// --- state: Postgres when available, memory otherwise -----------------------

function memoryStore() {
  const rows = new Map();
  return {
    async load(ids) {
      return new Map(ids.filter((id) => rows.has(String(id))).map((id) => [String(id), rows.get(String(id))]));
    },
    async save(entries) {
      for (const e of entries) rows.set(String(e.id), e.snap);
    },
  };
}

function dbStore() {
  const { pool } = require('../db');
  return {
    async load(ids) {
      if (!ids.length) return new Map();
      const { rows } = await pool.query(
        `SELECT order_id, delivery_date, pack_date, issue FROM order_date_watch WHERE order_id = ANY($1::bigint[])`,
        [ids]
      );
      return new Map(
        rows.map((r) => [String(r.order_id), { delivery: r.delivery_date, pack: r.pack_date, issue: r.issue }])
      );
    },
    async save(entries) {
      for (const { id, snap } of entries) {
        await pool.query(
          `INSERT INTO order_date_watch (order_id, delivery_date, pack_date, issue, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (order_id) DO UPDATE
             SET delivery_date = EXCLUDED.delivery_date, pack_date = EXCLUDED.pack_date,
                 issue = EXCLUDED.issue, updated_at = NOW()`,
          [id, snap.delivery, snap.pack, snap.issue]
        );
      }
    },
  };
}

const show = (v) => v || '(none)';
const MAX_ROWS = Number(process.env.DATE_ALERT_MAX_ROWS || 50);

function buildEmail(events) {
  const problems = events.filter((e) => e.type === 'PROBLEM');
  const changes = events.filter((e) => e.type === 'CHANGED');

  const lines = [];
  const link = (e) => {
    const url = orderUrl(e.id);
    return url ? `  ${url}` : null;
  };

  if (problems.length) {
    lines.push(`ORDERS WITH A MISSING OR PAST PACK DATE (${problems.length})`, '─'.repeat(70));
    for (const e of problems.slice(0, MAX_ROWS)) {
      lines.push(
        `${e.name}  —  ${e.snap.issue}`,
        `  delivery: ${show(e.snap.delivery)}   pack: ${show(e.snap.pack)}`
      );
      const l = link(e);
      if (l) lines.push(l);
      lines.push(`  fix: node src/scripts/order-fix.js --name ${e.name}${e.snap.pack ? ' --recompute' : ''}`, '');
    }
    if (problems.length > MAX_ROWS) lines.push(`…and ${problems.length - MAX_ROWS} more`, '');
  }

  if (changes.length) {
    lines.push(`ORDERS WHOSE DELIVERY OR PACK DATE CHANGED (${changes.length})`, '─'.repeat(70));
    for (const e of changes.slice(0, MAX_ROWS)) {
      lines.push(`${e.name}`);
      if (e.prev.delivery !== e.snap.delivery) {
        lines.push(`  delivery: ${show(e.prev.delivery)}  →  ${show(e.snap.delivery)}`);
      }
      if (e.prev.pack !== e.snap.pack) {
        lines.push(`  pack    : ${show(e.prev.pack)}  →  ${show(e.snap.pack)}`);
      }
      if (e.snap.issue) lines.push(`  still wrong: ${e.snap.issue}`);
      const l = link(e);
      if (l) lines.push(l);
      lines.push('');
    }
    if (changes.length > MAX_ROWS) lines.push(`…and ${changes.length - MAX_ROWS} more`, '');
  }

  lines.push(`Store: ${process.env.SHOPIFY_STORE || 'unknown'}`);
  return {
    subject: `[HDS] Order date alerts — ${problems.length} problem(s), ${changes.length} change(s)`,
    text: lines.join('\n'),
  };
}

function createDateWatch({ store = null, send = null, enabled = isEnabled } = {}) {
  let pending = [];
  let resolvedStore = store;
  const getStore = () => {
    if (!resolvedStore) resolvedStore = process.env.DATABASE_URL ? dbStore() : memoryStore();
    return resolvedStore;
  };
  const deliver =
    send ||
    (async ({ subject, text }) => {
      if (!mailer.isConfigured()) return { sent: false, reason: 'smtp not configured' };
      const to = recipients();
      if (!to.length) return { sent: false, reason: 'no recipients' };
      return mailer.sendMail({ subject, text, to });
    });

  return {
    // Remember an order to look at when flush() runs.
    observe(order) {
      if (order?.id) pending.push(order);
    },

    // Compare everything observed since the last flush with what was seen
    // before, send one email for what is new, then remember the current state.
    async flush() {
      const orders = pending;
      pending = [];
      if (!orders.length || !enabled()) return { events: 0 };

      try {
        const s = getStore();
        const prev = await s.load(orders.map((o) => o.id));

        const events = [];
        const entries = [];
        for (const order of orders) {
          const snap = snapshotOf(order);
          const p = prev.get(String(order.id));
          const name = order.name || String(order.id);
          entries.push({ id: order.id, snap });

          if (snap.issue && snap.issue !== p?.issue) {
            events.push({ type: 'PROBLEM', id: order.id, name, snap, prev: p || null });
          }
          if (p && (p.delivery !== snap.delivery || p.pack !== snap.pack)) {
            events.push({ type: 'CHANGED', id: order.id, name, snap, prev: p });
          }
        }

        if (events.length) {
          const result = await deliver(buildEmail(events));
          if (result?.sent) {
            console.log(`[date-alerts] emailed ${events.length} alert(s) to ${result.to.join(', ')}`);
          } else {
            console.warn(
              `[date-alerts] ${events.length} alert(s) NOT emailed (${result?.reason || 'unknown'}): ` +
                events.map((e) => `${e.name} [${e.type}]`).join(', ')
            );
            // A real send failure is retried next pass; "not configured" is not
            // going to fix itself by retrying, so it is logged above and moved on.
            if (result?.reason && !/not configured|no recipients/i.test(result.reason)) {
              return { events: events.length, sent: false };
            }
          }
        }

        await s.save(entries);
        return { events: events.length, sent: events.length > 0 };
      } catch (err) {
        // Notification trouble must never stop the sweep that called it.
        console.warn(`[date-alerts] failed: ${err.message || err}`);
        return { events: 0, error: err.message };
      }
    },
  };
}

module.exports = { createDateWatch, snapshotOf, buildEmail, isEnabled };
