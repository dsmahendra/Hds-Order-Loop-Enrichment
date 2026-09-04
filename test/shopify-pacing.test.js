// Pacing and retry behaviour under a Loop renewal burst.
//
// The failure this guards against is not hypothetical: Loop charges dozens of
// subscriptions at once, Shopify delivers those webhooks concurrently, and each
// handler writes three or four times. Unpaced, that empties Shopify's bucket and
// the 429s used to be thrown away — one missing pack date per lost write.

// Read at module load, so both must be set before the require below.
process.env.SHOPIFY_MIN_GAP_MS = '60';
process.env.SHOPIFY_MAX_ATTEMPTS = '3';
process.env.SHOPIFY_STORE = 'test-shop.myshopify.com';
process.env.SHOPIFY_ADMIN_TOKEN = 'shpat_testtoken';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getOrder } = require('../src/shopify');

const GAP = 60;

// Minimal stand-in for a fetch Response.
function reply(status, body, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
  };
}

// Install a stub fetch that records when each call was made.
function stubFetch(handler) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const at = Date.now();
    calls.push({ url, method: init?.method, at });
    return handler(calls.length, calls);
  };
  return {
    calls,
    restore: () => {
      global.fetch = original;
    },
  };
}

test('concurrent calls are serialised and spaced, not fired together', async () => {
  const stub = stubFetch(() => reply(200, { order: { id: 1 } }));
  try {
    const started = Date.now();
    // Five orders arriving at once — the shape of a Loop burst.
    await Promise.all([1, 2, 3, 4, 5].map((id) => getOrder(id)));

    assert.strictEqual(stub.calls.length, 5, 'every call is made, none dropped');

    // Each call begins at least one gap after the one before it.
    for (let i = 1; i < stub.calls.length; i += 1) {
      const delta = stub.calls[i].at - stub.calls[i - 1].at;
      assert.ok(delta >= GAP - 15, `call ${i + 1} came ${delta}ms after the previous, want >= ${GAP}`);
    }

    // And they went out in the order they were requested.
    assert.deepStrictEqual(
      stub.calls.map((c) => c.url.match(/orders\/(\d+)/)[1]),
      ['1', '2', '3', '4', '5']
    );

    // Four gaps for five calls.
    assert.ok(Date.now() - started >= GAP * 4);
  } finally {
    stub.restore();
  }
});

test('a 429 is retried and Retry-After is honoured', async () => {
  // Two rejections then success, as a burst that briefly overran the bucket.
  const stub = stubFetch((n) =>
    n <= 2 ? reply(429, 'Too Many Requests', { 'Retry-After': '0.12' }) : reply(200, { order: { id: 7 } })
  );
  try {
    const out = await getOrder(7);
    assert.deepStrictEqual(out, { order: { id: 7 } }, 'the call ultimately succeeds');
    assert.strictEqual(stub.calls.length, 3, 'it took three attempts');

    // 120ms of Retry-After, not merely the 60ms pacing gap.
    const wait = stub.calls[1].at - stub.calls[0].at;
    assert.ok(wait >= 110, `waited ${wait}ms, want >= 120 from Retry-After`);
  } finally {
    stub.restore();
  }
});

test('without Retry-After it backs off rather than hammering', async () => {
  const stub = stubFetch((n) => (n === 1 ? reply(500, 'upstream error') : reply(200, { order: { id: 8 } })));
  try {
    await getOrder(8);
    assert.strictEqual(stub.calls.length, 2);
    const wait = stub.calls[1].at - stub.calls[0].at;
    assert.ok(wait >= 950, `waited ${wait}ms, want ~1000 from the backoff`);
  } finally {
    stub.restore();
  }
});

test('it gives up after MAX_ATTEMPTS and says why', async () => {
  const stub = stubFetch(() => reply(429, 'Too Many Requests', { 'Retry-After': '0.05' }));
  try {
    await assert.rejects(getOrder(9), (err) => {
      assert.match(err.message, /failed 429/);
      assert.match(err.message, /gave up after 3 attempts/);
      assert.match(err.message, /SHOPIFY_MIN_GAP_MS/, 'the message names the lever to pull');
      return true;
    });
    assert.strictEqual(stub.calls.length, 3, 'exactly MAX_ATTEMPTS, no more');
  } finally {
    stub.restore();
  }
});

test('an auth failure is not retried — it would fail identically every time', async () => {
  const stub = stubFetch(() => reply(401, { errors: 'Unauthorized' }));
  try {
    await assert.rejects(getOrder(10), /failed 401/);
    assert.strictEqual(stub.calls.length, 1, 'one attempt only');
  } finally {
    stub.restore();
  }
});

test('one failed call does not poison the calls queued behind it', async () => {
  // The queue is a shared promise chain. If a rejection propagated along it, a
  // single 401 mid-burst would fail every order still waiting.
  const stub = stubFetch((n) => (n === 1 ? reply(403, 'Forbidden') : reply(200, { order: { id: n } })));
  try {
    const results = await Promise.allSettled([getOrder(1), getOrder(2), getOrder(3)]);

    assert.strictEqual(results[0].status, 'rejected');
    assert.strictEqual(results[1].status, 'fulfilled', 'the next order still goes through');
    assert.strictEqual(results[2].status, 'fulfilled');
    assert.strictEqual(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});
