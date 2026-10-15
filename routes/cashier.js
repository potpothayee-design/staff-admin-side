// School Cashier: wallet top-ups, logged reversals, end-of-day report.
const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const { requireRole } = require('../lib/auth');
const bcrypt = require('bcryptjs');
const { HttpError, asyncHandler, getSettings, pesosToCents, requireFields, TZ } = require('../lib/util');
const { validateStudentInput, assertNotDuplicate, generateTempPassword } = require('../lib/accounts');

const router = express.Router();
router.use(requireRole('cashier'));

// ---------- New student account (only the School Cashier can create them) ----------
// The cashier checks the student's school ID card, then the account is created with the
// starting balance and a random temporary password the student must replace at first login.
router.post('/students', asyncHandler(async (req, res) => {
  if (req.body.id_checked !== true) {
    throw new HttpError(400, 'Check the student\'s school ID card first, then tick the box.');
  }
  const data = validateStudentInput(req.body);
  const settings = await getSettings();
  const startCents = Number(settings.starting_balance_cents) || 0;
  const tempPassword = generateTempPassword();
  const hash = await bcrypt.hash(tempPassword, 10);

  const student = await withTransaction(async (db) => {
    await assertNotDuplicate(db, data);
    const { rows: [u] } = await db.query(
      `INSERT INTO users (login_id, full_name, role, password_hash, balance_cents, must_change_password, created_by)
       VALUES ($1, $2, 'student', $3, $4, TRUE, $5)
       RETURNING id, login_id, full_name, balance_cents, created_at`,
      [data.schoolId, data.fullName, hash, startCents, req.user.id]
    );
    if (startCents > 0) {
      await db.query(
        `INSERT INTO wallet_transactions (student_id, type, amount_cents, balance_after_cents, performed_by, reason)
         VALUES ($1, 'adjustment', $2, $2, $3, 'Starting balance')`,
        [u.id, startCents, req.user.id]
      );
    }
    return u;
  });
  res.status(201).json({ student, temp_password: tempPassword, cashier: req.user.full_name });
}));

// ---------- Reset a student's password (forgot password) ----------
router.post('/students/:id/reset-password', asyncHandler(async (req, res) => {
  const tempPassword = generateTempPassword();
  const { rows: [u] } = await pool.query(
    `UPDATE users SET password_hash = $1, must_change_password = TRUE
      WHERE id = $2 AND role = 'student' AND is_active
      RETURNING id, login_id, full_name`,
    [await bcrypt.hash(tempPassword, 10), Number(req.params.id)]
  );
  if (!u) throw new HttpError(404, 'Student not found or account disabled.');
  console.log(`Password reset for student ${u.login_id} by ${req.user.login_id}`);
  res.json({ student: u, temp_password: tempPassword, cashier: req.user.full_name });
}));

// ---------- Top up ----------
router.post('/topup', asyncHandler(async (req, res) => {
  requireFields(req.body, ['student_id', 'amount']);
  const amount = pesosToCents(req.body.amount);
  const settings = await getSettings();
  if (!Number.isInteger(amount) || amount < 100) throw new HttpError(400, 'Minimum top-up is ₱1.00.');
  if (amount > settings.max_topup_cents) {
    throw new HttpError(400, `Maximum single top-up is ₱${(settings.max_topup_cents / 100).toLocaleString('en-PH')}.`);
  }

  const receipt = await withTransaction(async (db) => {
    const { rows: [student] } = await db.query(
      `UPDATE users SET balance_cents = balance_cents + $1
        WHERE id = $2 AND role = 'student' AND is_active = TRUE
        RETURNING id, login_id, full_name, balance_cents`,
      [amount, Number(req.body.student_id)]
    );
    if (!student) throw new HttpError(404, 'Student not found or account disabled.');

    const { rows: [r] } = await db.query(
      `SELECT 'R' || to_char(now() AT TIME ZONE '${TZ}', 'YYYYMMDD') || '-' || lpad(nextval('receipt_seq')::text, 5, '0') AS no`
    );
    const { rows: [txn] } = await db.query(
      `INSERT INTO wallet_transactions (student_id, type, amount_cents, balance_after_cents, performed_by, receipt_no, reason)
       VALUES ($1, 'topup', $2, $3, $4, $5, 'Cash top-up at school cashier')
       RETURNING id, created_at`,
      [student.id, amount, student.balance_cents, req.user.id, r.no]
    );
    return {
      transaction_id: txn.id,
      receipt_no: r.no,
      created_at: txn.created_at,
      amount_cents: amount,
      new_balance_cents: student.balance_cents,
      student: { login_id: student.login_id, full_name: student.full_name },
      cashier: req.user.full_name,
    };
  });
  res.status(201).json(receipt);
}));

// Student's recent wallet entries (so the cashier can find a top-up to correct).
router.get('/student/:id/transactions', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.type, t.amount_cents, t.balance_after_cents, t.receipt_no, t.reason, t.created_at,
            t.reverses_txn_id, c.full_name AS performed_by_name,
            EXISTS (SELECT 1 FROM wallet_transactions r WHERE r.reverses_txn_id = t.id) AS is_reversed,
            ((t.created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date) AS is_today
       FROM wallet_transactions t
       LEFT JOIN users c ON c.id = t.performed_by
      WHERE t.student_id = $1
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT 30`,
    [Number(req.params.id)]
  );
  res.json(rows);
}));

// ---------- Correction: reverse a wrong top-up (never delete) ----------
router.post('/reverse', asyncHandler(async (req, res) => {
  requireFields(req.body, ['transaction_id', 'reason']);
  const reason = String(req.body.reason).trim().slice(0, 200);

  const result = await withTransaction(async (db) => {
    const { rows: [t] } = await db.query(
      `SELECT t.*, ((t.created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date) AS is_today
         FROM wallet_transactions t WHERE t.id = $1 FOR UPDATE`,
      [Number(req.body.transaction_id)]
    );
    if (!t || t.type !== 'topup') throw new HttpError(400, 'Only top-ups can be reversed by the cashier.');
    if (!t.is_today) throw new HttpError(400, 'Only today\'s top-ups can be reversed here. Ask the canteen admin for older corrections.');
    const already = await db.query('SELECT 1 FROM wallet_transactions WHERE reverses_txn_id = $1', [t.id]);
    if (already.rowCount) throw new HttpError(409, 'This top-up was already reversed.');

    const { rows: [student] } = await db.query(
      'SELECT id, balance_cents FROM users WHERE id = $1 FOR UPDATE', [t.student_id]
    );
    if (student.balance_cents < t.amount_cents) {
      throw new HttpError(409, 'The student has already spent part of this top-up, so it cannot be fully reversed. Ask the admin to make an adjustment.');
    }
    const { rows: [b] } = await db.query(
      'UPDATE users SET balance_cents = balance_cents - $1 WHERE id = $2 RETURNING balance_cents',
      [t.amount_cents, student.id]
    );
    await db.query(
      `INSERT INTO wallet_transactions (student_id, type, amount_cents, balance_after_cents, performed_by,
                                        receipt_no, reason, reverses_txn_id)
       VALUES ($1, 'reversal', $2, $3, $4, $5, $6, $7)`,
      [student.id, -t.amount_cents, b.balance_cents, req.user.id, t.receipt_no, `Reversal: ${reason}`, t.id]
    );
    return { ok: true, new_balance_cents: b.balance_cents };
  });
  res.json(result);
}));

// ---------- End-of-day report ----------
router.get('/report', asyncHandler(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const dateExpr = date ? '$1::date' : `(now() AT TIME ZONE '${TZ}')::date`;
  const params = date ? [date] : [];

  const { rows: [summary] } = await pool.query(
    `SELECT ${dateExpr} AS date,
            COUNT(*) FILTER (WHERE type = 'topup')::int                    AS topup_count,
            COALESCE(SUM(amount_cents) FILTER (WHERE type = 'topup'), 0)    AS topup_total_cents,
            COUNT(*) FILTER (WHERE type = 'reversal')::int                 AS reversal_count,
            COALESCE(SUM(amount_cents) FILTER (WHERE type = 'reversal'), 0) AS reversal_total_cents
       FROM wallet_transactions
      WHERE type IN ('topup','reversal') AND (created_at AT TIME ZONE '${TZ}')::date = ${dateExpr}`,
    params
  );
  summary.net_cash_cents = summary.topup_total_cents + summary.reversal_total_cents;

  const { rows: byCashier } = await pool.query(
    `SELECT c.full_name AS cashier, COUNT(*) FILTER (WHERE t.type = 'topup')::int AS topups,
            COALESCE(SUM(t.amount_cents), 0) AS net_cents
       FROM wallet_transactions t JOIN users c ON c.id = t.performed_by
      WHERE t.type IN ('topup','reversal') AND (t.created_at AT TIME ZONE '${TZ}')::date = ${dateExpr}
      GROUP BY c.full_name ORDER BY c.full_name`,
    params
  );

  const { rows: entries } = await pool.query(
    `SELECT t.id, t.type, t.amount_cents, t.receipt_no, t.reason, t.created_at,
            s.login_id, s.full_name AS student_name, c.full_name AS cashier
       FROM wallet_transactions t
       JOIN users s ON s.id = t.student_id
       LEFT JOIN users c ON c.id = t.performed_by
      WHERE t.type IN ('topup','reversal') AND (t.created_at AT TIME ZONE '${TZ}')::date = ${dateExpr}
      ORDER BY t.created_at DESC`,
    params
  );
  // New student accounts created that day (each one receives the starting balance).
  const { rows: newAccounts } = await pool.query(
    `SELECT u.login_id, u.full_name, u.created_at, c.full_name AS cashier,
            COALESCE((SELECT SUM(t.amount_cents) FROM wallet_transactions t
                       WHERE t.student_id = u.id AND t.reason = 'Starting balance'), 0) AS starting_cents
       FROM users u LEFT JOIN users c ON c.id = u.created_by
      WHERE u.role = 'student' AND u.created_by IS NOT NULL
        AND (u.created_at AT TIME ZONE '${TZ}')::date = ${dateExpr}
      ORDER BY u.created_at DESC`,
    params
  );
  summary.new_accounts = newAccounts.length;
  summary.starting_issued_cents = newAccounts.reduce((a, r) => a + Number(r.starting_cents), 0);
  res.json({ summary, by_cashier: byCashier, entries, new_accounts: newAccounts });
}));

module.exports = router;
