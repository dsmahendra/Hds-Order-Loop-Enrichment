// Shopify OAuth — the only way to get an Admin API token for a Dev Dashboard app.
//
// Shopify retired legacy custom apps for this organisation, so the store admin no
// longer offers "Create an app" with a reveal-once Admin API token. A Dev
// Dashboard app exposes only a Client ID and a Secret (shpss_), and its access
// token is issued during install and delivered to a redirect URL. Nothing else
// yields a token, so the app has to be able to receive one.
//
// Two endpoints:
//   GET /auth?shop=<store>.myshopify.com   start the install
//   GET /auth/callback                     exchange the code for a token
//
// We request an OFFLINE token (the default when no `grant_options[]` is sent): it
// belongs to the app rather than a user session, and does not expire — so this
// runs once and the token is then read from the database forever.

const crypto = require('crypto');
const express = require('express');
const { saveToken } = require('./shopify-tokens');

const router = express.Router();

const SCOPES = process.env.SHOPIFY_OAUTH_SCOPES || 'read_orders,write_orders';

function config() {
  return {
    clientId: process.env.SHOPIFY_API_KEY,
    clientSecret: process.env.SHOPIFY_API_SECRET,
    appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
    // Only this store may install. Without it, anyone who found the URL could
    // trigger an install against their own shop and store a token here.
    allowedShop: process.env.SHOPIFY_STORE,
  };
}

// Shopify only ever sends *.myshopify.com; anything else is someone probing.
function isValidShopDomain(shop) {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(String(shop || ''));
}

// State nonce, signed rather than stored — the process may restart between the
// redirect out and the callback, and a signed value survives that.
function signState(shop, issuedAt, secret) {
  const payload = `${shop}:${issuedAt}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${mac}`;
}

function verifyState(state, secret, { maxAgeMs = 10 * 60 * 1000, now = null } = {}) {
  const [encoded, mac] = String(state || '').split('.');
  if (!encoded || !mac) return { ok: false, reason: 'malformed state' };

  let payload;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return { ok: false, reason: 'undecodable state' };
  }

  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(mac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'state signature mismatch' };
  }

  const [shop, issuedAt] = payload.split(':');
  const age = (now === null ? Date.now() : now) - Number(issuedAt);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
    return { ok: false, reason: 'state expired' };
  }
  return { ok: true, shop };
}

// Shopify signs OAuth redirects with the app secret: drop hmac (and the legacy
// signature), sort the rest, and HMAC the urlencoded query string.
function verifyOAuthHmac(query, secret) {
  const { hmac, signature, ...rest } = query || {};
  if (!hmac || !secret) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(rest[key])}`)
    .join('&');

  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmac));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function missingConfig(cfg) {
  return [
    !cfg.clientId && 'SHOPIFY_API_KEY',
    !cfg.clientSecret && 'SHOPIFY_API_SECRET',
    !cfg.appUrl && 'APP_URL',
  ].filter(Boolean);
}

// Shopify's `host` param is base64 of "admin.shopify.com/store/<handle>", so the
// shop can be recovered from it when `shop` itself is absent.
function shopFromHost(host) {
  if (!host) return null;
  let decoded;
  try {
    decoded = Buffer.from(String(host), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const handle = (decoded.match(/\/store\/([a-zA-Z0-9][a-zA-Z0-9-]*)/) || [])[1];
  return handle ? `${handle}.myshopify.com` : null;
}

// The App URL.
//
// After a managed install, Shopify loads the App URL with hmac + host and NO code
// — it expects an embedded app to exchange a session token there. This service has
// no UI to do that, so we send the request into the authorization-code flow
// instead, which is what actually yields the offline token we need.
//
// Landing here with no shop at all is a human opening the base URL, so answer with
// something more useful than a 404.
router.get('/', (req, res) => {
  const cfg = config();
  const shop = req.query.shop || shopFromHost(req.query.host);

  if (shop && isValidShopDomain(shop)) {
    // Signed request from Shopify: verify before redirecting anywhere, so this
    // cannot be used as an open redirect.
    if (req.query.hmac && !verifyOAuthHmac(req.query, cfg.clientSecret)) {
      console.warn('[oauth] app-url request rejected: HMAC verification failed');
      return res.status(401).send('invalid hmac');
    }
    if (cfg.allowedShop && shop !== cfg.allowedShop) {
      return res.status(403).send(`This app only installs on ${cfg.allowedShop}`);
    }
    console.log(`[oauth] app url hit for ${shop} — starting the authorization-code flow`);
    return res.redirect(`/auth?shop=${encodeURIComponent(shop)}`);
  }

  return res.type('text/plain').send(
    [
      'hds-order-enrichment',
      '',
      'This service has no UI. Endpoints:',
      '  GET  /health',
      '  GET  /auth?shop=<store>.myshopify.com   install and capture the Admin API token',
      '  POST /webhooks/shopify/orders/create',
      '  POST /webhooks/loop/order-upcoming',
      '',
    ].join('\n')
  );
});

// Start the install.
router.get('/auth', (req, res) => {
  const cfg = config();
  const missing = missingConfig(cfg);
  if (missing.length) {
    return res.status(500).send(`Cannot start OAuth: ${missing.join(', ')} not set.`);
  }

  const shop = String(req.query.shop || cfg.allowedShop || '');
  if (!isValidShopDomain(shop)) {
    return res.status(400).send('Pass ?shop=<store>.myshopify.com');
  }
  if (cfg.allowedShop && shop !== cfg.allowedShop) {
    return res.status(403).send(`This app only installs on ${cfg.allowedShop}`);
  }

  const state = signState(shop, Date.now(), cfg.clientSecret);
  const redirectUri = `${cfg.appUrl}/auth/callback`;
  const url =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(cfg.clientId)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;

  console.log(`[oauth] starting install for ${shop} (scopes: ${SCOPES})`);
  return res.redirect(url);
});

// Finish the install: verify, exchange, store.
router.get('/auth/callback', async (req, res) => {
  const cfg = config();
  const missing = missingConfig(cfg);
  if (missing.length) {
    return res.status(500).send(`Cannot complete OAuth: ${missing.join(', ')} not set.`);
  }

  const { shop, code } = req.query;

  if (!verifyOAuthHmac(req.query, cfg.clientSecret)) {
    console.warn('[oauth] callback rejected: HMAC verification failed');
    return res.status(401).send('invalid hmac');
  }
  if (!isValidShopDomain(shop)) {
    return res.status(400).send('invalid shop domain');
  }
  if (cfg.allowedShop && shop !== cfg.allowedShop) {
    console.warn(`[oauth] callback rejected: ${shop} is not ${cfg.allowedShop}`);
    return res.status(403).send('unexpected shop');
  }

  const state = verifyState(req.query.state, cfg.clientSecret);
  if (!state.ok || state.shop !== shop) {
    console.warn(`[oauth] callback rejected: ${state.reason || 'state shop mismatch'}`);
    return res.status(400).send('invalid state');
  }
  if (!code) return res.status(400).send('missing code');

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
      }),
    });

    const text = await tokenRes.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body — the raw text is the reason.
    }

    if (!tokenRes.ok || !data?.access_token) {
      const reason = data?.error_description || data?.error || text.slice(0, 200);
      console.error(`[oauth] token exchange failed (${tokenRes.status}): ${reason}`);
      return res.status(502).send(`Token exchange failed: ${reason}`);
    }

    await saveToken(shop, data.access_token, data.scope || SCOPES);

    // Never log the token itself; the prefix is enough to confirm the kind.
    console.log(
      `[oauth] installed on ${shop} — stored ${String(data.access_token).slice(0, 6)}… ` +
        `(scope: ${data.scope || SCOPES})`
    );

    return res.send(
      `Installed on ${shop}.\nScopes: ${data.scope || SCOPES}\n\n` +
        'The Admin API token is stored. Run "npm run shopify:check" to confirm.'
    );
  } catch (err) {
    console.error('[oauth] callback failed:', err.message);
    return res.status(500).send(`OAuth failed: ${err.message}`);
  }
});

module.exports = router;
module.exports.isValidShopDomain = isValidShopDomain;
module.exports.signState = signState;
module.exports.verifyState = verifyState;
module.exports.verifyOAuthHmac = verifyOAuthHmac;
module.exports.shopFromHost = shopFromHost;
