// Run one pass of the sweep now, instead of waiting for its interval.
//
//   npm run packdates:sweep
//   npm run packdates:sweep -- --hours 48
//   npm run packdates:sweep -- --hours 2 --min-age 0
//
// The same code the service runs on a timer, so this answers "is every recent
// order complete?" without a deploy or a log dig. A quiet pass prints one line
// and makes one or two API calls.
//
// --min-age 0 includes orders created moments ago. Useful right after a Loop run
// when you want to see the state immediately, but expect the odd order to be
// mid-webhook and get fixed twice.

require('dotenv').config();

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--hours') opts.hours = argv[++i];
    else if (a === '--min-age') opts.minAge = argv[++i];
    else if (a === '--max') opts.max = argv[++i];
    else throw new Error(`unknown flag ${a}`);
  }
  return opts;
}

// A mistyped flag should read like a usage message, not like a crash.
function fail(message) {
  console.error(message);
  console.error('\nUsage: npm run packdates:sweep -- [--hours N] [--min-age N] [--max N]');
  process.exit(1);
}

let opts = {};
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  fail(err.message);
}

// The job reads these at require time, so they must be set before it is loaded.
if (opts.hours !== undefined) {
  if (!/^\d+(\.\d+)?$/.test(opts.hours)) fail(`--hours ${opts.hours} is not a number`);
  process.env.SWEEP_HOURS = opts.hours;
}
if (opts.minAge !== undefined) {
  if (!/^\d+$/.test(opts.minAge)) fail(`--min-age ${opts.minAge} is not a number`);
  process.env.SWEEP_MIN_AGE_MINUTES = opts.minAge;
}
if (opts.max !== undefined) {
  if (!/^\d+$/.test(opts.max)) fail(`--max ${opts.max} is not a number`);
  process.env.SWEEP_MAX_FIXES = opts.max;
}

const { sweep } = require('../jobs/sweep-missing-packdates');

console.log('store   :', process.env.SHOPIFY_STORE || 'MISSING');
console.log('window  :', `last ${process.env.SWEEP_HOURS || 24}h`);
console.log('min age :', `${process.env.SWEEP_MIN_AGE_MINUTES || 10} minute(s)`);
console.log('max fix :', process.env.SWEEP_MAX_FIXES || 25);
console.log('');

sweep()
  .then((out) => {
    // A pass that could not fix everything it found is not a success, so say so
    // in the exit code — this is the check something else may be watching.
    if (out && (out.failed || out.candidates > out.fixed)) process.exitCode = 1;
  })
  .catch((err) => {
    console.error('\nERROR:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    // The sweep clears retry flags when a DB is configured, which opens a pool.
    if (process.env.DATABASE_URL) {
      try {
        await require('../db').pool.end();
      } catch {
        // Nothing to close, or already closed.
      }
    }
  });
