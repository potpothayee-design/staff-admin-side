// Canteen Pre-Order System: BACK-OFFICE APP (Staff, School Cashier, Admin)
// One app, three roles: the account's role decides which screen it opens.
require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { initDatabase } = require('./db/init');
const { pool } = require('./db/pool');
const { errorHandler } = require('./lib/util');
const { sweepMiddleware, startSweepTimer } = require('./lib/maintenance');

const app = express();
app.set('trust proxy', 1); // Render runs behind a proxy (needed for secure cookies)
app.use(express.json({ limit: '1mb' })); // menu photos are resized in the browser first
app.use(cookieParser());

app.get('/healthz', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});

// Until the database setup finishes, answer API calls with "starting up" instead of failing.
let dbReady = false;
app.use('/api', (req, res, next) => {
  if (dbReady) return next();
  res.status(503).json({ error: 'The server is starting up. Please try again in a few seconds.' });
});
app.use('/api', sweepMiddleware);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/students', require('./routes/students').router);
app.use('/api/staff', require('./routes/staff'));
app.use('/api/cashier', require('./routes/cashier'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use(errorHandler);

const PORT = process.env.PORT || 4000;

// Open the port FIRST so Render detects the service right away,
// then set up the database (retrying if the database is slow or still waking up).
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Back-office app running on port ${PORT}`);
  setupDatabase();
});

async function setupDatabase(attempt = 1) {
  try {
    await initDatabase();
    dbReady = true;
    startSweepTimer();
    console.log('Database ready.');
  } catch (err) {
    console.error(`Database setup failed (attempt ${attempt}): ${err.message}`);
    if (!process.env.DATABASE_URL) return;
    const wait = Math.min(30, attempt * 5);
    console.error(`Retrying in ${wait} seconds... (check DATABASE_URL if this keeps happening)`);
    setTimeout(() => setupDatabase(attempt + 1), wait * 1000);
  }
}
