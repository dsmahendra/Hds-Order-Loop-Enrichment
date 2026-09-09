// Pacing HDS calls under a Loop renewal burst.
//
// hds-cache.test.js covers the case caching solves: several orders asking
// about the SAME suburb. This covers what caching cannot touch — orders for
// DIFFERENT suburbs, arriving concurrently straight from the webhook handler
// (Express processes those requests in parallel, not through this module's
// own serial queue processor). Before pacedHds(), that burst was fully
// concurrent, unthrottled requests at HDS, and a retry's short backoff window
// bought nothing when every retry was contending with the same burst.

// Read at module load, so this must be set before the require below.
process.env.HDS_MIN_GAP_MS = '60';
process.env.HDS_FETCH_ATTEMPTS = '3';
process.env.HDS_API_BASE = 'https://hds.test';

const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { fetchDeliveryOptions, clearDeliveryOptionsCache } = require('../src/lib/renewal-date');

beforeEach(() => clearDeliveryOptionsCache());

const GAP = 60;

function stubFetch(handler) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    const at = Date.now();
    calls.push({ url, at });
    return handler(calls.length, url);
  };
  return {
    calls,
    restore: () => {
      global.fetch = original;
    },
  };
}

const serviceable = (suburb) => ({
  ok: true,
  status: 200,
  json: async () => ({
    success: true,
    serviceable: true,
    suburb: { name: suburb, postcode: '2026' },
    delivery_options: [{ delivery_date: '2026-09-07', pack_date: '2026-09-06' }],
  }),
});

// Five different suburbs, so the cache can't collapse this into one call —
// every one of them has to actually reach pacedHds().
const SUBURBS = ['Bondi', 'Manly', 'Coogee', 'Cronulla', 'Dee Why'];

test('a burst of different suburbs is spaced out, not fired together', async () => {
  const stub = stubFetch((_n, url) => serviceable(new URL(url).searchParams.get('suburb')));
  try {
    const started = Date.now();
    await Promise.all(
      SUBURBS.map((suburb, i) => fetchDeliveryOptions({ postcode: String(2000 + i), suburb }))
    );

    assert.strictEqual(stub.calls.length, SUBURBS.length, 'every suburb was asked about, none dropped');

    for (let i = 1; i < stub.calls.length; i += 1) {
      const delta = stub.calls[i].at - stub.calls[i - 1].at;
      assert.ok(delta >= GAP - 15, `call ${i + 1} came ${delta}ms after the previous, want >= ${GAP}`);
    }

    assert.ok(Date.now() - started >= GAP * (SUBURBS.length - 1));
  } finally {
    stub.restore();
  }
});

test('a persistently failing suburb does not delay the ones queued behind it', async () => {
  // The queue is a shared promise chain, same as Shopify's — a rejection
  // propagating along it would fail every lookup still waiting, not just the
  // one that actually failed. Keyed off the suburb (not a call counter) so
  // EVERY attempt for Bondi fails, retries included — a transient blip that
  // clears on retry wouldn't exercise this at all.
  const stub = stubFetch((_n, url) => {
    const suburb = new URL(url).searchParams.get('suburb');
    return suburb === 'Bondi' ? { ok: false, status: 503, json: async () => null } : serviceable(suburb);
  });
  try {
    const bondi = fetchDeliveryOptions({ postcode: '2000', suburb: 'Bondi' });
    const others = Promise.all([
      fetchDeliveryOptions({ postcode: '2001', suburb: 'Manly' }),
      fetchDeliveryOptions({ postcode: '2002', suburb: 'Coogee' }),
    ]);

    const startedWaiting = Date.now();
    const [manly, coogee] = await others;
    // Bondi's OWN backoff between retries (500ms, then 1000ms) is well over a
    // second; Manly and Coogee must not be stuck behind it in the same queue.
    assert.ok(Date.now() - startedWaiting < 800, 'Manly/Coogee were held up behind Bondi\'s retries');
    assert.strictEqual(manly.ok, true);
    assert.strictEqual(coogee.ok, true);

    const bondiResult = await bondi;
    assert.strictEqual(bondiResult.ok, false, 'Bondi exhausts its own retries and fails on its own');
  } finally {
    stub.restore();
  }
});

test('concurrent lookups for one suburb still collapse to a single paced call', async () => {
  // Pacing must not undo the in-flight de-dup hds-cache.test.js relies on.
  const stub = stubFetch(() => serviceable('Bondi'));
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => fetchDeliveryOptions({ postcode: '2026', suburb: 'Bondi' }))
    );
    assert.strictEqual(stub.calls.length, 1, 'one call served all ten, pacing did not fan this out');
    for (const r of results) assert.strictEqual(r.ok, true);
  } finally {
    stub.restore();
  }
});
