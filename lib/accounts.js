// SHARED FILE: keep identical in canteen-student and canteen-backoffice.
// Student account rules: School ID format, names, duplicate check, temporary passwords,
// and the once-a-week password change limit.
// Student accounts are created ONLY by the School Cashier (after checking the school ID card).
const crypto = require('crypto');
const { HttpError } = require('./util');

// School ID format: NN-NN-NNNN (e.g. 04-23-0006).
const SCHOOL_ID_RE = /^\d{2}-\d{2}-\d{4}$/;
// Names: letters (incl. ñ, accents), spaces, dot, apostrophe, dash.
const NAME_RE = /^[\p{L}][\p{L} .'\-]*$/u;
// Students may change their own password once every 7 days.
const PASSWORD_CHANGE_DAYS = 7;
const MIN_PASSWORD = 6;

// Trim, collapse spaces; Title-Case it if typed in all lower or all upper case.
function cleanName(v) {
  let s = String(v || '').trim().replace(/\s+/g, ' ');
  if (s && (s === s.toLowerCase() || s === s.toUpperCase())) {
    s = s.toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  }
  return s;
}
// Comparison key: lowercase, no dots, single spaces.
const nameKey = (v) => String(v || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();

// Same middle name? A missing middle name matches anything (so "Juan Cruz" can't duplicate
// "Juan Reyes Cruz"), and an initial matches the full name ("R" = "Reyes").
function middleMatches(a, b) {
  if (!a || !b) return true;
  if (a === b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  return false;
}

// Validate the new-student form. Returns cleaned values or throws 400.
function validateStudentInput(body) {
  const schoolId = String(body.school_id || '').trim();
  const first = cleanName(body.first_name);
  const noMiddle = body.no_middle_name === true;
  const middle = noMiddle ? '' : cleanName(body.middle_name);
  const last = cleanName(body.last_name);

  if (!SCHOOL_ID_RE.test(schoolId)) {
    throw new HttpError(400, 'School ID must look like 04-23-0006 (2 digits, 2 digits, 4 digits).');
  }
  for (const [label, v] of [['First name', first], ['Last name', last]]) {
    if (!v) throw new HttpError(400, `${label} is required.`);
    if (v.length > 40 || !NAME_RE.test(v)) throw new HttpError(400, `${label} can only contain letters, spaces, dots, apostrophes and dashes.`);
  }
  if (!noMiddle) {
    if (!middle) throw new HttpError(400, 'Middle name is required. If the student has none, tick "No middle name".');
    if (middle.length > 40 || !NAME_RE.test(middle)) throw new HttpError(400, 'Middle name can only contain letters, spaces, dots, apostrophes and dashes.');
  }
  return { schoolId, first, middle, last, fullName: [first, middle, last].filter(Boolean).join(' ') };
}

// Throws 409 if the School ID is taken or an active student already has the same name.
// Call inside a transaction.
async function assertNotDuplicate(db, { schoolId, first, middle, last }) {
  // One account creation at a time, so two cashiers can't add the same student simultaneously.
  await db.query('SELECT pg_advisory_xact_lock(7240001)');

  const idTaken = await db.query('SELECT 1 FROM users WHERE LOWER(login_id) = LOWER($1)', [schoolId]);
  if (idTaken.rowCount) throw new HttpError(409, 'An account with this School ID already exists.');

  const fKey = nameKey(first), mKey = nameKey(middle), lKey = nameKey(last);
  const { rows } = await db.query(
    `SELECT login_id, full_name FROM users
      WHERE role = 'student' AND is_active
        AND LOWER(REGEXP_REPLACE(REPLACE(full_name, '.', ''), '\\s+', ' ', 'g')) LIKE $1`,
    [`${fKey}%${lKey}`]
  );
  const dup = rows.find((c) => {
    const k = nameKey(c.full_name);
    if (k === `${fKey} ${lKey}`) return middleMatches('', mKey);
    if (!k.startsWith(`${fKey} `) || !k.endsWith(` ${lKey}`)) return false;
    return middleMatches(k.slice(fKey.length + 1, k.length - lKey.length - 1).trim(), mKey);
  });
  if (dup) {
    throw new HttpError(409, `A student with this name already has an account (${dup.full_name}, ${dup.login_id}). Use Reset password instead if they forgot it.`);
  }
}

// Temporary password like "K7M3-QD9P" (no look-alike characters: 0/O, 1/I/L).
const TEMP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateTempPassword() {
  let s = '';
  for (let i = 0; i < 8; i++) s += TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
// Forgiving form of a typed temporary password: "k7m3 qd9p" / "K7M3QD9P" -> "K7M3-QD9P".
function normalizeTempPassword(input) {
  const s = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
}

// When may this student change their password again? (null = now)
function nextPasswordChangeAt(user) {
  if (user.must_change_password || !user.password_changed_at) return null;
  const next = new Date(new Date(user.password_changed_at).getTime() + PASSWORD_CHANGE_DAYS * 86400000);
  return next > new Date() ? next : null;
}

module.exports = {
  SCHOOL_ID_RE, PASSWORD_CHANGE_DAYS, MIN_PASSWORD,
  validateStudentInput, assertNotDuplicate, generateTempPassword, normalizeTempPassword, nextPasswordChangeAt,
};
