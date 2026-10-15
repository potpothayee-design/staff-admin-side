// Canteen Admin: dashboards, menu & stock, slots & settings, wallets, suspensions, staff accounts.
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, withTransaction } = require('../db/pool');
const { requireRole } = require('../lib/auth');
const { STUDENT_FIELDS } = require('./students');
const { HttpError, asyncHandler, getSettings, pesosToCents, requireFields, TZ } = require('../lib/util');

const router = express.Router();
router.use(requireRole('admin'));

const LOCAL_DATE = (col) => `(${col} AT TIME ZONE '${TZ}')::date`;
const TODAY = `(now() AT TIME ZONE '${TZ}')::date`;
// Orders whose money is final: wallet orders once locked in (no-shows are forfeited, so they count),
// cash orders only once the cash was collected at pickup (status completed).
const SOLD = `(o.status IN ('preparing','ready','completed','no_show') AND (o.payment_method = 'wallet' OR o.status = 'completed'))`;

// =====================================================================
// Sales dashboard
// =====================================================================
router.get('/dashboard', asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);

  const { rows: [totals] } = await pool.query(
    `SELECT
       COALESCE(SUM(o.total_cents) FILTER (WHERE o.order_date = ${TODAY}), 0) AS today_cents,
       COUNT(*) FILTER (WHERE o.order_date = ${TODAY})::int AS today_orders,
       COALESCE(SUM(o.total_cents) FILTER (WHERE o.order_date > ${TODAY} - 7), 0) AS week_cents,
       COUNT(*) FILTER (WHERE o.order_date > ${TODAY} - 7)::int AS week_orders,
       COALESCE(SUM(o.total_cents) FILTER (WHERE o.order_date > ${TODAY} - $1::int), 0) AS period_cents,
       COUNT(*) FILTER (WHERE o.order_date > ${TODAY} - $1::int)::int AS period_orders
     FROM orders o WHERE ${SOLD}`,
    [days]
  );

  const { rows: daily } = await pool.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS date,
            COALESCE(SUM(o.total_cents), 0) AS sales_cents,
            COUNT(o.id)::int AS orders
       FROM generate_series(${TODAY} - ($1::int - 1), ${TODAY}, interval '1 day') d
       LEFT JOIN orders o ON o.order_date = d::date AND ${SOLD}
      GROUP BY d ORDER BY d`,
    [days]
  );

  const { rows: bestSellers } = await pool.query(
    `SELECT oi.item_name AS name, SUM(oi.quantity)::int AS quantity, SUM(oi.line_total_cents) AS revenue_cents
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE ${SOLD} AND o.order_date > ${TODAY} - $1::int
      GROUP BY oi.item_name ORDER BY quantity DESC LIMIT 8`,
    [days]
  );

  const { rows: peakHours } = await pool.query(
    `SELECT EXTRACT(HOUR FROM o.placed_at AT TIME ZONE '${TZ}')::int AS hour, COUNT(*)::int AS orders
       FROM orders o
      WHERE o.is_walk_in = FALSE AND o.status <> 'cancelled' AND o.order_date > ${TODAY} - $1::int
      GROUP BY hour ORDER BY hour`,
    [days]
  );

  const { rows: noShowRate } = await pool.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS date,
            COUNT(o.id) FILTER (WHERE o.status = 'no_show')::int AS no_shows,
            COUNT(o.id) FILTER (WHERE o.status IN ('completed','no_show'))::int AS finished
       FROM generate_series(${TODAY} - ($1::int - 1), ${TODAY}, interval '1 day') d
       LEFT JOIN orders o ON o.order_date = d::date AND o.is_walk_in = FALSE
      GROUP BY d ORDER BY d`,
    [days]
  );

  const { rows: [wallet] } = await pool.query(
    `SELECT
       COALESCE(SUM(amount_cents) FILTER (WHERE type IN ('topup','reversal') AND ${LOCAL_DATE('created_at')} > ${TODAY} - $1::int), 0) AS topups_cents,
       -COALESCE(SUM(amount_cents) FILTER (WHERE type IN ('purchase','refund') AND ${LOCAL_DATE('created_at')} > ${TODAY} - $1::int), 0) AS spending_cents,
       COALESCE(SUM(amount_cents) FILTER (WHERE type IN ('topup','reversal')), 0) AS topups_all_cents,
       -COALESCE(SUM(amount_cents) FILTER (WHERE type IN ('purchase','refund')), 0) AS spending_all_cents
     FROM wallet_transactions`,
    [days]
  );
  const { rows: [liab] } = await pool.query(
    `SELECT COALESCE(SUM(balance_cents), 0) AS total_balance_cents, COUNT(*)::int AS students
       FROM users WHERE role = 'student'`
  );

  const { rows: [waste] } = await pool.query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS items FROM waste_log WHERE ${LOCAL_DATE('created_at')} > ${TODAY} - $1::int`,
    [days]
  );

  res.json({ days, totals, daily, best_sellers: bestSellers, peak_hours: peakHours, no_show_rate: noShowRate,
             wallet: { ...wallet, ...liab }, waste });
}));

// =====================================================================
// Menu management
// =====================================================================
function menuFields(body) {
  const name = String(body.name || '').trim();
  const price = pesosToCents(body.price);
  if (!name) throw new HttpError(400, 'Item name is required.');
  if (!Number.isInteger(price) || price <= 0) throw new HttpError(400, 'Enter a valid price.');
  const photo = body.photo ? String(body.photo) : null;
  if (photo && photo.length > 400000) throw new HttpError(400, 'Photo is too large. Please use a smaller image.');
  const threshold = Number(body.low_stock_threshold ?? 10);
  return {
    name: name.slice(0, 100),
    description: String(body.description || '').trim().slice(0, 255),
    category: String(body.category || 'Meals').trim().slice(0, 50) || 'Meals',
    price_cents: price,
    photo,
    is_perishable: !!body.is_perishable,
    low_stock_threshold: Number.isInteger(threshold) && threshold >= 0 ? threshold : 10,
  };
}

router.get('/menu', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, category, price_cents, photo, is_perishable, stock,
            low_stock_threshold, is_active, updated_at
       FROM menu_items ORDER BY is_active DESC, category, name`
  );
  res.json(rows);
}));

router.post('/menu', asyncHandler(async (req, res) => {
  const f = menuFields(req.body);
  const stock = Number(req.body.stock ?? 0);
  if (!Number.isInteger(stock) || stock < 0) throw new HttpError(400, 'Starting stock must be 0 or more.');
  const { rows } = await pool.query(
    `INSERT INTO menu_items (name, description, category, price_cents, photo, is_perishable, low_stock_threshold, stock)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [f.name, f.description, f.category, f.price_cents, f.photo, f.is_perishable, f.low_stock_threshold, stock]
  );
  res.status(201).json(rows[0]);
}));

router.put('/menu/:id', asyncHandler(async (req, res) => {
  const f = menuFields(req.body);
  // keep_photo=true leaves the current photo untouched
  const keepPhoto = req.body.keep_photo === true;
  const { rowCount } = await pool.query(
    `UPDATE menu_items SET name=$1, description=$2, category=$3, price_cents=$4,
            photo = CASE WHEN $9 THEN photo ELSE $5 END,
            is_perishable=$6, low_stock_threshold=$7, updated_at=now()
      WHERE id = $8`,
    [f.name, f.description, f.category, f.price_cents, f.photo, f.is_perishable, f.low_stock_threshold,
     Number(req.params.id), keepPhoto]
  );
  if (!rowCount) throw new HttpError(404, 'Item not found.');
  res.json({ ok: true });
}));

// Discontinue / bring back
router.post('/menu/:id/active', asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query(
    'UPDATE menu_items SET is_active = $1, updated_at = now() WHERE id = $2', [!!req.body.is_active, Number(req.params.id)]
  );
  if (!rowCount) throw new HttpError(404, 'Item not found.');
  res.json({ ok: true });
}));

// Delete only if never ordered; otherwise it must be discontinued (keeps sales history intact).
router.delete('/menu/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const used = await pool.query(
    'SELECT 1 FROM order_items WHERE menu_item_id = $1 UNION SELECT 1 FROM waste_log WHERE menu_item_id = $1 LIMIT 1', [id]
  );
  if (used.rowCount) throw new HttpError(409, 'This item has order history, so it can only be discontinued, not deleted.');
  await pool.query('DELETE FROM menu_items WHERE id = $1', [id]);
  res.json({ ok: true });
}));

// Set today's stock quantity
router.post('/menu/:id/stock', asyncHandler(async (req, res) => {
  const stock = Number(req.body.stock);
  if (!Number.isInteger(stock) || stock < 0 || stock > 100000) throw new HttpError(400, 'Stock must be a whole number, 0 or more.');
  const { rowCount } = await pool.query(
    'UPDATE menu_items SET stock = $1, updated_at = now() WHERE id = $2', [stock, Number(req.params.id)]
  );
  if (!rowCount) throw new HttpError(404, 'Item not found.');
  res.json({ ok: true });
}));

// =====================================================================
// Restock dashboard
// =====================================================================
router.get('/restock', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.id, m.name, m.category, m.stock, m.low_stock_threshold, m.is_perishable,
            COALESCE(r.reserved, 0)::int AS reserved_today,
            COALESCE(sold.qty, 0)::int AS sold_7d
       FROM menu_items m
       LEFT JOIN (SELECT oi.menu_item_id, SUM(oi.quantity) AS reserved
                    FROM order_items oi JOIN orders o ON o.id = oi.order_id
                   WHERE o.order_date = ${TODAY} AND o.status IN ('placed','preparing','ready')
                   GROUP BY oi.menu_item_id) r ON r.menu_item_id = m.id
       LEFT JOIN (SELECT oi.menu_item_id, SUM(oi.quantity) AS qty
                    FROM order_items oi JOIN orders o ON o.id = oi.order_id
                   WHERE o.order_date > ${TODAY} - 7 AND ${SOLD}
                   GROUP BY oi.menu_item_id) sold ON sold.menu_item_id = m.id
      WHERE m.is_active = TRUE AND m.stock <= m.low_stock_threshold
      ORDER BY m.stock, m.name`
  );
  const { rows: waste } = await pool.query(
    `SELECT item_name, SUM(quantity)::int AS quantity FROM waste_log
      WHERE ${LOCAL_DATE('created_at')} > ${TODAY} - 7 GROUP BY item_name ORDER BY quantity DESC`
  );
  res.json({ out_of_stock: rows.filter((r) => r.stock === 0), low_stock: rows.filter((r) => r.stock > 0), waste_7d: waste });
}));

// =====================================================================
// Time slots & settings
// =====================================================================
router.get('/slots', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, label, to_char(start_time,'HH24:MI') AS start_time, to_char(end_time,'HH24:MI') AS end_time,
            cutoff_minutes, is_active FROM time_slots ORDER BY start_time`
  );
  res.json(rows);
}));

function slotFields(b) {
  const label = String(b.label || '').trim();
  if (!label) throw new HttpError(400, 'Slot name is required.');
  if (!/^\d{2}:\d{2}$/.test(b.start_time) || !/^\d{2}:\d{2}$/.test(b.end_time)) throw new HttpError(400, 'Enter start and end times.');
  if (b.end_time <= b.start_time) throw new HttpError(400, 'End time must be after start time.');
  const cutoff = Number(b.cutoff_minutes);
  if (!Number.isInteger(cutoff) || cutoff < 0 || cutoff > 600) throw new HttpError(400, 'Cutoff must be 0–600 minutes.');
  return [label.slice(0, 60), b.start_time, b.end_time, cutoff, b.is_active !== false];
}

router.post('/slots', asyncHandler(async (req, res) => {
  const f = slotFields(req.body);
  const { rows } = await pool.query(
    'INSERT INTO time_slots (label, start_time, end_time, cutoff_minutes, is_active) VALUES ($1,$2,$3,$4,$5) RETURNING id', f
  );
  res.status(201).json(rows[0]);
}));

router.put('/slots/:id', asyncHandler(async (req, res) => {
  const f = slotFields(req.body);
  const { rowCount } = await pool.query(
    'UPDATE time_slots SET label=$1, start_time=$2, end_time=$3, cutoff_minutes=$4, is_active=$5 WHERE id=$6',
    [...f, Number(req.params.id)]
  );
  if (!rowCount) throw new HttpError(404, 'Slot not found.');
  res.json({ ok: true });
}));

const SETTING_RULES = {
  cancel_window_minutes: (v) => Number.isInteger(+v) && +v >= 1 && +v <= 60,
  no_show_limit: (v) => Number.isInteger(+v) && +v >= 1 && +v <= 20,
  suspension_days: (v) => Number.isInteger(+v) && +v >= 1 && +v <= 60,
  lunch_end_time: (v) => /^\d{2}:\d{2}$/.test(v),
  max_topup_cents: (v) => Number.isInteger(+v) && +v >= 100,
  demo_balance_cents: (v) => Number.isInteger(+v) && +v >= 0,
  starting_balance_cents: (v) => Number.isInteger(+v) && +v >= 0 && +v <= 10000000,
};

router.get('/settings', asyncHandler(async (req, res) => res.json(await getSettings())));

router.put('/settings', asyncHandler(async (req, res) => {
  for (const [key, value] of Object.entries(req.body || {})) {
    if (!SETTING_RULES[key]) continue;
    if (!SETTING_RULES[key](String(value))) throw new HttpError(400, `Invalid value for ${key}.`);
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, String(value)]
    );
  }
  res.json(await getSettings());
}));

// =====================================================================
// Student wallets
// =====================================================================
router.get('/students/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [student] } = await pool.query(`SELECT ${STUDENT_FIELDS} FROM users WHERE id = $1 AND role = 'student'`, [id]);
  if (!student) throw new HttpError(404, 'Student not found.');
  const { rows: transactions } = await pool.query(
    `SELECT t.id, t.type, t.amount_cents, t.balance_after_cents, t.receipt_no, t.reason, t.created_at,
            o.order_code, p.full_name AS performed_by_name, p.role AS performed_by_role
       FROM wallet_transactions t
       LEFT JOIN orders o ON o.id = t.order_id
       LEFT JOIN users p ON p.id = t.performed_by
      WHERE t.student_id = $1 ORDER BY t.created_at DESC, t.id DESC LIMIT 300`,
    [id]
  );
  res.json({ student, transactions });
}));

async function adjustBalance(db, studentId, amountCents, type, reason, adminId) {
  const { rows: [s] } = await db.query(
    `SELECT id, balance_cents FROM users WHERE id = $1 AND role = 'student' FOR UPDATE`, [studentId]
  );
  if (!s) throw new HttpError(404, 'Student not found.');
  if (s.balance_cents + amountCents < 0) throw new HttpError(400, 'Adjustment would make the balance negative.');
  const { rows: [b] } = await db.query(
    'UPDATE users SET balance_cents = balance_cents + $1 WHERE id = $2 RETURNING balance_cents', [amountCents, studentId]
  );
  await db.query(
    `INSERT INTO wallet_transactions (student_id, type, amount_cents, balance_after_cents, performed_by, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [studentId, type, amountCents, b.balance_cents, adminId, reason]
  );
  return b.balance_cents;
}

router.post('/students/:id/adjust', asyncHandler(async (req, res) => {
  requireFields(req.body, ['amount', 'reason']);
  const amount = pesosToCents(req.body.amount);
  if (!Number.isInteger(amount) || amount === 0) throw new HttpError(400, 'Enter a non-zero amount (use minus for deductions).');
  const reason = String(req.body.reason).trim();
  if (reason.length < 3) throw new HttpError(400, 'A reason is required for every adjustment.');
  const balance = await withTransaction((db) =>
    adjustBalance(db, Number(req.params.id), amount, 'adjustment', `Admin adjustment: ${reason.slice(0, 200)}`, req.user.id));
  res.json({ ok: true, balance_cents: balance });
}));

router.post('/students/:id/reset-demo', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const balance = await withTransaction(async (db) => {
    const { rows: [s] } = await db.query('SELECT is_demo, balance_cents FROM users WHERE id = $1', [Number(req.params.id)]);
    if (!s || !s.is_demo) throw new HttpError(400, 'Only the demo account can be reset.');
    const diff = settings.demo_balance_cents - s.balance_cents;
    if (diff === 0) return s.balance_cents;
    return adjustBalance(db, Number(req.params.id), diff, 'demo_reset', 'Demo balance reset (presentation)', req.user.id);
  });
  res.json({ ok: true, balance_cents: balance });
}));

// =====================================================================
// Suspension overview
// =====================================================================
router.get('/suspensions', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${STUDENT_FIELDS},
            (SELECT MAX(no_show_at) FROM orders WHERE student_id = users.id AND status = 'no_show') AS last_no_show
       FROM users
      WHERE role = 'student' AND (suspended_until IS NOT NULL OR consecutive_no_shows > 0 OR total_no_shows > 0)
      ORDER BY (suspended_until IS NOT NULL) DESC, consecutive_no_shows DESC, total_no_shows DESC
      LIMIT 200`
  );
  const settings = await getSettings();
  res.json({ no_show_limit: settings.no_show_limit, suspension_days: settings.suspension_days, students: rows });
}));

// =====================================================================
// Accounts (staff / cashier / admin; students self-register)
// =====================================================================
router.get('/accounts', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, login_id, full_name, role, is_active, created_at FROM users
      WHERE role IN ('staff','cashier','admin') ORDER BY role, full_name`
  );
  res.json(rows);
}));

router.post('/accounts', asyncHandler(async (req, res) => {
  requireFields(req.body, ['login_id', 'full_name', 'role', 'password']);
  const role = req.body.role;
  if (!['staff', 'cashier', 'admin'].includes(role)) throw new HttpError(400, 'Invalid role.');
  const loginId = String(req.body.login_id).trim();
  if (!/^[A-Za-z0-9._-]{3,50}$/.test(loginId)) throw new HttpError(400, 'Username: 3–50 letters, numbers, dot, dash or underscore.');
  if (String(req.body.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  const exists = await pool.query('SELECT 1 FROM users WHERE LOWER(login_id) = LOWER($1)', [loginId]);
  if (exists.rowCount) throw new HttpError(409, 'That username is already taken.');
  const { rows } = await pool.query(
    `INSERT INTO users (login_id, full_name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [loginId, String(req.body.full_name).trim().slice(0, 120), role, await bcrypt.hash(String(req.body.password), 10)]
  );
  res.status(201).json(rows[0]);
}));

router.post('/accounts/:id/password', asyncHandler(async (req, res) => {
  if (String(req.body.password || '').length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
  const { rowCount } = await pool.query(
    'UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(String(req.body.password), 10), Number(req.params.id)]
  );
  if (!rowCount) throw new HttpError(404, 'Account not found.');
  res.json({ ok: true });
}));

router.post('/accounts/:id/active', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'You cannot disable your own account.');
  const { rowCount } = await pool.query('UPDATE users SET is_active = $1 WHERE id = $2', [!!req.body.is_active, id]);
  if (!rowCount) throw new HttpError(404, 'Account not found.');
  res.json({ ok: true });
}));

module.exports = router;
