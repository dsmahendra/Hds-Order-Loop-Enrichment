-- HDS Order Enrichment — new tables only.
--
-- NOTE: this service does NOT create suburbs / regions / delivery_schedules.
-- Those already exist in the shared HDS database (with SERIAL ids). Enrichment
-- reads delivery data from the HDS public API, not by re-deriving it here.

-- Work queue: one row per order awaiting enrichment.
CREATE TABLE IF NOT EXISTS orders_to_enrich (
  id                   SERIAL PRIMARY KEY,
  order_id             BIGINT NOT NULL,
  delivery_date        DATE,
  delivery_location_id VARCHAR(10),   -- postcode captured at checkout
  delivery_time        VARCHAR(50),
  suburb               VARCHAR(255),  -- shipping city, used for the HDS lookup
  status               VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|processed|failed|skipped
  attempts             INT NOT NULL DEFAULT 0,
  error_message        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency: a Shopify order is only ever queued once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_to_enrich_order ON orders_to_enrich(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_to_enrich_status ON orders_to_enrich(status);

-- Where the order came from: 'checkout' (customer picked a date) or 'loop'
-- (subscription renewal, identified by Shopify's app_id). Lets us report on the
-- Loop pipeline separately instead of inferring it from a missing Delivery-Date.
ALTER TABLE orders_to_enrich ADD COLUMN IF NOT EXISTS source VARCHAR(20);
ALTER TABLE orders_to_enrich ADD COLUMN IF NOT EXISTS subscription_id BIGINT;

-- Every hds_* note attribute the order arrived with. The checkout extension
-- already writes the full set, so when it's complete we enrich straight from
-- here and skip the HDS API call entirely. Incomplete (or a Loop renewal that
-- slipped through) falls back to the API.
ALTER TABLE orders_to_enrich ADD COLUMN IF NOT EXISTS source_attributes JSONB;

-- Did the write onto the SHOPIFY order succeed? Distinct from status, which
-- tracks our own enrichment tables.
--
-- Without this the two pipelines were confused: a failed pack-date write left
-- status 'pending', the enrichment worker moved it to 'processed', and the retry
-- job — which only looks at 'skipped' and 'failed' — never saw it. The order sat
-- with no pack date and nothing indicated anything was wrong. Defaults TRUE so
-- existing rows are not all re-attempted on deploy.
ALTER TABLE orders_to_enrich
  ADD COLUMN IF NOT EXISTS hds_write_ok BOOLEAN NOT NULL DEFAULT TRUE;

-- Partial: the rows worth retrying are the few false ones, so the index stays
-- small however large the table grows.
CREATE INDEX IF NOT EXISTS idx_orders_to_enrich_hds_write
  ON orders_to_enrich(id) WHERE hds_write_ok = FALSE;
CREATE INDEX IF NOT EXISTS idx_orders_to_enrich_subscription
  ON orders_to_enrich(subscription_id);

-- Final enriched result, stored in our own DB (not Shopify).
CREATE TABLE IF NOT EXISTS order_enrichments (
  id                      SERIAL PRIMARY KEY,
  order_id                BIGINT UNIQUE NOT NULL,
  hds_delivery_date       DATE,
  hds_delivery_time       VARCHAR(50),
  hds_pack_date           DATE,
  hds_production_date     DATE,
  hds_region              VARCHAR(255),
  hds_suburb              VARCHAR(255),
  hds_postcode            VARCHAR(10),
  hds_additional_params   JSONB,
  hds_response            JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Which path produced this row: 'attributes' (read off the order, no API call)
-- or 'api' (looked up against the HDS public API).
ALTER TABLE order_enrichments ADD COLUMN IF NOT EXISTS hds_source VARCHAR(20);

-- Loop subscription renewals.
--
-- Loop auto-charges never reach checkout, so the order they create carries no
-- Delivery-Date. We fix that BEFORE the charge: on Loop's order/upcoming webhook
-- we resolve the delivery date for that cycle and write it onto the subscription
-- as a custom attribute (PUT /subscription/{id}/customAttribute). Loop then
-- stamps it onto the Shopify order, and the normal orders/create path enriches
-- it with no special-casing.
--
-- This table is the audit trail of what we wrote, and the map from a Loop
-- subscription to the delivery date we chose for a given charge.
CREATE TABLE IF NOT EXISTS loop_subscription_deliveries (
  id                   SERIAL PRIMARY KEY,
  subscription_id      BIGINT NOT NULL,
  loop_order_id        BIGINT,        -- Loop's own order id, when the payload has it
  shopify_order_id     BIGINT,        -- filled in once the renewal order arrives
  charge_date          DATE,          -- from nextBillingDate / nextBillingDateEpoch
  delivery_date        DATE,          -- what we resolved and wrote back
  delivery_time        VARCHAR(50),
  delivery_location_id VARCHAR(10),
  suburb               VARCHAR(255),
  status               VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|written|failed|skipped
  attempts             INT NOT NULL DEFAULT 0,
  error_message        TEXT,
  payload              JSONB,         -- raw order/upcoming body, for debugging
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per subscription per charge: a redelivered webhook must not double-write.
CREATE UNIQUE INDEX IF NOT EXISTS uq_loop_sub_charge
  ON loop_subscription_deliveries(subscription_id, charge_date);
CREATE INDEX IF NOT EXISTS idx_loop_sub_status
  ON loop_subscription_deliveries(status);

-- Shopify OAuth tokens.
--
-- Shopify retired legacy custom apps for this org, so there is no reveal-once
-- Admin API token to paste into an env var: a Dev Dashboard app only exposes a
-- Client ID and Secret, and its access token is issued through OAuth at install.
-- We capture that token here. Offline access tokens do not expire, so this is
-- written once per store and then just read.
CREATE TABLE IF NOT EXISTS shopify_oauth_tokens (
  shop         VARCHAR(255) PRIMARY KEY,   -- e.g. staging-workoutmeals.myshopify.com
  access_token TEXT NOT NULL,
  scope        TEXT,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Why the rewrite chose the date it did.
--
-- The rewrite overwrites the stale attributes, so the input that drove the
-- decision is gone by the time anyone asks why. These record it: the delivery date
-- the order arrived with, and what the resolver matched on ("schedule 10",
-- "Sunday", "earliest available"). Without them, diagnosing a wrong date means
-- hunting through container logs that may already have rotated.
ALTER TABLE orders_to_enrich ADD COLUMN IF NOT EXISTS previous_delivery_date DATE;
ALTER TABLE orders_to_enrich ADD COLUMN IF NOT EXISTS rewrite_matched_by VARCHAR(120);
ALTER TABLE orders_to_enrich ADD COLUMN IF NOT EXISTS rewrite_schedule_source VARCHAR(120);
