// The audit trail must say exactly what a write changed — added, changed and
// removed values, matched regardless of label spelling — so a checkout value can
// be compared against what the backend later wrote.

const test = require('node:test');
const assert = require('node:assert/strict');

const { diffAttributes, diffTags, attributesObject } = require('../src/lib/order-audit');

const attrs = (pairs) => Object.entries(pairs).map(([name, value]) => ({ name, value }));

test('reports added, changed and removed attributes', () => {
  const before = attrs({ 'Delivery-Date': '2026/10/05', 'HDS Delivery Date': '2026/09/23', Keep: 'same' });
  const after = attrs({ 'Delivery-Date': '2026/10/07', 'Pick-Pack-Date': '2026/10/03', Keep: 'same' });

  const d = diffAttributes(before, after);
  assert.deepEqual(d.added, [{ name: 'Pick-Pack-Date', value: '2026/10/03' }]);
  assert.deepEqual(d.changed, [{ name: 'Delivery-Date', from: '2026/10/05', to: '2026/10/07' }]);
  assert.deepEqual(d.removed, [{ name: 'HDS Delivery Date', value: '2026/09/23' }]);
});

test('matches the same attribute across label spellings', () => {
  const d = diffAttributes(attrs({ 'HDS Pack Date': 'x' }), attrs({ hds_pack_date: 'x' }));
  assert.deepEqual(d, { added: [], changed: [], removed: [] });
});

test('a write that changes nothing produces an empty diff', () => {
  const a = attrs({ A: '1', B: '2' });
  assert.deepEqual(diffAttributes(a, a), { added: [], changed: [], removed: [] });
});

test('handles a missing before list (order with no attributes)', () => {
  const d = diffAttributes(undefined, attrs({ A: '1' }));
  assert.deepEqual(d.added, [{ name: 'A', value: '1' }]);
});

test('diffs tags', () => {
  assert.deepEqual(diffTags('a, b', 'b, c'), { added: ['c'], removed: ['a'] });
  assert.deepEqual(diffTags('', 'x'), { added: ['x'], removed: [] });
});

test('attributesObject turns the Shopify list into a name:value map', () => {
  assert.deepEqual(attributesObject(attrs({ A: '1', B: null })), { A: '1', B: '' });
});
