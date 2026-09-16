// notifyOrderStatus is opt-in and mail-server-free to test: PER_ORDER_EMAIL_ENABLED
// gates it before any SMTP config is even consulted.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SHOPIFY_STORE = 'workoutmeals.myshopify.com';

test('disabled by default — does nothing, sends nothing', async () => {
  delete process.env.PER_ORDER_EMAIL_ENABLED;
  // Re-required per test via cache-busting isn't needed: isEnabled() reads
  // process.env live on every call, not just at require time.
  const { notifyOrderStatus, isEnabled } = require('../src/lib/order-notify');
  assert.equal(isEnabled(), false);

  const result = await notifyOrderStatus({ id: 1, name: 'WM1', note_attributes: [] });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'disabled');
});

test('force bypasses the disabled gate — for the manual test script', async () => {
  delete process.env.PER_ORDER_EMAIL_ENABLED;
  const { notifyOrderStatus, isEnabled } = require('../src/lib/order-notify');
  assert.equal(isEnabled(), false, 'still disabled by default');

  const result = await notifyOrderStatus({ id: 1, name: 'WM1', note_attributes: [] }, { force: true });
  // Still no SMTP configured in this test env, but the reason must now be
  // about SMTP, not "disabled" — force got it past that gate.
  assert.equal(result.reason, 'smtp not configured');
});

test('enabled but SMTP not configured — reports why, does not throw', async () => {
  process.env.PER_ORDER_EMAIL_ENABLED = 'true';
  try {
    const { notifyOrderStatus, isEnabled } = require('../src/lib/order-notify');
    assert.equal(isEnabled(), true);

    const result = await notifyOrderStatus({ id: 1, name: 'WM1', note_attributes: [] });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'smtp not configured');
  } finally {
    delete process.env.PER_ORDER_EMAIL_ENABLED;
  }
});
