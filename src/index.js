require('dotenv').config();
const express = require('express');
const webhooks = require('./routes/webhooks');
const loopWebhooks = require('./routes/loop-webhooks');
const { initQueueProcessor } = require('./jobs/enrich-orders-queue');

const app = express();

// Webhook routes MUST use the raw body parser so HMAC verification sees the exact
// bytes Shopify (and Loop) signed. Mount this BEFORE any express.json() parser.
app.use('/webhooks', express.raw({ type: 'application/json' }), webhooks);
app.use('/webhooks', express.raw({ type: 'application/json' }), loopWebhooks);

// JSON parser for everything else (health, future admin endpoints).
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, service: 'hds-order-enrichment' }));

const PORT = Number(process.env.PORT || 3002);
app.listen(PORT, () => {
  console.log(`[server] hds-order-enrichment listening on :${PORT}`);
  initQueueProcessor();
});
