// Does the Shopify Admin API actually accept our credentials?
//
//   node src/scripts/shopify-check.js
//
// Read-only. Answers three questions in order, because they fail differently:
//
//   1. WHICH secret is in SHOPIFY_ADMIN_TOKEN?  (prefix, not the value)
//   2. Is it accepted at all?                   GET /shop.json -> 401 if not
//   3. Can it read orders?                      GET /orders.json -> 403 if scope missing
//
// 401 is authentication (wrong/revoked token, or a token for a different store).
// 403 is authorisation (valid token, missing read_orders / write_orders). They
// have completely different fixes, so the distinction is the point of this script.

require('dotenv').config();
const { describeAdminToken } = require('../shopify');

const store = process.env.SHOPIFY_STORE;
const token = process.env.SHOPIFY_ADMIN_TOKEN;
const version = process.env.SHOPIFY_API_VERSION || '2024-01';

async function probe(label, path) {
  const url = `https://${store}/admin/api/${version}${path}`;
  try {
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' },
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body; the raw text is the reason.
    }
    return { label, path, status: res.status, data, text };
  } catch (err) {
    return { label, path, status: 0, error: err.message };
  }
}

async function main() {
  console.log('SHOPIFY_STORE       :', store || 'MISSING');
  console.log('SHOPIFY_API_VERSION :', version);
  console.log('SHOPIFY_ADMIN_TOKEN :', describeAdminToken(token));
  console.log('SHOPIFY_WEBHOOK_SECRET:', process.env.SHOPIFY_WEBHOOK_SECRET ? 'set (unrelated to the Admin API)' : 'MISSING');

  if (!store || !token) {
    console.log('\nCannot probe without both SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN.');
    process.exitCode = 1;
    return;
  }

  // /shop.json needs no special scope, so it isolates authentication.
  const shop = await probe('auth', '/shop.json');
  console.log(`\nGET /shop.json  -> ${shop.status || 'network error'}`);

  if (shop.status === 200) {
    console.log(`  authenticated as: ${shop.data?.shop?.name} (${shop.data?.shop?.myshopify_domain})`);
    if (shop.data?.shop?.myshopify_domain && shop.data.shop.myshopify_domain !== store) {
      console.log(`  ! token belongs to ${shop.data.shop.myshopify_domain}, but SHOPIFY_STORE is ${store}`);
    }
  } else if (shop.status === 401) {
    console.log(`  ${shop.data?.errors || shop.text?.slice(0, 160)}`);
    console.log('  -> the token is not recognised by this store. Either it is not an Admin API');
    console.log('     access token (shpat_/shpca_), it was revoked, the app was uninstalled,');
    console.log('     or it belongs to a different store.');
    process.exitCode = 1;
    return;
  } else if (shop.status === 404) {
    console.log('  -> store domain not found; check SHOPIFY_STORE');
    process.exitCode = 1;
    return;
  } else {
    console.log(`  ${shop.error || shop.data?.errors || shop.text?.slice(0, 160)}`);
    process.exitCode = 1;
    return;
  }

  // Authentication is fine by here, so anything below is about scopes.
  const orders = await probe('orders', '/orders.json?limit=1&status=any');
  console.log(`\nGET /orders.json -> ${orders.status}`);
  if (orders.status === 200) {
    console.log(`  read_orders OK (${orders.data?.orders?.length ?? 0} order(s) returned)`);
    console.log('\nAuthentication and read access are fine. A write can still fail with 403 if');
    console.log('write_orders was not granted — order:fix --dry-run reads only, so run it');
    console.log('without --dry-run to confirm the write scope.');
  } else if (orders.status === 403) {
    console.log(`  ${orders.data?.errors || orders.text?.slice(0, 160)}`);
    console.log('  -> the token is valid but lacks read_orders. Add read_orders + write_orders');
    console.log('     to the app Admin API scopes, then reinstall and use the new token.');
    process.exitCode = 1;
  } else {
    console.log(`  ${orders.data?.errors || orders.text?.slice(0, 160)}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exitCode = 1;
});
