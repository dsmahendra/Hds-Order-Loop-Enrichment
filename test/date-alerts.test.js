// Each order is checked ONCE and produces at most one email about it. Later
// passes skip it, so nothing is repeated every few minutes.

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
  const store = new Set();
  const sent = [];
  const watch = createDateWatch({
    enabled: () => true,
    store: {
      async checked(ids) {
        return new Set(ids.map(String).filter((i) => store.has(i)));
      },
      async save(entries) {
        for (const e of entries) store.add(String(e.id));
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

test('a healthy order is marked checked and produces no email', async () => {
  const { watch, sent } = harness();
  watch.begin(healthy(1));
  await watch.flush();
  assert.equal(sent.length, 0);
  assert.deepEqual([...(await watch.alreadyChecked([1, 2]))], ['1']);
});

test('once checked, an order is reported as already checked on every later pass', async () => {
  const { watch } = harness();
  watch.begin(order(2, { 'Delivery-Date': slash(6) }));
  await watch.flush();
  assert.ok((await watch.alreadyChecked([2])).has('2'));
  assert.ok((await watch.alreadyChecked([2])).has('2'));
});

test('an order still without a pack date after the check is reported as still wrong', async () => {
  const { watch, sent } = harness();
  watch.begin(order(3, { 'Delivery-Date': slash(6) }));
  await watch.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /STILL WRONG/);
  assert.match(sent[0].text, /WM3/);
  assert.match(sent[0].text, /no pack date/);
  assert.match(sent[0].subject, /1 still wrong/);
});

test('a pack date in the past that is still past after the check is reported', async () => {
  const { watch, sent } = harness();
  watch.begin(order(4, { 'Delivery-Date': slash(6), 'Pick-Pack-Date': slash(-5) }));
  await watch.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /on or before today/);
});

test('an order the check fixed is reported as auto-fixed with before and after', async () => {
  const { watch, sent } = harness();
  watch.begin(order(5, { 'Delivery-Date': slash(6) }));
  watch.finish(healthy(5, 6, 4));
  await watch.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /AUTO-FIXED/);
  assert.match(sent[0].text, /\(none\)/);
  assert.match(sent[0].subject, /0 still wrong, 1 auto-fixed/);
});

test('a date changed by the check on an order that was not flagged is reported as changed', async () => {
  const { watch, sent } = harness();
  watch.begin(healthy(6, 6, 4));
  watch.finish(healthy(6, 13, 11));
  await watch.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /CHANGED BY THE CHECK/);
});

test('one email per pass covers every order in it', async () => {
  const { watch, sent } = harness();
  watch.begin(order(7, { 'Delivery-Date': slash(6) }));
  watch.begin(order(8, { 'Delivery-Date': slash(6) }));
  watch.begin(healthy(9));
  await watch.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /2 still wrong/);
});

test('a failed send still marks the order checked, so it is not repeated', async () => {
  const { watch, store } = harness({ failSend: true });
  watch.begin(order(10, { 'Delivery-Date': slash(6) }));
  await watch.flush();
  assert.ok(store.has('10'));
});

test('an ephemeral watch remembers nothing and sends nothing', async () => {
  const sent = [];
  const watch = createDateWatch({ ephemeral: true, send: async (m) => sent.push(m) });
  watch.begin(order(11, { 'Delivery-Date': slash(6) }));
  await watch.flush();
  assert.equal(sent.length, 0);
  assert.equal((await watch.alreadyChecked([11])).size, 1, 'memory within the run only');
});

test('snapshotOf reads pack and delivery from either label', () => {
  const s = snapshotOf(order(12, { 'HDS Delivery Date': slash(6), 'HDS Ship Date': slash(4) }));
  assert.ok(s.pack);
  assert.ok(s.delivery);
  assert.equal(s.issue, null);
});
