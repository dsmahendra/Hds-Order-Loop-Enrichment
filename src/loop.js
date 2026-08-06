// Loop Subscriptions Admin API client.
//
// Docs: https://developer.loopwork.co/reference/
//   PUT   /subscription/{id}/customAttribute   — replace custom attributes
//   PATCH /subscription/{id}/customAttribute   — merge custom attributes
//   PUT   /subscription/{id}/note              — replace the subscription note
//
// Auth is the X-Loop-Token header. Custom attributes live on the SUBSCRIPTION,
// not on an individual upcoming order — so a renewal-specific value like
// Delivery-Date has to be overwritten before each charge.

const crypto = require('crypto');

const BASE = (process.env.LOOP_API_BASE || 'https://api.loopsubscriptions.com/admin/2023-10')
  .replace(/\/+$/, '');
  
// Loop documents 5 req/s per endpoint inside a 10 req/s per-domain pool. We
// serialise calls with a minimum gap so a large renewal batch can't trip it.
const MIN_GAP_MS = Number(process.env.LOOP_API_MIN_GAP_MS || 250);
let chain = Promise.resolve();
let lastCallAt = 0;

function throttle(fn) {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_GAP_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  // Keep the chain alive even when a call rejects.
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function loopRequest(method, path, body) {
  const token = process.env.LOOP_API_TOKEN;
  if (!token) throw new Error('LOOP_API_TOKEN is not set');

  return throttle(async () => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'X-Loop-Token': token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body — keep the raw text for the error message.
    }

    if (!res.ok || data?.success === false) {
      // An HTML body means we reached Loop's router but no API handler — the path
      // doesn't exist on this API version. That's almost always a wrong
      // LOOP_API_BASE, so say so instead of dumping a page of markup. It is also
      // permanent: retrying cannot help.
      if (!data && /^\s*<|Cannot (GET|POST|PUT|PATCH|DELETE)/i.test(text)) {
        throw new Error(
          `Loop ${method} ${path} failed (${res.status}): endpoint does not exist on ${BASE} — ` +
            'check LOOP_API_BASE (order lookup and chargeOffset need .../admin/2026-04)'
        );
      }
      const reason = data?.message || text.slice(0, 200) || `HTTP ${res.status}`;
      throw new Error(`Loop ${method} ${path} failed (${res.status}): ${reason}`);
    }
    return data;
  });
}

// Replace the subscription's custom attributes.
// attributes: { 'Delivery-Date': '2026-08-14', ... }
function putCustomAttributes(subscriptionId, attributes) {
  return loopRequest('PUT', `/subscription/${subscriptionId}/customAttribute`, {
    customAttributes: toPairs(attributes),
  });
}

// Merge into the subscription's existing custom attributes, leaving others intact.
// Preferred for our use: we only own the three Delivery-* keys and must not clobber
// anything Loop or another app has stored on the subscription.
function patchCustomAttributes(subscriptionId, attributes) {
  return loopRequest('PATCH', `/subscription/${subscriptionId}/customAttribute`, {
    customAttributes: toPairs(attributes),
  });
}

function updateNote(subscriptionId, note) {
  return loopRequest('PUT', `/subscription/${subscriptionId}/note`, { note });
}

// Fetch a Shopify order and its associated subscription(s) from Loop.
//   GET /orders/shopify-{orderShopifyId}
function readSubscriptionByOrderId(orderShopifyId) {
  return loopRequest('GET', `/orders/shopify-${orderShopifyId}`);
}

// Resolve the Loop subscription identifier (shopify-{contractId}) for a Shopify
// order id — the value the charge-offset / customAttribute endpoints expect.
// Returns null when the order has no associated subscription (e.g. one-time).
async function subscriptionIdForOrder(orderShopifyId) {
  const res = await readSubscriptionByOrderId(orderShopifyId);
  const subs = res?.data?.subscription;
  const shopifyId = Array.isArray(subs) ? subs[0]?.shopifyId : undefined;
  if (!shopifyId) return null;
  const s = String(shopifyId);
  return s.startsWith('shopify-') ? s : `shopify-${s}`;
}

// Retry wrapper for the calls that race Loop's own ingest pipeline.
//
// Shopify's orders/create webhook fires within milliseconds of the order being
// created, while Loop ingests that order asynchronously — and it does so in
// stages. Observed on a real order: GET /orders/shopify-{id} already returned
// the contract id, yet PUT /subscription/{id}/chargeOffset still answered
// "Subscription not found"; the subscription's own createdAt→updatedAt span was
// 6 seconds. So BOTH the lookup and the write have to tolerate the lag —
// retrying only the lookup leaves the write failing on first attempt.
async function withRetries(fn, { attempts, backoffMs, onRetry, retryable } = {}) {
  const total = Number(attempts ?? process.env.LOOP_LOOKUP_RETRIES ?? 4);
  const base = Number(backoffMs ?? process.env.LOOP_LOOKUP_BACKOFF_MS ?? 3000);

  let lastError;
  for (let i = 0; i < total; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!retryable(err)) throw err;
      lastError = err;
    }

    if (i < total - 1) {
      const wait = base * (i + 1); // 3s, 6s, 9s → ~18s of grace
      if (onRetry) onRetry(i + 1, wait, lastError);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

// Retries only what can plausibly succeed later. A missing token, a 401, a wrong
// API version or bad arguments are permanent: they fail fast rather than burning
// three more calls and ~18s on something that cannot change.
function isRetryableLoopError(err) {
  const m = String(err?.message || '');
  if (/LOOP_API_TOKEN is not set/i.test(m)) return false;
  if (/\((401|403)\)/.test(m)) return false;
  if (/endpoint does not exist/i.test(m)) return false;
  if (/^editChargeOffset:/.test(m)) return false;
  return /\(404\)|not found|no associated subscription|\(5\d\d\)|fetch failed|network|timeout/i.test(m);
}

function subscriptionIdForOrderRetrying(orderShopifyId, opts = {}) {
  return withRetries(
    async () => {
      const id = await subscriptionIdForOrder(orderShopifyId);
      // 200 with no subscription: either a genuine one-time order, or Loop has
      // the order but hasn't attached the contract yet. Indistinguishable here,
      // so treat it as retryable.
      if (!id) throw new Error('order has no associated subscription');
      return id;
    },
    { ...opts, retryable: isRetryableLoopError }
  );
}

// The write races Loop's ingest exactly like the lookup does — "Subscription not
// found" seconds after the subscription was created is a timing artefact, not a
// wrong id.
function editChargeOffsetRetrying(subscriptionId, chargeOffset, opts = {}) {
  return withRetries(() => editChargeOffset(subscriptionId, chargeOffset), {
    ...opts,
    retryable: isRetryableLoopError,
  });
}

// Set the subscription's charge offset — the number of days Loop charges BEFORE
// the scheduled delivery date. We send the HDS cutoff-days value here so the
// renewal is charged at the HDS cutoff.
//
//   PUT /subscription/{id}/chargeOffset   body: { chargeOffset: <int32> }
//
// NOTE: this endpoint is documented under Loop admin API v2026-04. If your
// LOOP_API_BASE points at an older version, set it to
// https://api.loopsubscriptions.com/admin/2026-04 (the customAttribute/note
// endpoints exist there too).
function editChargeOffset(subscriptionId, chargeOffset) {
  const offset = Number(chargeOffset);
  if (!subscriptionId) {
    return Promise.reject(new Error('editChargeOffset: subscriptionId is required'));
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return Promise.reject(
      new Error(`editChargeOffset: chargeOffset must be a non-negative integer, got ${chargeOffset}`)
    );
  }
  return loopRequest('PUT', `/subscription/${subscriptionId}/chargeOffset`, {
    chargeOffset: offset,
  });
}

// Loop's API takes [{key, value}]; values must be strings.
function toPairs(attributes) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => ({ key, value: String(value) }));
}

// Verify an inbound Loop webhook.
//
// NOTE: Loop have not yet confirmed their signing scheme. This implements the
// usual shape (HMAC-SHA256 of the raw body, base64, in a header) with both the
// header name and digest encoding configurable. Until it's confirmed, set
// LOOP_WEBHOOK_VERIFY=false to accept unsigned calls — but only behind a URL
// that isn't guessable, and switch verification on as soon as Loop confirm.
function verifyLoopWebhook(rawBody, headerValue) {
  if (String(process.env.LOOP_WEBHOOK_VERIFY || 'true').toLowerCase() === 'false') {
    return true;
  }

  const secret = process.env.LOOP_WEBHOOK_SECRET;
  if (!secret || !headerValue) return false;

  const encoding = process.env.LOOP_WEBHOOK_DIGEST === 'hex' ? 'hex' : 'base64';
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest(encoding);

  const a = Buffer.from(digest);
  const b = Buffer.from(String(headerValue));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  putCustomAttributes,
  patchCustomAttributes,
  updateNote,
  editChargeOffset,
  editChargeOffsetRetrying,
  readSubscriptionByOrderId,
  subscriptionIdForOrder,
  subscriptionIdForOrderRetrying,
  verifyLoopWebhook,
  loopRequest,
};
