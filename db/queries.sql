-- HDS Order Enrichment — operational queries.
--
-- Postgres. Run against the same DATABASE_URL the service uses.
-- Tables: orders_to_enrich (work queue) and order_enrichments (result),
-- both created by db/schema.sql.


-- ===========================================================================
-- 1. PIPELINE HEALTH
-- ===========================================================================

-- 1.1 Queue status breakdown — the first thing to check.
SELECT status,
       COUNT(*)                       AS orders,
       MIN(created_at)                AS oldest,
       MAX(updated_at)                AS last_touched
FROM orders_to_enrich
GROUP BY status
ORDER BY orders DESC;


-- 1.2 Pending backlog with age. Anything older than a few minutes means the
--     background job (every ENRICH_INTERVAL_MS, default 10s) is not running.
SELECT id,
       order_id,
       delivery_date,
       delivery_location_id AS postcode,
       suburb,
       attempts,
       NOW() - created_at   AS waiting_for
FROM orders_to_enrich
WHERE status = 'pending'
ORDER BY created_at ASC
LIMIT 50;


-- 1.3 Failures grouped by reason — tells you whether it's a postcode problem,
--     a date-not-in-options problem, or the HDS API being down.
SELECT error_message,
       COUNT(*)            AS orders,
       MIN(delivery_date)  AS first_delivery_date,
       MAX(delivery_date)  AS last_delivery_date
FROM orders_to_enrich
WHERE status = 'failed'
GROUP BY error_message
ORDER BY orders DESC;


-- 1.4 Orders burning retries but not yet dead (attempts < ENRICH_MAX_ATTEMPTS).
SELECT order_id, delivery_date, suburb, attempts, error_message, updated_at
FROM orders_to_enrich
WHERE status = 'pending' AND attempts > 0
ORDER BY attempts DESC, updated_at ASC;


-- 1.5 Queued but no enrichment row — should be empty for status='processed'.
--     A non-empty result means the queue and the result table disagree.
SELECT q.order_id, q.status, q.attempts, q.error_message
FROM orders_to_enrich q
LEFT JOIN order_enrichments e ON e.order_id = q.order_id
WHERE e.order_id IS NULL
  AND q.status = 'processed';


-- ===========================================================================
-- 2. HDS ADDITIONAL DATA (hds_additional_params / hds_response)
-- ===========================================================================

-- 2.1 Full enriched view — queue row joined to the stored HDS result.
SELECT q.order_id,
       q.status,
       e.hds_delivery_date,
       e.hds_delivery_time,
       e.hds_pack_date,
       e.hds_production_date,
       e.hds_region,
       e.hds_suburb,
       e.hds_postcode,
       e.hds_additional_params,
       e.updated_at
FROM orders_to_enrich q
JOIN order_enrichments e ON e.order_id = q.order_id
ORDER BY e.updated_at DESC
LIMIT 100;


-- 2.2 Which extra keys does the HDS API actually return? enrich.js keeps every
--     field of the matched option except delivery_date/pack_date/production_date,
--     so this is the live shape of the "additional data".
SELECT key AS additional_param,
       COUNT(*) AS orders
FROM order_enrichments e,
     LATERAL jsonb_object_keys(e.hds_additional_params) AS key
WHERE e.hds_additional_params IS NOT NULL
GROUP BY key
ORDER BY orders DESC;


-- 2.3 Read one specific key out of the additional params (change 'cutoff_time').
SELECT order_id,
       hds_delivery_date,
       hds_additional_params ->> 'cutoff_time' AS cutoff_time
FROM order_enrichments
WHERE hds_additional_params ? 'cutoff_time'
ORDER BY hds_delivery_date DESC;


-- 2.4 Enriched but missing the fields you care about — HDS matched the date but
--     returned no pack/production date.
SELECT order_id, hds_delivery_date, hds_region, hds_suburb,
       hds_pack_date, hds_production_date
FROM order_enrichments
WHERE hds_pack_date IS NULL
   OR hds_production_date IS NULL
ORDER BY hds_delivery_date DESC;


-- 2.4b Which path produced each enrichment: read straight off the order's
--      hds_* attributes, or looked up against the HDS API. A high 'api' count
--      for checkout orders means the extension isn't writing a complete set.
SELECT hds_source, COUNT(*) AS orders
FROM order_enrichments
GROUP BY hds_source
ORDER BY orders DESC;


-- 2.5 No additional data at all — the option carried nothing beyond the three
--     core dates.
SELECT COUNT(*) FILTER (WHERE hds_additional_params IS NULL) AS without_extras,
       COUNT(*) FILTER (WHERE hds_additional_params IS NOT NULL) AS with_extras,
       COUNT(*) AS total
FROM order_enrichments;


-- 2.6 Full raw API response for one order — for debugging a bad match.
SELECT jsonb_pretty(hds_response)
FROM order_enrichments
WHERE order_id = 1234567890;   -- <- your Shopify order id


-- ===========================================================================
-- 3. THE LOOP SUBSCRIPTION GAP
-- ===========================================================================
-- Loop auto-charge orders are created without the checkout picker, so they carry
-- no Delivery-Date note attribute. src/routes/webhooks.js returns before the
-- INSERT for those orders — they are NEVER written to orders_to_enrich.
--
-- Consequence: no query below can find a Loop renewal, because there is no row.
-- The queries here measure the gap and prepare the backfill.

-- 3.1 Enrichment coverage per day. If Shopify shows N orders for a day and this
--     returns fewer, the difference is (mostly) Loop renewals that were dropped.
SELECT delivery_date,
       COUNT(*)                                          AS queued,
       COUNT(*) FILTER (WHERE status = 'processed')      AS enriched,
       COUNT(*) FILTER (WHERE status = 'failed')         AS failed,
       COUNT(*) FILTER (WHERE status = 'pending')        AS pending
FROM orders_to_enrich
GROUP BY delivery_date
ORDER BY delivery_date DESC;


-- 3.2 Orders queued per calendar day vs. orders created. Compare against the
--     Shopify order count for the same window to size the Loop gap.
SELECT created_at::date AS day,
       COUNT(*)         AS queued_orders,
       COUNT(DISTINCT delivery_location_id) AS distinct_postcodes
FROM orders_to_enrich
GROUP BY day
ORDER BY day DESC
LIMIT 30;


-- 3.3 RECOMMENDED SCHEMA CHANGE so the gap becomes queryable.
--     schema.sql already documents 'skipped' as a valid status, but nothing
--     ever writes it. Log the skip in the webhook instead of returning silently:
--
--       INSERT INTO orders_to_enrich (order_id, suburb, status, error_message)
--       VALUES ($1, $2, 'skipped', 'no Delivery-Date (likely Loop auto-charge)')
--       ON CONFLICT (order_id) DO NOTHING;
--
--     Then this becomes your Loop-renewal worklist:
SELECT order_id, suburb, created_at
FROM orders_to_enrich
WHERE status = 'skipped'
ORDER BY created_at DESC;


-- 3.4 Backfill: once you can compute a delivery date for a Loop renewal (from
--     Loop's next-charge date + the HDS schedule), flip the skipped row back to
--     pending and the existing job picks it up on its next tick.
UPDATE orders_to_enrich
   SET delivery_date        = $2,     -- computed renewal delivery date
       delivery_location_id = $3,     -- postcode
       suburb               = $4,
       status               = 'pending',
       attempts             = 0,
       error_message        = NULL,
       updated_at           = NOW()
WHERE order_id = $1
  AND status = 'skipped';


-- 3.5 Loop pre-charge writes — did we set a Delivery-Date before each charge?
SELECT status,
       COUNT(*)            AS subscriptions,
       MIN(charge_date)    AS earliest_charge,
       MAX(charge_date)    AS latest_charge
FROM loop_subscription_deliveries
GROUP BY status
ORDER BY subscriptions DESC;


-- 3.6 Writes that failed — these renewals will arrive with no delivery date.
--     Act on these BEFORE the charge date passes.
SELECT subscription_id, charge_date, suburb, delivery_location_id,
       attempts, error_message, updated_at
FROM loop_subscription_deliveries
WHERE status = 'failed'
  AND charge_date >= CURRENT_DATE
ORDER BY charge_date ASC;


-- 3.7 Did the write actually land? Written rows whose renewal order has arrived
--     but that never got linked back to a Shopify order.
SELECT subscription_id, charge_date, delivery_date, shopify_order_id
FROM loop_subscription_deliveries
WHERE status = 'written'
  AND charge_date < CURRENT_DATE
  AND shopify_order_id IS NULL
ORDER BY charge_date DESC;


-- 3.8 Loop renewals that still arrived without a Delivery-Date. Non-empty means
--     the pre-charge write missed its window — compare against W2 (lead time).
SELECT order_id, subscription_id, created_at, error_message
FROM orders_to_enrich
WHERE source = 'loop' AND status = 'skipped'
ORDER BY created_at DESC;


-- 3.9 Enrichment split by source — checkout vs Loop renewal.
SELECT source,
       COUNT(*)                                     AS orders,
       COUNT(*) FILTER (WHERE status = 'processed') AS enriched,
       COUNT(*) FILTER (WHERE status = 'skipped')   AS skipped,
       COUNT(*) FILTER (WHERE status = 'failed')    AS failed
FROM orders_to_enrich
GROUP BY source
ORDER BY orders DESC;


-- ===========================================================================
-- 4. LOOP (PL/pgSQL) BLOCKS FOR BATCH WORK
-- ===========================================================================

-- 4.1 Requeue every failed order in batches, so you don't take one giant lock.
--     Use after fixing the underlying cause (HDS API back up, postcode added).
DO $$
DECLARE
  batch_size CONSTANT INT := 500;
  moved      INT;
  total      INT := 0;
BEGIN
  LOOP
    WITH batch AS (
      SELECT id
      FROM orders_to_enrich
      WHERE status = 'failed'
      ORDER BY id
      LIMIT batch_size
      FOR UPDATE SKIP LOCKED
    )
    UPDATE orders_to_enrich q
       SET status = 'pending', attempts = 0, error_message = NULL, updated_at = NOW()
      FROM batch
     WHERE q.id = batch.id;

    GET DIAGNOSTICS moved = ROW_COUNT;
    EXIT WHEN moved = 0;

    total := total + moved;
    RAISE NOTICE 'requeued % (running total %)', moved, total;
  END LOOP;

  RAISE NOTICE 'done — % orders requeued', total;
END $$;


-- 4.2 Row-by-row loop over pending orders — for inspection/reporting when you
--     want per-order output rather than a set-based update.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT order_id, delivery_date, delivery_location_id, suburb, attempts
    FROM orders_to_enrich
    WHERE status = 'pending'
    ORDER BY id
  LOOP
    RAISE NOTICE 'order % | date % | postcode % | suburb % | attempts %',
      r.order_id, r.delivery_date, r.delivery_location_id, r.suburb, r.attempts;
  END LOOP;
END $$;


-- 4.3 Loop over distinct postcode+date pairs — one HDS API call covers every
--     order in the group, so this is the list of calls the job actually needs.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT delivery_location_id AS postcode,
           suburb,
           delivery_date,
           COUNT(*) AS orders
    FROM orders_to_enrich
    WHERE status = 'pending'
    GROUP BY delivery_location_id, suburb, delivery_date
    ORDER BY delivery_date
  LOOP
    RAISE NOTICE '% orders -> /api/public/delivery-options?postcode=%&suburb=% (date %)',
      r.orders, r.postcode, r.suburb, r.delivery_date;
  END LOOP;
END $$;


-- 4.4 Concurrency-safe claim, if you ever run more than one worker instance.
--     The current job (src/jobs/enrich-orders-queue.js) uses a plain SELECT with
--     no lock, so two instances would process the same rows. This is the fix:
UPDATE orders_to_enrich
   SET status = 'processing', updated_at = NOW()
 WHERE id IN (
   SELECT id
   FROM orders_to_enrich
   WHERE status = 'pending' AND attempts < 5
   ORDER BY id
   LIMIT 10
   FOR UPDATE SKIP LOCKED
 )
RETURNING *;


-- ===========================================================================
-- 5. REPORTING
-- ===========================================================================

-- 5.1 Volume by region and pack date — the operational view.
SELECT hds_region,
       hds_pack_date,
       hds_production_date,
       COUNT(*) AS orders
FROM order_enrichments
WHERE hds_delivery_date >= CURRENT_DATE
GROUP BY hds_region, hds_pack_date, hds_production_date
ORDER BY hds_pack_date, hds_region;


-- 5.2 Enrichment latency — queued to enriched.
SELECT q.order_id,
       q.created_at                     AS queued_at,
       e.created_at                     AS enriched_at,
       e.created_at - q.created_at      AS latency
FROM orders_to_enrich q
JOIN order_enrichments e ON e.order_id = q.order_id
ORDER BY latency DESC
LIMIT 25;


-- 5.3 Suburbs the API keeps rejecting — candidates for missing HDS coverage.
SELECT suburb,
       delivery_location_id AS postcode,
       COUNT(*)             AS failed_orders,
       MAX(error_message)   AS sample_error
FROM orders_to_enrich
WHERE status = 'failed'
GROUP BY suburb, delivery_location_id
ORDER BY failed_orders DESC;
