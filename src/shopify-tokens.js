// Where the Admin API token comes from.
//
// Two sources, in order:
//   1. SHOPIFY_ADMIN_TOKEN — a legacy custom-app token, if one still exists
//   2. shopify_oauth_tokens — captured during the OAuth install
//
// Env first so nothing that works today changes. The stored token is cached in
// process after the first read: it is written once at install and then read on
// every Admin API call, so hitting Postgres each time would be pure overhead.

let cache = null; // { shop, token, scope }

function envToken() {
  const t = process.env.SHOPIFY_ADMIN_TOKEN;
  return t && String(t).trim() ? String(t).trim() : null;
}

async function saveToken(shop, accessToken, scope) {
  const { pool } = require('./db');
  await pool.query(
    `INSERT INTO shopify_oauth_tokens (shop, access_token, scope)
     VALUES ($1, $2, $3)
     ON CONFLICT (shop) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       scope        = EXCLUDED.scope,
       updated_at   = NOW()`,
    [shop, accessToken, scope || null]
  );
  cache = { shop, token: accessToken, scope: scope || null };
}

async function storedToken(shop) {
  if (cache && cache.shop === shop) return cache;
  if (!process.env.DATABASE_URL) return null;

  const { pool } = require('./db');
  const { rows } = await pool.query(
    'SELECT access_token, scope FROM shopify_oauth_tokens WHERE shop = $1',
    [shop]
  );
  if (!rows.length) return null;

  cache = { shop, token: rows[0].access_token, scope: rows[0].scope };
  return cache;
}

// Resolve the token for a shop, reporting WHERE it came from — a 401 is much
// easier to place when you know which of the two sources supplied the value.
async function resolveAdminToken(shop) {
  const fromEnv = envToken();
  if (fromEnv) return { token: fromEnv, source: 'SHOPIFY_ADMIN_TOKEN' };

  try {
    const stored = await storedToken(shop);
    if (stored) return { token: stored.token, source: 'OAuth install (database)', scope: stored.scope };
  } catch (err) {
    return { token: null, source: 'none', error: `could not read stored token: ${err.message}` };
  }

  return {
    token: null,
    source: 'none',
    error:
      'no Admin API token: SHOPIFY_ADMIN_TOKEN is not set and no OAuth install is ' +
      `stored for ${shop}. Visit /auth?shop=${shop} to install the app.`,
  };
}

function clearCache() {
  cache = null;
}

module.exports = { resolveAdminToken, saveToken, clearCache, envToken };
