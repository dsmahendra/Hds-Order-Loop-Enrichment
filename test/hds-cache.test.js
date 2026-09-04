// HDS lookups during a Loop renewal burst.
//
// Loop charges dozens of subscriptions at once and Shopify delivers those
// webhooks concurrently, so the handlers run in parallel. Before this, each one
// made its own HDS request — fifty renewals across a dozen suburbs meant fifty
// calls for twelve distinct answers, all at the same instant.
//
// The important case is the concurrent one. A plain result cache does nothing for
// it: the second caller arrives while the first request is still in the air, sees
// no cached result yet, and starts another. Caching the in-flight promise is what
// makes the burst collapse.

const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.HDS_API_BASE = 'https://hds.test';

const { fetchDeliveryOptions, clearDeliveryOptionsCache } = require('../src/lib/renewal-date');

beforeEach(() => clearDeliveryOptionsCache());

function stubFetch(handler) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    calls.push(url);
    return handler(calls.length, url);
  };
  return {
    calls,
    restore: () => {
      global.fetch = original;
    },
  };
}

const serviceable = (suburb = 'Bondi') => ({
  ok: true,
  status: 200,
  json: async () => ({
    success: true,
    serviceable: true,
    suburb: { name: suburb, postcode: '2026' },
    delivery_options: [{ delivery_date: '2026-09-07', pack_date: '2026-09-06' }],
  }),
});

test('concurrent lookups for one suburb make a single HDS call', async () => {
  const stub = stubFetch(() => serviceable());
  try {
    // Twenty renewals for the same suburb landing together.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => fetchDeliveryOptions({ postcode: '2026', suburb: 'Bondi' }))
    );

    assert.strictEqual(stub.calls.length, 1, 'one call served all twenty');
    for (const r of results) {
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.data.suburb.name, 'Bondi');
    }
  } finally {
    stub.restore();
  }
});

test('different suburbs are still asked about separately', async () => {
  const stub = stubFetch((_n, url) => serviceable(new URL(url).searchParams.get('suburb')));
  try {
    const [bondi, manly] = await Promise.all([
      fetchDeliveryOptions({ postcode: '2026', suburb: 'Bondi' }),
      fetchDeliveryOptions({ postcode: '2095', suburb: 'Manly' }),
    ]);

    assert.strictEqual(stub.calls.length, 2, 'two suburbs, two calls');
    assert.strictEqual(bondi.data.suburb.name, 'Bondi');
    assert.strictEqual(manly.data.suburb.name, 'Manly');
  } finally {
    stub.restore();
  }
});

test('a sequential repeat within the TTL is served from the cache', async () => {
  const stub = stubFetch(() => serviceable());
  try {
    await fetchDeliveryOptions({ postcode: '2026', suburb: 'Bondi' });
    await fetchDeliveryOptions({ postcode: '2026', suburb: 'Bondi' });
    assert.strictEqual(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('the suburb is matched regardless of how it was capitalised', async () => {
  const stub = stubFetch(() => serviceable());
  try {
    await fetchDeliveryOptions({ postcode: '2026', suburb: 'Bondi' });
    await fetchDeliveryOptions({ postcode: '2026', suburb: 'BONDI' });
    assert.strictEqual(stub.calls.length, 1, 'the same suburb, however it was typed');
  } finally {
    stub.restore();
  }
});

test('a network error is retried and can then succeed', async () => {
  const stub = stubFetch((n) => {
    if (n === 1) throw new Error('socket hang up');
    return serviceable();
  });
  try {
    const out = await fetchDeliveryOptions({ postcode: '2026', suburb: 'Bondi' });
    assert.strictEqual(out.ok, true, 'the blip cost nothing');
    assert.strictEqual(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test('a 5xx is retried; the reason still names HDS_API_BASE if it never recovers', async () => {
  const stub = stubFetch(() => ({ ok: false, status: 502, json: async () => null }));
  try {
    const out = await fetchDeliveryOptions({ postcode: '2026', suburb: 'Bondi' });
    assert.strictEqual(out.ok, false);
    assert.match(out.reason, /HTTP 502/);
    assert.match(out.reason, /HDS_API_BASE/, 'the message names what to check');
    assert.strictEqual(stub.calls.length, 3, 'three attempts, then it gives up');
  } finally {
    stub.restore();
  }
});

test('"not serviceable" is a real answer and is not retried', async () => {
  // Asking again gets the same reply, and during a burst those wasted calls come
  // straight out of the budget the orders that CAN be served need.
  const stub = stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ success: false, error: 'suburb not serviceable' }),
  }));
  try {
    const out = await fetchDeliveryOptions({ postcode: '9999', suburb: 'Nowhere' });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'suburb not serviceable');
    assert.strictEqual(stub.calls.length, 1, 'one attempt only');
  } finally {
    stub.restore();
  }
});

test('a failure is not cached — the next order gets a fresh attempt', async () => {
  // A wrong HDS_API_BASE gets corrected and an outage ends. A cached "no" would
  // keep answering for orders that could now succeed, which is how a five-minute
  // outage turns into an hour of orders with no pack date.
  const stub = stubFetch((n) => (n <= 3 ? { ok: false, status: 503, json: async () => null } : serviceable()));
  try {
    const first = await fetchDeliveryOptions({ postcode: '2026', suburb: 'Bondi' });
    assert.strictEqual(first.ok, false);

    const second = await fetchDeliveryOptions({ postcode: '2026', suburb: 'Bondi' });
    assert.strictEqual(second.ok, true, 'it tried again rather than repeating the failure');
  } finally {
    stub.restore();
  }
});

test('the internal retryable flag never reaches callers', async () => {
  const stub = stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ success: false, error: 'nope' }),
  }));
  try {
    const out = await fetchDeliveryOptions({ postcode: '2026', suburb: 'Bondi' });
    assert.deepStrictEqual(Object.keys(out).sort(), ['ok', 'reason']);
  } finally {
    stub.restore();
  }
});
