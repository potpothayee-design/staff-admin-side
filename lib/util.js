// SHARED FILE: keep identical in canteen-student and canteen-backoffice.
const crypto = require('crypto');
const { pool } = require('../db/pool');

// All "today"/clock logic uses Philippine time, even though Render servers run in UTC.
const TZ = 'Asia/Manila';

// Error with an HTTP status code, thrown from route handlers.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Wrap async route handlers so thrown errors reach the error middleware.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Express error handler (last middleware).
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err.status) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large.' });
  // Postgres CHECK violation on balance/stock = someone else changed it first
  if (err.code === '23514') return res.status(409).json({ error: 'Not enough balance or stock. Please refresh and try again.' });
  if (err.code === '23505') return res.status(409).json({ error: 'That record already exists.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// Read all settings as an object with numbers where possible.
async function getSettings(db = pool) {
  const { rows } = await db.query('SELECT key, value FROM settings');
  const s = {};
  for (const r of rows) s[r.key] = /^-?\d+$/.test(r.value) ? Number(r.value) : r.value;
  return s;
}

// Short, unambiguous order code (no 0/O/1/I), e.g. "K7M3QD".
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateOrderCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  return out;
}

// Parse a peso amount from user input ("150", "150.50") into integer centavos.
function pesosToCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

function requireFields(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || String(body[f]).trim() === '') {
      throw new HttpError(400, `Missing field: ${f}`);
    }
  }
}

module.exports = { TZ, HttpError, asyncHandler, errorHandler, getSettings, generateOrderCode, pesosToCents, requireFields };
