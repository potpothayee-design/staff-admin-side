// Student search + read-only balance lookup (used by Staff, Cashier and Admin).
const express = require('express');
const { pool } = require('../db/pool');
const { requireRole } = require('../lib/auth');
const { HttpError, asyncHandler } = require('../lib/util');

const router = express.Router();
router.use(requireRole('staff', 'cashier', 'admin'));

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
  res.json(rows);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${STUDENT_FIELDS} FROM users WHERE id = $1 AND role = 'student'`,
    [Number(req.params.id)]
  );
  if (!rows[0]) throw new HttpError(404, 'Student not found.');
  res.json(rows[0]);
}));

module.exports = { router, STUDENT_FIELDS };
