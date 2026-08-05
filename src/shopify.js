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

// Push enriched data onto the Shopify order as a metafield (non-destructive).
// Guarded by SYNC_TO_SHOPIFY; requires SHOPIFY_ADMIN_TOKEN + SHOPIFY_STORE.
async function writeEnrichmentMetafield(orderId, enriched) {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  const version = process.env.SHOPIFY_API_VERSION || '2024-01';
  if (!store || !token) throw new Error('SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN not set');

  const url = `https://${store}/admin/api/${version}/orders/${orderId}/metafields.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      metafield: {
        namespace: 'hds',
        key: 'enrichment',
        type: 'json',
        value: JSON.stringify(enriched),
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Shopify metafield write failed ${res.status}: ${text.slice(0, 200)}`);
  }
}

module.exports = {
  verifyWebhook,
  webhookDigest,
  getNoteAttribute,
  getHdsAttributes,
  normalizeDate,
  writeEnrichmentMetafield,
};
