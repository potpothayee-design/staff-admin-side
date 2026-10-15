// SHARED FILE: keep identical in canteen-student and canteen-backoffice.
// PostgreSQL connection pool for Render.
require('dotenv').config();
const { Pool, types } = require('pg');

// Return BIGINT (e.g. COUNT/SUM results) as JS numbers instead of strings.
types.setTypeParser(20, (v) => parseInt(v, 10));
// Return DATE columns as plain 'YYYY-MM-DD' strings (no timezone shifting).
types.setTypeParser(1082, (v) => v);

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Render "External Database URL" (host ends with .render.com) needs SSL.
// Render "Internal Database URL" (used between Render services) does not.
// Override with DATABASE_SSL=true / false if needed.
function useSsl(url) {
  if (process.env.DATABASE_SSL === 'true') return true;
  if (process.env.DATABASE_SSL === 'false') return false;
  return /\.render\.com/.test(url);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 5, // two apps share one free database, so keep connections low
});

pool.on('error', (err) => console.error('Unexpected DB error:', err.message));

// Run a function inside a transaction. fn receives a client; throw to roll back.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
