const test = require('node:test');
const assert = require('node:assert/strict');

const { legacyLabelUpdates, describeUpdates, isEnabled } = require('../src/lib/legacy-labels');

const attrs = (pairs) => ({
  note_attributes: Object.entries(pairs).map(([name, value]) => ({ name, value })),
});

test('an order with the old label is renamed, value carried across', () => {
  const updates = legacyLabelUpdates(
    attrs({ 'HDS Pack Date': '2026/08/09', 'Delivery-Date': '2026/08/10' })
  );

  assert.deepStrictEqual(updates, {
    attributes: { 'HDS Ship Date': '2026/08/09' },
    remove: ['HDS Pack Date'],
  });
});

test('the value is never recalculated — only the label moves', () => {
  // A checkout order's date is correct; renaming must not touch it.
  const updates = legacyLabelUpdates(attrs({ 'HDS Pack Date': '2020/01/01' }));
  assert.strictEqual(updates.attributes['HDS Ship Date'], '2020/01/01');
});

test('an order already using the new label needs nothing', () => {
  assert.strictEqual(legacyLabelUpdates(attrs({ 'HDS Ship Date': '2026/08/23' })), null);
});

test('an order with neither label needs nothing', () => {
  assert.strictEqual(legacyLabelUpdates(attrs({ 'Delivery-Date': '2026/08/10' })), null);
  assert.strictEqual(legacyLabelUpdates({ note_attributes: [] }), null);
  assert.strictEqual(legacyLabelUpdates({}), null);
});

test('when both labels exist the newer one wins and the old is dropped', () => {
  // Overwriting would replace a fresh value with a stale one.
  const updates = legacyLabelUpdates(
    attrs({ 'HDS Pack Date': '2026/08/09', 'HDS Ship Date': '2026/08/23' })
  );

  assert.deepStrictEqual(updates, { attributes: {}, remove: ['HDS Pack Date'] });
});

test('an empty old value is not carried across as a rename', () => {
  assert.strictEqual(legacyLabelUpdates(attrs({ 'HDS Pack Date': '' })), null);
});

test('describeUpdates summarises both halves for the log', () => {
  const updates = legacyLabelUpdates(attrs({ 'HDS Pack Date': '2026/08/09' }));
  assert.match(describeUpdates(updates), /set HDS Ship Date=2026\/08\/09; removed HDS Pack Date/);
  assert.strictEqual(describeUpdates(null), 'nothing to rename');
});

test('the rename can be switched off without a deploy', () => {
  const saved = process.env.RENAME_LEGACY_LABELS;
  try {
    delete process.env.RENAME_LEGACY_LABELS;
    assert.strictEqual(isEnabled(), true, 'on by default');

    process.env.RENAME_LEGACY_LABELS = 'false';
    assert.strictEqual(isEnabled(), false);

    process.env.RENAME_LEGACY_LABELS = 'true';
    assert.strictEqual(isEnabled(), true);
  } finally {
    if (saved === undefined) delete process.env.RENAME_LEGACY_LABELS;
    else process.env.RENAME_LEGACY_LABELS = saved;
  }
});

// --- order tags --------------------------------------------------------------
// Both dates go on as tags, in the conventions already present on live orders:
// the delivery date bare ("06-09-2026") and the pack date prefixed.

const { deliveryDateTag, packDateTag } = require('../src/lib/renewal-rewrite');

test('the delivery date becomes a bare DD-MM-YYYY tag', () => {
  assert.strictEqual(deliveryDateTag('2026-09-11'), '11-09-2026');
  assert.strictEqual(deliveryDateTag('2026-09-06'), '06-09-2026');
});

test('the pack date keeps its prefix, so the two tags cannot be confused', () => {
  assert.strictEqual(packDateTag('2026-09-09'), 'Pick-Pack-Date-09-09-2026');
});

test('a missing or unparseable date yields no tag rather than a broken one', () => {
  for (const bad of [null, undefined, '', 'not a date']) {
    assert.strictEqual(deliveryDateTag(bad), null);
    assert.strictEqual(packDateTag(bad), null);
  }
});
