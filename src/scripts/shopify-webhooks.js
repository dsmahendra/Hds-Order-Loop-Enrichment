// List and register this store's webhook subscriptions.
//
//   node src/scripts/shopify-webhooks.js                 list what exists
//   node src/scripts/shopify-webhooks.js --create        register orders/create
//   node src/scripts/shopify-webhooks.js --create --dry-run
//   node src/scripts/shopify-webhooks.js --delete 12345  remove one
//
// Registering through the API rather than the admin UI matters for one reason:
// a webhook created by an APP is signed with that app's client secret, while one
// created by hand in Settings -> Notifications is signed with the store's own
// signing secret. They are different values, and using the wrong one makes every
// delivery fail HMAC verification with no other symptom. Doing it here keeps the
// answer unambiguous: SHOPIFY_WEBHOOK_SECRET must be the app's client secret.
//
// Needs SHOPIFY_STORE, an Admin API token (env or OAuth install), and APP_URL.

require('dotenv').config();
const { shopifyRequest } = require('../shopify');

const TOPIC = 'orders/create';
const PATH = '/webhooks/shopify/orders/create';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--create') opts.create = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--delete') opts.delete = argv[++i];
    else throw new Error(`unknown flag ${a}`);
  }
  return opts;
}

function targetAddress() {
  const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (!appUrl) throw new Error('APP_URL is not set — needed to build the webhook address');
  return `${appUrl}${PATH}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log('store   :', process.env.SHOPIFY_STORE || 'MISSING');
  console.log('version :', process.env.SHOPIFY_API_VERSION || '2024-01');

  let address = null;
  try {
    address = targetAddress();
    console.log('address :', address);
  } catch (err) {
    console.log('address : (unavailable —', err.message + ')');
  }
  console.log('');

  if (opts.delete) {
    await shopifyRequest('DELETE', `/webhooks/${opts.delete}.json`);
    console.log(`Deleted webhook ${opts.delete}.`);
    return;
  }

  const existing = (await shopifyRequest('GET', '/webhooks.json?limit=250'))?.webhooks || [];

  console.log(`${existing.length} webhook subscription(s) registered by this app:`);
  if (!existing.length) console.log('  (none)');
  for (const w of existing) {
    const mine = address && w.address === address;
    console.log(`  [${w.id}] ${w.topic.padEnd(22)} ${w.address}${mine ? '   <- ours' : ''}`);
  }

  // Only subscriptions created by THIS app are listed; ones added by hand in the
  // admin, or by another app, are invisible here. So an empty list does not mean
  // the store has no orders/create webhook.
  console.log('\nNote: this lists only subscriptions owned by this app. Webhooks created');
  console.log('by hand in Settings -> Notifications, or by another app, are not shown.');

  if (!opts.create) {
    console.log('\nPass --create to register the orders/create subscription.');
    return;
  }

  const already = existing.find((w) => w.topic === TOPIC && w.address === address);
  if (already) {
    console.log(`\n${TOPIC} is already registered at that address (id ${already.id}) — nothing to do.`);
    return;
  }

  const wrongAddress = existing.filter((w) => w.topic === TOPIC && w.address !== address);
  if (wrongAddress.length) {
    console.log(`\nWarning: ${TOPIC} is registered at a DIFFERENT address:`);
    for (const w of wrongAddress) console.log(`  [${w.id}] ${w.address}`);
    console.log('Delete it with --delete <id> if it is stale; two subscriptions means two deliveries.');
  }

  if (opts.dryRun) {
    console.log(`\n[dry-run] would POST ${TOPIC} -> ${address}`);
    return;
  }

  const created = await shopifyRequest('POST', '/webhooks.json', {
    webhook: { topic: TOPIC, address, format: 'json' },
  });

  const w = created?.webhook;
  console.log(`\nRegistered ${w?.topic} -> ${w?.address}  (id ${w?.id})`);
  console.log('\nIMPORTANT: a webhook created by an app is signed with the APP\'S CLIENT SECRET.');
  console.log('Set SHOPIFY_WEBHOOK_SECRET to the same value as SHOPIFY_API_SECRET, or every');
  console.log('delivery will fail HMAC verification. Verify with a test order and check the');
  console.log('logs for "[webhook] queued order".');
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exitCode = 1;
});
