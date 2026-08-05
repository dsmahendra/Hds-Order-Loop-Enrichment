const test = require('node:test');
const assert = require('node:assert');

const { verifyWebhook, webhookDigest } = require('../src/shopify');

const BODY = Buffer.from(JSON.stringify({ id: 8215657775202, note_attributes: [] }));

function withSecret(secret, fn) {
  const saved = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (secret === undefined) delete process.env.SHOPIFY_WEBHOOK_SECRET;
  else process.env.SHOPIFY_WEBHOOK_SECRET = secret;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.SHOPIFY_WEBHOOK_SECRET;
    else process.env.SHOPIFY_WEBHOOK_SECRET = saved;
  }
}

test('accepts a body signed with the configured secret', () => {
  withSecret('shpss_test_secret', () => {
    assert.strictEqual(verifyWebhook(BODY, webhookDigest(BODY)), true);
  });
});

test('rejects a signature made with a different secret', () => {
  const other = withSecret('the_wrong_secret', () => webhookDigest(BODY));
  withSecret('shpss_test_secret', () => {
    assert.strictEqual(verifyWebhook(BODY, other), false);
  });
});

test('rejects a body altered after signing', () => {
  withSecret('shpss_test_secret', () => {
    const digest = webhookDigest(BODY);
    assert.strictEqual(verifyWebhook(Buffer.concat([BODY, Buffer.from(' ')]), digest), false);
  });
});

test('rejects when the secret is not configured at all', () => {
  const digest = withSecret('shpss_test_secret', () => webhookDigest(BODY));
  withSecret(undefined, () => {
    assert.strictEqual(webhookDigest(BODY), null);
    assert.strictEqual(verifyWebhook(BODY, digest), false);
  });
});

test('rejects a missing signature header', () => {
  withSecret('shpss_test_secret', () => {
    assert.strictEqual(verifyWebhook(BODY, undefined), false);
    assert.strictEqual(verifyWebhook(BODY, ''), false);
  });
});

// A wrong-length header must not throw — timingSafeEqual requires equal lengths.
test('rejects a truncated signature without throwing', () => {
  withSecret('shpss_test_secret', () => {
    assert.strictEqual(verifyWebhook(BODY, 'abc'), false);
  });
});
