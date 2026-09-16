// Email admin about ONE order's status the moment it's processed by the
// webhook — additive to the periodic digest (alert-digest.js), which still
// covers the wider stuck-schedule scan and a recap of anything missed.
//
// Off by default: PER_ORDER_EMAIL_ENABLED=true to turn it on. This is real-
// time, one email per Loop order — meaningfully more volume than the digest,
// so it's opt-in rather than assumed.
//
// Sends regardless of status, including 'done' — the point (same as the
// digest) is that admin can trust silence never has to mean "everything's
// fine", because everything gets a line either way.

const { sendMail, isConfigured } = require('./mailer');
const { classifyOrderWithReason } = require('./order-status');

function isEnabled() {
  return String(process.env.PER_ORDER_EMAIL_ENABLED || 'false').toLowerCase() === 'true';
}

// The Shopify admin URL for an order, built from SHOPIFY_STORE
// ("workoutmeals.myshopify.com" -> ".../store/workoutmeals/orders/<id>").
function orderUrl(orderId) {
  const store = String(process.env.SHOPIFY_STORE || '');
  const handle = store.replace(/\.myshopify\.com$/, '');
  if (!handle || handle === store) return null;
  return `https://admin.shopify.com/store/${handle}/orders/${orderId}`;
}

// order should be the FINAL state (fetched fresh after the webhook's own
// writes have landed), not the payload as it first arrived — otherwise this
// classifies the order before its own pack date was even added.
//
// force: bypass the PER_ORDER_EMAIL_ENABLED gate — for order-notify-now.js,
// which IS the manual override for testing SMTP/config regardless of whether
// the webhook is set to call this automatically.
async function notifyOrderStatus(order, { force = false } = {}) {
  if (!force && !isEnabled()) return { sent: false, reason: 'disabled' };

  const label = order.name || order.id;
  // The WHY, not just the category — a live dry-run through the same
  // decision order:fix/the sweep would make (skipped entirely when 'done',
  // so a correct order costs no extra lookup).
  const c = await classifyOrderWithReason(order);
  const line = c.reason ? `${c.label} — ${c.reason}` : c.label;
  const url = orderUrl(order.id);

  const subject = `[HDS] Order ${label} = ${line}`;
  const text =
    `Order ${label} = ${line}\n` +
    (url ? `${url}\n` : '') +
    (c.status !== 'done'
      ? `\nTo fix it:\n  node src/scripts/order-fix.js --order ${order.id} [--force | --recompute]\n`
      : '');

  if (!isConfigured()) {
    console.log(`[order-notify] order ${label}: SMTP not configured — would have sent "${subject}"`);
    return { sent: false, reason: 'smtp not configured' };
  }

  try {
    const result = await sendMail({ subject, text });
    console.log(
      `[order-notify] order ${label}: emailed ${result.to.join(', ')}` +
        (result.bcc?.length ? ` (bcc ${result.bcc.join(', ')})` : '') +
        ` (${c.status})`
    );
    return result;
  } catch (err) {
    // Best-effort: a failed notification must never take down order
    // processing, which has already happened by the time this runs.
    console.warn(`[order-notify] order ${label}: send failed — ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

module.exports = { notifyOrderStatus, isEnabled };
