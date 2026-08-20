const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  isValidShopDomain,
  signState,
  verifyState,
  verifyOAuthHmac,
} = require('../src/shopify-oauth');

const SECRET = 'shpss_testsecret';

// Shopify signs its OAuth redirects; anything unsigned is someone else calling.
const signQuery = (params, secret) => {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
};

// --- shop domain -------------------------------------------------------------

test('only *.myshopify.com domains are accepted', () => {
  for (const good of ['staging-workoutmeals.myshopify.com', 'a.myshopify.com', 'shop-1.myshopify.com']) {
    assert.equal(isValidShopDomain(good), true, `${good} should be valid`);
  }
  for (const bad of [
    'evil.com',
    'staging-workoutmeals.myshopify.com.evil.com',
    'myshopify.com',
    '-bad.myshopify.com',
    'shop.myshopify.com/path',
    '',
    null,
  ]) {
    assert.equal(isValidShopDomain(bad), false, `${bad} should be rejected`);
  }
});

// --- state nonce -------------------------------------------------------------
// Signed rather than stored, so it survives a restart between redirect and callback.

test('a signed state round-trips and carries the shop', () => {
  const state = signState('staging-workoutmeals.myshopify.com', Date.now(), SECRET);
  const result = verifyState(state, SECRET);

  assert.equal(result.ok, true);
  assert.equal(result.shop, 'staging-workoutmeals.myshopify.com');
});

test('a state signed with another secret is refused', () => {
  const state = signState('staging-workoutmeals.myshopify.com', Date.now(), 'other-secret');
  const result = verifyState(state, SECRET);

  assert.equal(result.ok, false);
  assert.match(result.reason, /signature mismatch/);
});

test('a tampered shop inside the state is refused', () => {
  const state = signState('staging-workoutmeals.myshopify.com', Date.now(), SECRET);
  const [encoded, mac] = state.split('.');
  const swapped = Buffer.from('attacker.myshopify.com:' + Date.now()).toString('base64url');

  const result = verifyState(`${swapped}.${mac}`, SECRET);
  assert.equal(result.ok, false);
});

test('an old state expires', () => {
  const issued = Date.now() - 20 * 60 * 1000;
  const state = signState('staging-workoutmeals.myshopify.com', issued, SECRET);

  const result = verifyState(state, SECRET, { maxAgeMs: 10 * 60 * 1000 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /expired/);
});

test('malformed states are reported, not thrown', () => {
  for (const bad of ['', 'nodot', 'a.b.c', null, undefined]) {
    const result = verifyState(bad, SECRET);
    assert.equal(result.ok, false);
  }
});

// --- callback HMAC -----------------------------------------------------------

test('a correctly signed callback verifies', () => {
  const params = { shop: 'staging-workoutmeals.myshopify.com', code: 'abc123', state: 'xyz' };
  params.hmac = signQuery(params, SECRET);

  assert.equal(verifyOAuthHmac(params, SECRET), true);
});

test('the hmac itself is excluded from the signed message', () => {
  // Shopify computes the digest over every param EXCEPT hmac and signature, so
  // including them would never match.
  const params = { shop: 'x.myshopify.com', code: 'abc' };
  const hmac = signQuery(params, SECRET);

  assert.equal(verifyOAuthHmac({ ...params, hmac }, SECRET), true);
  assert.equal(verifyOAuthHmac({ ...params, hmac, signature: 'legacy' }, SECRET), true);
});

test('a tampered parameter invalidates the callback', () => {
  const params = { shop: 'staging-workoutmeals.myshopify.com', code: 'abc123' };
  params.hmac = signQuery(params, SECRET);

  assert.equal(verifyOAuthHmac({ ...params, code: 'tampered' }, SECRET), false);
});

test('a callback with no hmac, or verified with no secret, is refused', () => {
  const params = { shop: 'x.myshopify.com', code: 'abc' };
  assert.equal(verifyOAuthHmac(params, SECRET), false);
  assert.equal(verifyOAuthHmac({ ...params, hmac: signQuery(params, SECRET) }, ''), false);
});

test('a wrong-length hmac is refused without throwing', () => {
  const params = { shop: 'x.myshopify.com', code: 'abc', hmac: 'short' };
  assert.equal(verifyOAuthHmac(params, SECRET), false);
});
