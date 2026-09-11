// Run one alert-digest pass now, instead of waiting for its interval.
//
//   npm run alerts:digest
//
// Useful for confirming SMTP is actually configured correctly before trusting
// the scheduled job with it, and for getting an immediate summary on demand.

require('dotenv').config();
const { runDigest } = require('../jobs/alert-digest');
const { isConfigured } = require('../lib/mailer');

console.log('SMTP configured:', isConfigured() ? 'yes' : 'no — this run will log what it would send and stop there');
console.log('');

runDigest()
  .then((out) => {
    if (!out.sent && out.count > 0) process.exitCode = 1; // outstanding orders, but nothing actually emailed
  })
  .catch((err) => {
    console.error('\nERROR:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (process.env.DATABASE_URL) {
      try {
        await require('../db').pool.end();
      } catch {
        // Nothing to close, or already closed.
      }
    }
  });
