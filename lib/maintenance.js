// SHARED FILE: keep identical in canteen-student and canteen-backoffice.
// Time-based rules that must happen "automatically":
//   1. Orders still "placed" after the cancel window → locked in as "preparing" (auto).
//   2. Suspensions whose end date has passed → lifted, consecutive no-show count reset.
//
// Render free web services sleep when idle, so a timer alone is not reliable.
// We therefore run these sweeps (a) on a timer and (b) before any request that reads
// orders/accounts. They are cheap UPDATE statements and safe to run from both apps.
const { pool } = require('../db/pool');

let lastRun = 0;

async function runSweeps(force = false) {
  const now = Date.now();
  if (!force && now - lastRun < 3000) return; // at most every 3 seconds per app
  lastRun = now;

  await pool.query(
    `UPDATE orders
        SET status = 'preparing', locked_at = cancel_deadline, lock_method = 'auto'
      WHERE status = 'placed' AND cancel_deadline <= now()`
  );

  await pool.query(
    `UPDATE users
        SET suspended_until = NULL, consecutive_no_shows = 0
      WHERE suspended_until IS NOT NULL AND suspended_until <= now()`
  );
}

// Express middleware version.
function sweepMiddleware(req, res, next) {
  runSweeps().then(() => next()).catch(next);
}

function startSweepTimer() {
  setInterval(() => runSweeps(true).catch((e) => console.error('Sweep failed:', e.message)), 20000);
}

module.exports = { runSweeps, sweepMiddleware, startSweepTimer };
