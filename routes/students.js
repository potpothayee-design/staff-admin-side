// Student search (used by Staff, Cashier and Admin).
// Staff accounts never receive wallet balances: only the Cashier and Admin can see them.
const express = require('express');
const { pool } = require('../db/pool');
const { requireRole } = require('../lib/auth');
const { HttpError, asyncHandler } = require('../lib/util');

const router = express.Router();
router.use(requireRole('staff', 'cashier', 'admin'));

// Remove wallet information from the response when the viewer is canteen staff.
function forViewer(req, student) {
  if (req.user.role !== 'staff') return student;
  const { balance_cents, ...rest } = student;
  return rest;
}

const STUDENT_FIELDS = `id, login_id, full_name, balance_cents, consecutive_no_shows, total_no_shows,
  suspended_until, (suspended_until IS NOT NULL AND suspended_until > now()) AS is_suspended, is_demo, is_active`;

// GET /api/students/search?q=2026  (matches school ID or name)
router.get('/search', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const { rows } = await pool.query(
    `SELECT ${STUDENT_FIELDS} FROM users
      WHERE role = 'student' AND (login_id ILIKE $1 OR full_name ILIKE $1)
      ORDER BY (LOWER(login_id) = LOWER($2)) DESC, full_name
      LIMIT 20`,
    [`%${q}%`, q]
  );
  res.json(rows.map((r) => forViewer(req, r)));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${STUDENT_FIELDS} FROM users WHERE id = $1 AND role = 'student'`,
    [Number(req.params.id)]
  );
  if (!rows[0]) throw new HttpError(404, 'Student not found.');
  res.json(forViewer(req, rows[0]));
}));

module.exports = { router, STUDENT_FIELDS };
