// One check per order, and one email about what that check found.
//
// The sweep looks at an order ONCE, the first pass after it is old enough
// (SWEEP_MIN_AGE_MINUTES, default 5). This module is what makes "once" true: it
// remembers every order that has been checked, so later passes skip it entirely.
// It also turns that single check into one email:
//
//   STILL WRONG  after any automatic fix, the order has no pack date, or its
//                pack date is in the past / not before delivery
//   AUTO-FIXED   it had one of those problems and the sweep corrected it
//   CHANGED      the check altered the delivery or pack date on an order that
//                was not flagged as wrong (e.g. a stale value replaced)
//
// Healthy orders are recorded silently. Recipients are the same two lists the
// failure emails use: ALERT_EMAIL_TO and FAILURE_EMAIL_ADMINS.

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

// --- "already checked" state: Postgres when available, memory otherwise -----

function memoryStore() {
  const rows = new Map();
  return {
    async checked(ids) {
      return new Set(ids.map(String).filter((id) => rows.has(id)));
    },
    async save(entries) {
      for (const e of entries) rows.set(String(e.id), e.snap);
    },
  };
}

function dbStore() {
  const { pool } = require('../db');
  return {
    async checked(ids) {
      if (!ids.length) return new Set();
      const { rows } = await pool.query(
        `SELECT order_id FROM order_date_watch WHERE order_id = ANY($1::bigint[])`,
        [ids]
      );
      return new Set(rows.map((r) => String(r.order_id)));
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
  const wrong = events.filter((e) => e.type === 'STILL_WRONG');
  const fixed = events.filter((e) => e.type === 'AUTO_FIXED');
  const changed = events.filter((e) => e.type === 'CHANGED');

  const lines = [];
  const section = (title, list, render) => {
    if (!list.length) return;
    lines.push(`${title} (${list.length})`, '─'.repeat(70));
    for (const e of list.slice(0, MAX_ROWS)) {
      lines.push(...render(e));
      const url = orderUrl(e.id);
      if (url) lines.push(`  ${url}`);
      lines.push('');
    }
    if (list.length > MAX_ROWS) lines.push(`…and ${list.length - MAX_ROWS} more`, '');
  };

  section('STILL WRONG AFTER THE AUTOMATIC CHECK — needs a manual fix', wrong, (e) => [
    `${e.name}  —  ${e.after.issue}`,
    `  delivery: ${show(e.after.delivery)}   pack: ${show(e.after.pack)}`,
    `  fix: node src/scripts/order-fix.js --name ${e.name}${e.after.pack ? ' --recompute' : ''}`,
  ]);

  section('AUTO-FIXED', fixed, (e) => [
    `${e.name}  —  was: ${e.before.issue}`,
    `  pack    : ${show(e.before.pack)}  →  ${show(e.after.pack)}`,
    `  delivery: ${show(e.before.delivery)}  →  ${show(e.after.delivery)}`,
  ]);

  section('DELIVERY OR PACK DATE CHANGED BY THE CHECK', changed, (e) => {
    const out = [`${e.name}`];
    if (e.before.delivery !== e.after.delivery) {
      out.push(`  delivery: ${show(e.before.delivery)}  →  ${show(e.after.delivery)}`);
    }
    if (e.before.pack !== e.after.pack) {
      out.push(`  pack    : ${show(e.before.pack)}  →  ${show(e.after.pack)}`);
    }
    return out;
  });

  lines.push(`Each order is checked once, about ${process.env.SWEEP_MIN_AGE_MINUTES || 5} minutes after it is created.`);
  lines.push(`Store: ${process.env.SHOPIFY_STORE || 'unknown'}`);

  return {
    subject: `[HDS] Order date check — ${wrong.length} still wrong, ${fixed.length} auto-fixed, ${changed.length} changed`,
    text: lines.join('\n'),
  };
}

// ephemeral: remember nothing between runs and send nothing — for a manual run of
// the sweep, which must not use up an order's one scheduled check.
function createDateWatch({ store = null, send = null, enabled = isEnabled, ephemeral = false } = {}) {
  if (ephemeral) {
    store = memoryStore();
    enabled = () => false;
  }
  const entries = new Map(); // order id -> { id, name, before, after }
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
    // Which of these orders have already had their one check? Resolves to a Set
    // of string ids. Falls back to "none" if state is unreadable, so a state
    // problem means a repeat check rather than a missed one.
    async alreadyChecked(ids) {
      try {
        return await getStore().checked(ids);
      } catch (err) {
        console.warn(`[date-alerts] could not read checked orders: ${err.message || err}`);
        return new Set();
      }
    },

    // The order as it stood when the check began.
    begin(order) {
      if (!order?.id) return;
      entries.set(String(order.id), {
        id: order.id,
        name: order.name || String(order.id),
        before: snapshotOf(order),
        after: null,
      });
    },

    // The order as it stands after any fix (re-read from Shopify).
    finish(order) {
      const e = order?.id ? entries.get(String(order.id)) : null;
      if (e) e.after = snapshotOf(order);
    },

    // Email what this pass found and mark every order in it as checked.
    async flush() {
      const list = Array.from(entries.values());
      entries.clear();
      if (!list.length) return { events: 0 };

      try {
        const events = [];
        for (const e of list) {
          const after = e.after || e.before; // no fix attempted/succeeded: unchanged
          const rec = { ...e, after };
          if (after.issue) events.push({ ...rec, type: 'STILL_WRONG' });
          else if (e.before.issue) events.push({ ...rec, type: 'AUTO_FIXED' });
          else if (e.before.pack !== after.pack || e.before.delivery !== after.delivery) {
            events.push({ ...rec, type: 'CHANGED' });
          }
        }

        if (events.length && enabled()) {
          const result = await deliver(buildEmail(events));
          if (result?.sent) {
            console.log(`[date-alerts] emailed ${events.length} result(s) to ${result.to.join(', ')}`);
          } else {
            console.warn(
              `[date-alerts] ${events.length} result(s) NOT emailed (${result?.reason || 'unknown'}): ` +
                events.map((x) => `${x.name} [${x.type}]`).join(', ')
            );
          }
        }

        // Marked checked whether or not the email went: the check is once per
        // order, and what it found is in the logs above if the send failed.
        await getStore().save(list.map((e) => ({ id: e.id, snap: e.after || e.before })));
        return { events: events.length };
      } catch (err) {
        // Notification trouble must never stop the sweep that called it.
        console.warn(`[date-alerts] failed: ${err.message || err}`);
        return { events: 0, error: err.message };
      }
    },
  };
}

module.exports = { createDateWatch, snapshotOf, buildEmail, isEnabled };
