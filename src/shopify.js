const crypto = require('crypto');

// The HMAC we expect for a raw body, or null when no secret is configured.
// Exported so a rejected webhook can be diagnosed: comparing digest prefixes
// shows whether the secret is merely WRONG vs missing, and leaks nothing — the
// digest is what Shopify puts in a request header, not a credential.
function webhookDigest(rawBody) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return null;
  return crypto
    .createHmac('sha256', secret)
    .update(rawBody) // rawBody must be a Buffer / raw string, NOT parsed JSON
    .digest('base64');
}

// Verify a Shopify webhook HMAC against the raw request body.
function verifyWebhook(rawBody, hmacHeader) {
  const digest = webhookDigest(rawBody);
  if (!digest || !hmacHeader) return false;

  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Read a note attribute value by name from a Shopify order payload.
function getNoteAttribute(order, name) {
  const attrs = order?.note_attributes || [];
  const hit = attrs.find((a) => a?.name === name);
  return hit ? hit.value : null;
}

// The checkout extension writes the detailed HDS set with human-readable labels
// ("HDS Delivery Date"), dates formatted yyyy/mm/dd. Map those (and the legacy
// snake_case spelling) back to the canonical hds_* keys with ISO dates, so the
// rest of the pipeline (enrichFromAttributes, DB columns) is format-agnostic.
const LABEL_TO_KEY = {
  'HDS Delivery Date': 'hds_delivery_date',
  'HDS Delivery Formatted': 'hds_delivery_formatted',
  'HDS Delivery Day': 'hds_delivery_day',
  'HDS Delivery Window': 'hds_delivery_window',
  'HDS Schedule ID': 'hds_schedule_id',
  'HDS Pack Date': 'hds_pack_date',
  'HDS Production Date': 'hds_production_date',
  'HDS Region': 'hds_region',
  'HDS Suburb': 'hds_suburb',
  'HDS Postcode': 'hds_postcode',
};

const DATE_KEYS = new Set(['hds_delivery_date', 'hds_pack_date', 'hds_production_date']);

// yyyy/mm/dd (or already ISO) -> yyyy-mm-dd.
function normalizeDate(value) {
  return String(value || '').trim().replace(/\//g, '-');
}

function getHdsAttributes(order) {
  const out = {};
  for (const attr of order?.note_attributes || []) {
    const name = attr?.name;
    if (typeof name !== 'string' || attr.value === '' || attr.value == null) continue;

    // Accept both the labelled keys and the legacy hds_* spelling.
    const key = LABEL_TO_KEY[name] || (name.startsWith('hds_') ? name : null);
    if (!key) continue;

    out[key] = DATE_KEYS.has(key) ? normalizeDate(attr.value) : attr.value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// One place for Admin API calls: base URL, auth header, and error shape.
function shopifyRequest(method, path, body) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || '2024-01';
  if (!store || !token) {
    const missing = [!store && 'SHOPIFY_STORE', !token && 'SHOPIFY_ADMIN_TOKEN'].filter(Boolean);
    throw new Error(
      `${missing.join(' and ')} not set — the Admin API cannot be reached. ` +
        'Copy the values from Railway (Variables tab) into your local .env, or run this on the Railway shell.'
    );
  }

  return fetch(`https://${store}/admin/api/${version}${path}`, {
    method,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => {
    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body — the raw text carries the reason.
    }
    if (!res.ok) {
      const reason = data?.errors ? JSON.stringify(data.errors) : text.slice(0, 200);
      throw new Error(`Shopify ${method} ${path} failed ${res.status}: ${reason}`);
    }
    return data;
  });
}

function getOrder(orderId) {
  return shopifyRequest('GET', `/orders/${orderId}.json`);
}

// Merge updates into an order's existing note_attributes.
//
// The Admin API REPLACES note_attributes wholesale, so sending only our keys
// would delete Delivery-Time, Custom-Attribute-*, _amp_sc and everything else the
// order carries. Existing entries keep their position; new keys are appended.
function mergeNoteAttributes(existing, updates) {
  const out = (Array.isArray(existing) ? existing : []).map((a) => ({ name: a?.name, value: a?.value }));
  for (const [name, value] of Object.entries(updates || {})) {
    if (value === null || value === undefined || value === '') continue;
    const hit = out.find((a) => a.name === name);
    if (hit) hit.value = String(value);
    else out.push({ name, value: String(value) });
  }
  return out;
}

// Same replace-semantics problem for tags. removePrefixes drops superseded tags
// (a stale Pick-Pack-Date-* from the previous cycle) so they don't accumulate.
function mergeTags(existing, addTags = [], removePrefixes = []) {
  const current = String(existing || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !removePrefixes.some((prefix) => t.startsWith(prefix)));

  for (const tag of addTags) {
    if (!tag) continue;
    if (!current.some((t) => t.toLowerCase() === String(tag).toLowerCase())) current.push(String(tag));
  }
  return current.join(', ');
}

// Write note attributes (and optionally tags) back onto an order.
//
// Pass `order` — e.g. the webhook payload — to merge without re-fetching;
// otherwise the current order is read first.
async function updateOrderAttributes(orderId, { attributes = {}, addTags = [], removeTagPrefixes = [], order = null } = {}) {
  const existing = order || (await getOrder(orderId))?.order;

  const payload = {
    order: {
      id: Number(orderId),
      note_attributes: mergeNoteAttributes(existing?.note_attributes, attributes),
    },
  };

  if (addTags.length || removeTagPrefixes.length) {
    payload.order.tags = mergeTags(existing?.tags, addTags, removeTagPrefixes);
  }

  return shopifyRequest('PUT', `/orders/${orderId}.json`, payload);
}

// Push enriched data onto the Shopify order as a metafield (non-destructive).
// Guarded by SYNC_TO_SHOPIFY; requires SHOPIFY_ADMIN_TOKEN + SHOPIFY_STORE.
function writeEnrichmentMetafield(orderId, enriched) {
  return shopifyRequest('POST', `/orders/${orderId}/metafields.json`, {
    metafield: {
      namespace: 'hds',
      key: 'enrichment',
      type: 'json',
      value: JSON.stringify(enriched),
    },
  });
}

module.exports = {
  verifyWebhook,
  webhookDigest,
  getNoteAttribute,
  getHdsAttributes,
  normalizeDate,
  writeEnrichmentMetafield,
  shopifyRequest,
  getOrder,
  updateOrderAttributes,
  mergeNoteAttributes,
  mergeTags,
};
