// What the sweep decides to touch.
//
// This predicate is the whole cost control: it runs against every order in the
// window on every pass, and it must reach its answer from the payload alone. If
// it needed an API call per order, a 24-hour sweep would cost hundreds of calls
// every half hour and compete with the live webhooks it exists to back up.
//
// It must also not be shy. An order it wrongly calls complete is an order nobody
// ever fixes — which is the exact failure the sweep was written for.

const test = require('node:test');
const assert = require('node:assert/strict');

const { needsWork } = require('../src/jobs/sweep-missing-packdates');
const { HELD_TAG } = require('../src/lib/renewal-rewrite');

const attrs = (pairs) => Object.entries(pairs).map(([name, value]) => ({ name, value }));

// Computed relative to whenever the suite actually runs, not fixed 2026
// literals — planFor's staleness check (Pick-Pack-Date must be before today
// AND before Delivery-Date) means a fixed-in-the-past fixture eventually
// starts failing on its own once real time catches up to it.
function daysFromNow(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}
const slash = (d) => d.toISOString().slice(0, 10).replace(/-/g, '/');
const ddmmyyyy = (d) => {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${day}-${m}-${y}`;
};

const CREATED_AT = daysFromNow(-3);
const DELIVERY = daysFromNow(10);
const PACK = daysFromNow(9);
const PRODUCTION = daysFromNow(8);
const CUTOFF = daysFromNow(6);
const EXPIRED = daysFromNow(-30); // safely before CREATED_AT too

// Everything the HDS set contributes, as a fully enriched order carries it.
const COMPLETE_HDS = {
  'Delivery-Date': slash(DELIVERY),
  'Pick-Pack-Date': slash(PACK),
  'HDS Delivery Date': slash(DELIVERY),
  'HDS Delivery Formatted': 'Some Formatted Date',
  'HDS Delivery Day': 'Monday',
  'HDS Delivery Window': 'AM',
  'Delivery-Time': '12:00 AM - 7:00 AM',
  'HDS Schedule ID': '12',
  'HDS Cutoff Day': 'Friday',
  'HDS Cutoff Date': slash(CUTOFF),
  'Charge Offset': '3 Days',
  'HDS Ship Date': slash(PACK),
  'HDS Production Date': slash(PRODUCTION),
  'HDS Region': 'NSW',
  'HDS Suburb': 'Marrickville',
  'HDS Postcode': '2204',
};

// The date tags that follow from those dates.
const PACK_TAG = `Pick-Pack-Date-${ddmmyyyy(PACK)}`;
const COMPLETE_TAGS = `${ddmmyyyy(DELIVERY)}, ${PACK_TAG}`;

const orderWith = (overrides = {}) => ({
  id: 1,
  name: 'WM141238',
  created_at: `${CREATED_AT.toISOString().slice(0, 10)}T16:07:00+10:00`,
  tags: COMPLETE_TAGS,
  note_attributes: attrs(COMPLETE_HDS),
  ...overrides,
});

test('a complete order is left alone — no call, no write', () => {
  assert.strictEqual(needsWork(orderWith()), null);
});

test('a missing pack date is caught', () => {
  const withoutPack = { ...COMPLETE_HDS };
  delete withoutPack['Pick-Pack-Date'];

  const work = needsWork(orderWith({ note_attributes: attrs(withoutPack) }));
  assert.ok(work, 'must not be judged complete');
  assert.strictEqual(work.plan.action, 'fill');
});

test('an order with no delivery date at all is caught', () => {
  // The Loop renewal whose webhook never ran: nothing on it but the basics.
  const work = needsWork(orderWith({ note_attributes: [], tags: '' }));
  assert.ok(work);
  assert.strictEqual(work.plan.action, 'rewrite');
});

test('an empty attribute value counts as missing, not as present', () => {
  const blank = { ...COMPLETE_HDS, 'Pick-Pack-Date': '' };
  const work = needsWork(orderWith({ note_attributes: attrs(blank) }));
  assert.ok(work, 'an empty string is not a pack date');
  assert.strictEqual(work.plan.action, 'fill');
});

test('complete dates but missing tags is caught, without asking Loop', () => {
  // The tags derive from the order's own dates, so this needs no subscription
  // lookup — which is what makes checking every order on every pass affordable.
  const work = needsWork(orderWith({ tags: '' }));
  assert.ok(work);
  assert.strictEqual(work.plan.action, 'tags-only');
  assert.match(work.why, /missing tag/);
  assert.match(work.why, new RegExp(PACK_TAG));
});

test('complete dates and tags but missing Delivery-Time is caught', () => {
  // Delivery-Time is deliberately outside HDS_FIELDS (see HDS_FIELDS docs), so
  // this order's dates alone don't tell needsWork it needs anything — the
  // Delivery-Time check has to be its own path.
  const withoutTime = { ...COMPLETE_HDS };
  delete withoutTime['Delivery-Time'];

  const work = needsWork(orderWith({ note_attributes: attrs(withoutTime) }));
  assert.ok(work, 'must not be judged complete');
  assert.strictEqual(work.plan.action, 'tags-only');
  assert.match(work.why, /Delivery-Time/);
});

test('a partially tagged order is caught on the tag it lacks', () => {
  const work = needsWork(orderWith({ tags: ddmmyyyy(DELIVERY) }));
  assert.ok(work);
  assert.match(work.why, new RegExp(PACK_TAG));
});

test('an unrelated tag does not make an untagged order look tagged', () => {
  const work = needsWork(orderWith({ tags: 'Imported By Robust NetSuite Integrator' }));
  assert.ok(work);
  assert.match(work.why, /missing tag/);
});

test('an order held for expired dates is reported, not forced', () => {
  // Held means a human decision is pending. Forcing it here would write dates the
  // hold exists to prevent, and it is already visible by its tag.
  const stale = {
    ...COMPLETE_HDS,
    'Delivery-Date': slash(EXPIRED),
    'HDS Delivery Date': slash(EXPIRED),
  };
  const held = orderWith({ note_attributes: attrs(stale), tags: `${COMPLETE_TAGS}, ${HELD_TAG}` });

  // The sweep filters held orders out before this point; the predicate itself
  // declines them too, so neither path can force one.
  const saved = process.env.REWRITE_RENEWAL_DATES;
  try {
    process.env.REWRITE_RENEWAL_DATES = 'false';
    assert.strictEqual(needsWork(held), null);
  } finally {
    if (saved === undefined) delete process.env.REWRITE_RENEWAL_DATES;
    else process.env.REWRITE_RENEWAL_DATES = saved;
  }
});

test('an expired date IS rewritten when rewriting is enabled', () => {
  const stale = {
    ...COMPLETE_HDS,
    'Delivery-Date': slash(EXPIRED),
    'HDS Delivery Date': slash(EXPIRED),
  };
  const saved = process.env.REWRITE_RENEWAL_DATES;
  try {
    process.env.REWRITE_RENEWAL_DATES = 'true';
    const work = needsWork(orderWith({ note_attributes: attrs(stale) }));
    assert.ok(work);
    assert.strictEqual(work.plan.action, 'rewrite');
  } finally {
    if (saved === undefined) delete process.env.REWRITE_RENEWAL_DATES;
    else process.env.REWRITE_RENEWAL_DATES = saved;
  }
});
