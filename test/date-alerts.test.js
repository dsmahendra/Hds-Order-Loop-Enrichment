// The date watch emails once per distinct problem or change — not on every
// sweep pass an order stays broken, and not for healthy orders it sees first.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDateWatch, snapshotOf } = require('../src/lib/date-alerts');

const attrs = (pairs) => Object.entries(pairs).map(([name, value]) => ({ name, value }));
const slash = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10).replace(/-/g, '/');
};

const order = (id, pairs) => ({ id, name: `WM${id}`, note_attributes: attrs(pairs) });
const healthy = (id, deliveryDays = 6, packDays = 4) =>
  order(id, { 'Delivery-Date': slash(deliveryDays), 'Pick-Pack-Date': slash(packDays) });

function harness({ failSend = false } = {}) {
  const store = new Map();
  const sent = [];
  const watch = createDateWatch({
    enabled: () => true,
    store: {
      async load(ids) {
        return new Map(ids.filter((i) => store.has(String(i))).map((i) => [String(i), store.get(String(i))]));
      },
      async save(entries) {
        for (const e of entries) store.set(String(e.id), e.snap);
      },
    },
    send: async (mail) => {
      if (failSend) return { sent: false, reason: 'smtp exploded' };
      sent.push(mail);
      return { sent: true, to: ['a@x.com', 'b@x.com'] };
    },
  });
  return { watch, sent, store };
}

test('a healthy order seen for the first time is recorded silently', async () => {
  const { watch, sent, store } = harness();
  watch.observe(healthy(1));
  await watch.flush();
  assert.equal(sent.length, 0);
  assert.ok(store.has('1'));
});

test('an order with no pack date is reported once, then not again while unchanged', async () => {
  const { watch, sent } = harness();
  const o = order(2, { 'Delivery-Date': slash(6) });

  watch.observe(o);
  await watch.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /WM2/);
  assert.match(sent[0].text, /no pack date/);

  watch.observe(o);
  await watch.flush();
  assert.equal(sent.length, 1, 'same problem must not be reported twice');
});

test('a pack date in the past is reported as a problem', async () => {
  const { watch, sent } = harness();
  watch.observe(order(3, { 'Delivery-Date': slash(6), 'Pick-Pack-Date': slash(-5) }));
  await watch.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /on or before today/);
});

test('a changed pack or delivery date is reported with before and after', async () => {
  const { watch, sent } = harness();
  watch.observe(healthy(4, 6, 4));
  await watch.flush();
  assert.equal(sent.length, 0);

  watch.observe(healthy(4, 13, 11));
  await watch.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, new RegExp(`${slash(6).replace(/\//g, '-')}.*${slash(13).replace(/\//g, '-')}`));
  assert.match(sent[0].subject, /1 change/);
});

test('a problem that gets fixed produces a change notice, not a repeat problem', async () => {
  const { watch, sent } = harness();
  watch.observe(order(5, { 'Delivery-Date': slash(6) }));
  await watch.flush(); // problem

  watch.observe(healthy(5, 6, 4));
  await watch.flush(); // pack date appeared
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /0 problem\(s\), 1 change/);
});

test('a failed send leaves the state alone so the next pass tries again', async () => {
  const { watch, store } = harness({ failSend: true });
  watch.observe(order(6, { 'Delivery-Date': slash(6) }));
  const out = await watch.flush();
  assert.equal(out.sent, false);
  assert.equal(store.has('6'), false);
});

test('snapshotOf reads pack and delivery from either label', () => {
  const s = snapshotOf(order(7, { 'HDS Delivery Date': slash(6), 'HDS Ship Date': slash(4) }));
  assert.ok(s.pack);
  assert.ok(s.delivery);
  assert.equal(s.issue, null);
});
