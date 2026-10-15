// SHARED FILE: keep identical in canteen-student and canteen-backoffice.
// Login sessions use a signed JWT stored in an httpOnly cookie.
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const { HttpError, asyncHandler } = require('./util');
const { normalizeTempPassword } = require('./accounts');

const COOKIE_NAME = process.env.COOKIE_NAME || 'canteen_session';
const SESSION_HOURS = 12;

if (!process.env.JWT_SECRET) {
  console.error('ERROR: JWT_SECRET is not set. Add a long random string to your environment variables.');
  process.exit(1);
}

function setSessionCookie(res, user) {
  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: `${SESSION_HOURS}h`,
  });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production', // Render serves HTTPS
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

const PASSWORD_SETUP_PATHS = ['/api/auth/me', '/api/auth/change-password', '/api/auth/logout'];

// Middleware: require a logged-in user with one of the allowed roles.
// Loads the fresh user row on every request so deactivated accounts are blocked immediately.
function requireRole(...roles) {
  return asyncHandler(async (req, res, next) => {
    const token = req.cookies[COOKIE_NAME];
    if (!token) throw new HttpError(401, 'Please log in.');
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      throw new HttpError(401, 'Your session has expired. Please log in again.');
    }
    const { rows } = await pool.query(
      `SELECT id, login_id, full_name, role, balance_cents, consecutive_no_shows,
              total_no_shows, suspended_until, is_demo, is_active,
              must_change_password, password_changed_at
         FROM users WHERE id = $1`,
      [payload.id]
    );
    const user = rows[0];
    if (!user || !user.is_active) throw new HttpError(401, 'Account not found or disabled.');
    if (!roles.includes(user.role)) throw new HttpError(403, 'You do not have access to this page.');
    // Logged in with a temporary password: only "who am I", "set new password" and "log out" work.
    if (user.must_change_password && !PASSWORD_SETUP_PATHS.includes(req.originalUrl.split('?')[0])) {
      const err = new HttpError(403, 'Please set your own password first.');
      err.extra = { must_change_password: true };
      throw err;
    }
    req.user = user;
    next();
  });
}

// Check credentials. Returns the user row or throws 401.
async function verifyLogin(loginId, password, allowedRoles) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE LOWER(login_id) = LOWER($1)',
    [String(loginId || '').trim()]
  );
  const user = rows[0];
  let ok = user && (await bcrypt.compare(String(password || ''), user.password_hash));
  // Temporary passwords are forgiving about case, spaces and the dash ("k7m3 qd9p" works).
  if (user && !ok && user.must_change_password) {
    const normalized = normalizeTempPassword(password);
    if (normalized) ok = await bcrypt.compare(normalized, user.password_hash);
  }
  if (!ok) throw new HttpError(401, 'Incorrect ID or password.');
  // Only revealed after the correct password, so it can't be used to probe accounts.
  if (!user.is_active) throw new HttpError(403, 'This account has been disabled. Please see the canteen admin.');
  if (!allowedRoles.includes(user.role)) {
    throw new HttpError(403, 'This account cannot sign in here. Use the correct app for your role.');
  }
  return user;
}

module.exports = { setSessionCookie, clearSessionCookie, requireRole, verifyLogin };
