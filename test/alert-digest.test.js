// buildReportEmail is pure and DB/Shopify/SMTP-free on purpose — these test it
// directly, with no database, live check, or mail server involved. Unlike the
// old "only if something's wrong" digest, this ALWAYS returns an email — the
// point is that admin sees the checker ran even when nothing needed doing.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SHOPIFY_STORE = 'workoutmeals.myshopify.com';

const { buildReportEmail, msUntilNextHour, msUntilNextOccurrence, parseHHMM } = require('../src/jobs/alert-digest');

test('no orders and nothing stuck still produces an email, not null', () => {
  const email = buildReportEmail([], []);
  assert.ok(email);
  assert.match(email.subject, /no new Loop orders/i);
  assert.match(email.text, /No new Loop subscription orders/);
});

test('every order fine still sends, with a subject that says so', () => {
  const email = buildReportEmail(
    [
      { orderId: 1, orderName: 'WM100', status: 'done', label: 'all data updated' },
      { orderId: 2, orderName: 'WM101', status: 'done', label: 'all data updated' },
    ],
    []
  );
  assert.match(email.subject, /all 2 order\(s\) OK/);
  assert.match(email.text, /Order WM100 = all data updated/);
  assert.match(email.text, /Order WM101 = all data updated/);
});

test('a mix of statuses is listed per order, in the requested wording', () => {
  const email = buildReportEmail(
    [
      { orderId: 123, orderName: null, status: 'done', label: 'all data updated' },
      { orderId: 124, orderName: null, status: 'missing-pack', label: 'pack date not updated but other information added' },
      { orderId: 125, orderName: null, status: 'missing-other', label: 'pack date updated but other information not (missing HDS Region)' },
      { orderId: 126, orderName: null, status: 'stale', label: 'pack date updated but wrong — Pick-Pack-Date 2026-09-02 is on or before today' },
    ],
    []
  );

  assert.match(email.subject, /3 of 4 order\(s\) need attention/);
  assert.match(email.text, /Order 123 = all data updated/);
  assert.match(email.text, /Order 124 = pack date not updated but other information added/);
  assert.match(email.text, /Order 125 = pack date updated but other information not/);
  assert.match(email.text, /Order 126 = pack date updated but wrong/);
});

test('orders beyond the cap are summarised, not all listed', () => {
  const orderStatuses = Array.from({ length: 30 }, (_, i) => ({
    orderId: 1000 + i,
    orderName: `WM${1000 + i}`,
    status: 'done',
    label: 'all data updated',
  }));

  const email = buildReportEmail(orderStatuses, []);

  // Default cap is 25 — the 30th order's name must not appear, but an
  // overflow note must.
  assert.ok(!email.text.includes('WM1029'), 'must not list every row past the cap');
  assert.match(email.text, /5 more not shown/);
});

test('stuck orders (section 2) still appear alongside the per-order section', () => {
  const email = buildReportEmail(
    [{ orderId: 1, orderName: 'WM100', status: 'done', label: 'all data updated' }],
    [
      {
        orderId: 6805214560299,
        orderName: 'WM142344',
        subscriptionId: 65704558635,
        detail: 'anchored to Tuesday for Mulgrave 3170, but HDS now only offers Saturday, Sunday, Monday, Thursday, Friday there',
      },
    ]
  );

  assert.match(email.text, /Order WM100 = all data updated/);
  assert.match(email.text, /subscription 65704558635/);
  assert.match(email.text, /HDS now only offers Saturday/);
  // A clickable admin link, built from SHOPIFY_STORE.
  assert.match(email.text, /https:\/\/admin\.shopify\.com\/store\/workoutmeals\/orders\/6805214560299/);
});

test('a stuck order with no resolved subscription is still listed, just without one', () => {
  const email = buildReportEmail(
    [],
    [{ orderId: 111, orderName: 'WM100111', subscriptionId: null, detail: 'anchored to Monday, but HDS offers nothing there' }]
  );
  // The boilerplate copy legitimately says "Loop subscription order..." —
  // what must NOT appear is a "subscription <id>," prefix on this specific
  // stuck-order line, since it has no resolved subscription id.
  assert.match(email.text, /- order WM100111\n/);
  assert.ok(!email.text.includes('subscription null'), 'no subscription id to name');
});

// msUntilNextHour drives the fixed daily send time (ALERT_DIGEST_HOUR_UTC) —
// pure and given "now" explicitly so it's deterministic regardless of when
// the suite actually runs.

test('msUntilNextHour counts forward to later today when the hour has not passed', () => {
  const now = new Date('2026-09-11T05:00:00Z');
  const ms = msUntilNextHour(22, now); // 22:00 UTC, still ahead of 05:00
  assert.equal(ms, 17 * 60 * 60 * 1000);
});

test('msUntilNextHour rolls to tomorrow when the hour has already passed today', () => {
  const now = new Date('2026-09-11T23:00:00Z');
  const ms = msUntilNextHour(22, now); // 22:00 UTC already gone today
  assert.equal(ms, 23 * 60 * 60 * 1000);
});

test('msUntilNextHour rolls to tomorrow at the exact instant of the target hour', () => {
  // Never fires twice for "the same" instant — exactly on the hour counts as
  // already happened, not still pending.
  const now = new Date('2026-09-11T22:00:00Z');
  const ms = msUntilNextHour(22, now);
  assert.equal(ms, 24 * 60 * 60 * 1000);
});

test('msUntilNextHour honours a minute offset, not just the hour', () => {
  const now = new Date('2026-09-11T03:00:00Z');
  const ms = msUntilNextHour(3, now, 5); // 03:05 UTC, 5 minutes ahead
  assert.equal(ms, 5 * 60 * 1000);
});

// parseHHMM feeds ALERT_DIGEST_TIMES_UTC — reject anything that isn't a real
// clock time rather than silently scheduling garbage.

test('parseHHMM accepts a valid HH:MM', () => {
  assert.deepEqual(parseHHMM('03:05'), { hour: 3, minute: 5 });
  assert.deepEqual(parseHHMM(' 17:05 '), { hour: 17, minute: 5 });
});

test('parseHHMM rejects an out-of-range or malformed value', () => {
  assert.equal(parseHHMM('24:00'), null);
  assert.equal(parseHHMM('12:60'), null);
  assert.equal(parseHHMM('not-a-time'), null);
  assert.equal(parseHHMM(''), null);
});

// msUntilNextOccurrence drives multiple daily sends (1:05pm AND 5:05pm AEST =
// 03:05 and 07:05 UTC) — one recurring timer cycles through all of them.

test('msUntilNextOccurrence picks whichever of several times is soonest', () => {
  const times = [parseHHMM('03:05'), parseHHMM('07:05')];
  // 04:00 UTC: 03:05 has passed today, 07:05 is still ahead — soonest is 07:05.
  const now = new Date('2026-09-11T04:00:00Z');
  const ms = msUntilNextOccurrence(times, now);
  assert.equal(ms, 3 * 60 * 60 * 1000 + 5 * 60 * 1000); // 3h05m to 07:05
});

test('msUntilNextOccurrence rolls to tomorrow\'s earliest time once all of today\'s have passed', () => {
  const times = [parseHHMM('03:05'), parseHHMM('07:05')];
  const now = new Date('2026-09-11T08:00:00Z'); // both today's times are gone
  const ms = msUntilNextOccurrence(times, now);
  // Next occurrence is tomorrow 03:05 — 19h05m from 08:00 today.
  assert.equal(ms, 19 * 60 * 60 * 1000 + 5 * 60 * 1000);
});
