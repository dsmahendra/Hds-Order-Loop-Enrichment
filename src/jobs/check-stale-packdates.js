// Check for orders with missing or stale (past) pack dates every 5 minutes.
// Sends detailed report email to admins with order information.
//
// Checks:
// 1. Orders with NO pack date (missing enrichment)
// 2. Orders with pack date IN THE PAST (stale/expired date)
//
// Only checks orders created in the last 7 days (old orders are not urgent).

const { pool } = require('../db');
const { getOrder } = require('../shopify');
const { getNoteAttribute, normalizeDate } = require('../shopify');
const { sendMail, config: getMailConfig, isConfigured } = require('../lib/mailer');

const INTERVAL_MS = Number(process.env.CHECK_PACKDATES_INTERVAL_MS || 5 * 60 * 1000);
const HOURS_BACK = Number(process.env.CHECK_PACKDATES_HOURS || 24 * 7); // Last 7 days

let running = false;

async function checkOrder(orderId) {
  try {
    const order = (await getOrder(orderId))?.order;
    if (!order) return null;

    const packDate = getNoteAttribute(order, 'Pick-Pack-Date') ||
                     getNoteAttribute(order, 'HDS Ship Date') ||
                     getNoteAttribute(order, 'hds_pack_date');

    const deliveryDate = getNoteAttribute(order, 'Delivery-Date') ||
                         getNoteAttribute(order, 'HDS Delivery Date') ||
                         getNoteAttribute(order, 'hds_delivery_date');

    if (!packDate) {
      return {
        orderId,
        orderName: order.name,
        issue: 'MISSING_PACK_DATE',
        packDate: null,
        deliveryDate: deliveryDate || '(missing)',
        createdAt: order.created_at,
      };
    }

    // Check if pack date is in the past
    const normalized = normalizeDate(packDate);
    const today = new Date().toISOString().slice(0, 10);
    if (normalized < today) {
      return {
        orderId,
        orderName: order.name,
        issue: 'STALE_PACK_DATE',
        packDate: normalized,
        deliveryDate: deliveryDate || '(missing)',
        createdAt: order.created_at,
        daysOverdue: Math.floor((new Date(today) - new Date(normalized)) / 86400000),
      };
    }

    return null;
  } catch (err) {
    console.warn(`[check-packdates] failed to check order ${orderId}: ${err.message}`);
    return null;
  }
}

async function tick() {
  if (running) return;
  running = true;

  try {
    // Find all orders created in the last N hours
    const { rows: orderIds } = await pool.query(
      `SELECT DISTINCT order_id FROM orders_to_enrich
        WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
        ORDER BY created_at DESC
        LIMIT 1000`,
      [HOURS_BACK]
    );

    if (orderIds.length === 0) {
      console.log('[check-packdates] no recent orders to check');
      return;
    }

    console.log(`[check-packdates] checking ${orderIds.length} orders for stale/missing pack dates...`);

    const issues = [];
    for (const row of orderIds) {
      const issue = await checkOrder(row.order_id);
      if (issue) issues.push(issue);
    }

    if (issues.length === 0) {
      console.log('[check-packdates] all recent orders OK');
      return;
    }

    console.log(`[check-packdates] found ${issues.length} order(s) with issues`);

    // Send detailed email report
    if (!isConfigured()) {
      console.warn('[check-packdates] SMTP not configured — would report:', issues);
      return;
    }

    const missing = issues.filter(i => i.issue === 'MISSING_PACK_DATE');
    const stale = issues.filter(i => i.issue === 'STALE_PACK_DATE');

    let text = `⚠️ PACK DATE HEALTH CHECK REPORT\n\n`;
    text += `Found ${issues.length} order(s) needing attention:\n\n`;

    if (missing.length) {
      text += `MISSING PACK DATES (${missing.length}):\n`;
      text += `${'─'.repeat(80)}\n`;
      for (const item of missing) {
        text += `Order: ${item.orderName} (ID: ${item.orderId})\n`;
        text += `  Created: ${item.createdAt}\n`;
        text += `  Delivery Date: ${item.deliveryDate}\n`;
        text += `  Pack Date: ❌ MISSING\n`;
        text += `  Action: Run order-fix.js --name ${item.orderName}\n\n`;
      }
      text += `\n`;
    }

    if (stale.length) {
      text += `STALE PACK DATES (${stale.length}):\n`;
      text += `${'─'.repeat(80)}\n`;
      for (const item of stale) {
        text += `Order: ${item.orderName} (ID: ${item.orderId})\n`;
        text += `  Created: ${item.createdAt}\n`;
        text += `  Pack Date: ${item.packDate} (${item.daysOverdue} days overdue)\n`;
        text += `  Delivery Date: ${item.deliveryDate}\n`;
        text += `  Action: Recompute with order-fix.js --name ${item.orderName} --recompute\n\n`;
      }
    }

    text += `\nRun bulk fix:\n`;
    text += `  ${missing.map(i => `--name ${i.orderName}`).join(' ')}\n`;
    text += `  ${stale.map(i => `--name ${i.orderName}`).join(' ')}\n`;

    const mailConfig = getMailConfig();
    const recipients = new Set(mailConfig.to || []);

    // Add failure admins if configured
    const failureAdmins = String(process.env.FAILURE_EMAIL_ADMINS || '')
      .split(',')
      .map(e => e.trim())
      .filter(Boolean);
    failureAdmins.forEach(e => recipients.add(e));

    try {
      const result = await sendMail({
        subject: `[HDS] Pack Date Health Check — ${issues.length} issue(s)`,
        text,
        to: Array.from(recipients),
      });

      if (result.sent) {
        console.log(
          `[check-packdates] report emailed to ${result.to.join(', ')}` +
            (result.bcc?.length ? ` (bcc ${result.bcc.join(', ')})` : '')
        );
      }
    } catch (err) {
      console.warn(`[check-packdates] email send failed: ${err.message}`);
    }
  } catch (err) {
    console.error('[check-packdates] check failed:', err.message || err);
  } finally {
    running = false;
  }
}

function initPackdateChecker() {
  if (String(process.env.CHECK_PACKDATES_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('[check-packdates] disabled (CHECK_PACKDATES_ENABLED=false)');
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.log('[check-packdates] disabled: no DATABASE_URL');
    return;
  }

  console.log(
    `[check-packdates] started (every ${Math.round(INTERVAL_MS / 60000)}m, ` +
      `checking orders from last ${HOURS_BACK}h, email to ALERT_EMAIL_TO + FAILURE_EMAIL_ADMINS)`
  );

  setInterval(tick, INTERVAL_MS);
  // Run once immediately on startup
  setTimeout(tick, 1000);
}

module.exports = { initPackdateChecker, tick };
