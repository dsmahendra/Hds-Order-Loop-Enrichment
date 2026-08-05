const { pool } = require('../db');
const { enrichFromHds, enrichFromAttributes } = require('../lib/enrich');
const { writeEnrichmentMetafield } = require('../shopify');

const INTERVAL_MS = Number(process.env.ENRICH_INTERVAL_MS || 10000);
const BATCH_SIZE = Number(process.env.ENRICH_BATCH_SIZE || 10);
const MAX_ATTEMPTS = Number(process.env.ENRICH_MAX_ATTEMPTS || 5);
const SYNC = String(process.env.SYNC_TO_SHOPIFY || '').toLowerCase() === 'true';

let running = false; // prevents overlapping ticks

async function processOne(row) {
  // Case 1: the order already carries the full hds_* set from checkout — use it
  // directly, no API call. Case 2: incomplete or absent (Loop renewals, older
  // orders, a checkout extension failure) — resolve against the HDS API.
  let hdsSource = 'attributes';
  let result = enrichFromAttributes(row.source_attributes);

  if (!result.ok) {
    hdsSource = 'api';
    result = await enrichFromHds({
      postcode: row.delivery_location_id,
      suburb: row.suburb,
      deliveryDate: toISODate(row.delivery_date),
      additionalParams: {
        delivery_time: row.delivery_time || undefined,
      },
    });
  }

  if (!result.ok) {
    const attempts = row.attempts + 1;
    const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    await pool.query(
      `UPDATE orders_to_enrich
         SET status = $2, attempts = $3, error_message = $4, updated_at = NOW()
       WHERE id = $1`,
      [row.id, status, attempts, result.reason]
    );
    console.warn(`[queue] order ${row.order_id} enrich failed (attempt ${attempts}): ${result.reason}`);
    return;
  }

  const e = result.data;
  await pool.query(
    `INSERT INTO order_enrichments
       (order_id, hds_delivery_date, hds_delivery_time, hds_pack_date,
        hds_production_date, hds_region, hds_suburb, hds_postcode,
        hds_additional_params, hds_response, hds_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (order_id) DO UPDATE SET
       hds_delivery_date = EXCLUDED.hds_delivery_date,
       hds_delivery_time = EXCLUDED.hds_delivery_time,
       hds_pack_date = EXCLUDED.hds_pack_date,
       hds_production_date = EXCLUDED.hds_production_date,
       hds_region = EXCLUDED.hds_region,
       hds_suburb = EXCLUDED.hds_suburb,
       hds_postcode = EXCLUDED.hds_postcode,
       hds_additional_params = EXCLUDED.hds_additional_params,
       hds_response = EXCLUDED.hds_response,
       hds_source = EXCLUDED.hds_source,
       updated_at = NOW()`,
    [
      row.order_id,
      e.hds_delivery_date,
      row.delivery_time || null,
      e.hds_pack_date,
      e.hds_production_date,
      e.hds_region,
      e.hds_suburb,
      e.hds_postcode,
      e.hds_additional_parameters || null,
      e.hds_response || null,
      hdsSource,
    ]
  );

  if (SYNC) {
    try {
      await writeEnrichmentMetafield(row.order_id, { ...e, hds_delivery_time: row.delivery_time });
    } catch (err) {
      // Non-fatal: enrichment is stored in our DB regardless.
      console.warn(`[queue] order ${row.order_id} Shopify sync failed: ${err.message}`);
    }
  }

  await pool.query(
    `UPDATE orders_to_enrich
       SET status = 'processed', attempts = attempts + 1, error_message = NULL, updated_at = NOW()
     WHERE id = $1`,
    [row.id]
  );
  console.log(`[queue] order ${row.order_id} enriched (via ${hdsSource}).`);
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM orders_to_enrich
        WHERE status = 'pending' AND attempts < $1
        ORDER BY id ASC
        LIMIT $2`,
      [MAX_ATTEMPTS, BATCH_SIZE]
    );
    for (const row of rows) {
      try {
        await processOne(row);
      } catch (err) {
        console.error(`[queue] unexpected error on order ${row.order_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[queue] tick error:', err.message);
  } finally {
    running = false;
  }
}

function initQueueProcessor() {
  console.log(`[queue] processor started (every ${INTERVAL_MS}ms, batch ${BATCH_SIZE})`);
  setInterval(tick, INTERVAL_MS);
}

// Normalise a DATE column (JS Date or string) to "YYYY-MM-DD" for the API match.
function toISODate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

module.exports = { initQueueProcessor };
