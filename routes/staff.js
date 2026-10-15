// Canteen Staff: order queue, ready/complete, pickup lookup, end-of-lunch no-shows, walk-in sales.
const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const { requireRole } = require('../lib/auth');
const { HttpError, asyncHandler, getSettings, generateOrderCode, TZ } = require('../lib/util');

const router = express.Router();
router.use(requireRole('staff'));

const ORDER_SELECT = `
  SELECT o.id, o.order_code, o.status, o.total_cents, o.order_date, o.payment_method, o.is_walk_in,
         o.placed_at, o.cancel_deadline, o.locked_at, o.lock_method, o.ready_at, o.completed_at, o.no_show_at,
         o.slot_id, s.label AS slot_label,
         to_char(s.start_time, 'HH24:MI') AS slot_start,
         to_char(s.end_time, 'HH24:MI')   AS slot_end,
         u.login_id AS student_login_id, u.full_name AS student_name,
         (o.status IN ('preparing','ready') AND (
            o.order_date < (now() AT TIME ZONE '${TZ}')::date OR
            (o.order_date = (now() AT TIME ZONE '${TZ}')::date AND s.end_time < (now() AT TIME ZONE '${TZ}')::time)
         )) AS missed_slot,
         COALESCE(json_agg(json_build_object('name', oi.item_name, 'quantity', oi.quantity)
                  ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
    FROM orders o
    LEFT JOIN time_slots s ON s.id = o.slot_id
    LEFT JOIN users u ON u.id = o.student_id
    LEFT JOIN order_items oi ON oi.order_id = o.id`;
const GROUP = 'GROUP BY o.id, s.id, u.id';

// ---------- Live queue (today's pre-orders) ----------
router.get('/queue', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `${ORDER_SELECT}
      WHERE o.is_walk_in = FALSE
        AND o.order_date = (now() AT TIME ZONE '${TZ}')::date
        AND o.status IN ('placed','preparing','ready')
      ${GROUP}
      ORDER BY s.start_time, o.placed_at`
  );
  const { rows: [counts] } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
            COUNT(*) FILTER (WHERE status = 'no_show')::int   AS no_show,
            COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
       FROM orders WHERE order_date = (now() AT TIME ZONE '${TZ}')::date AND is_walk_in = FALSE`
  );
  res.json({ server_time: new Date().toISOString(), orders: rows, counts });
}));

// ---------- Mark Ready ----------
router.post('/orders/:id/ready', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'ready', ready_at = now()
      WHERE id = $1 AND status = 'preparing' RETURNING id`,
    [Number(req.params.id)]
  );
  if (!rows[0]) throw new HttpError(409, 'Only orders that are "Preparing" can be marked ready.');
  res.json({ ok: true });
}));

// ---------- Verify & Release (Completed) ----------
router.post('/orders/:id/complete', asyncHandler(async (req, res) => {
  const result = await withTransaction(async (db) => {
    const { rows: [order] } = await db.query(
      `UPDATE orders SET status = 'completed', completed_at = now(),
              ready_at = COALESCE(ready_at, now()), handled_by = $2
        WHERE id = $1 AND status IN ('preparing','ready')
        RETURNING id, student_id, is_walk_in`,
      [Number(req.params.id), req.user.id]
    );
    if (!order) throw new HttpError(409, 'This order cannot be completed (it may be cancelled, still cancellable, or already done).');
    // A completed pre-order resets the consecutive no-show count.
    if (order.student_id && !order.is_walk_in) {
      await db.query('UPDATE users SET consecutive_no_shows = 0 WHERE id = $1 AND suspended_until IS NULL', [order.student_id]);
    }
    return { ok: true };
  });
  res.json(result);
}));

// ---------- Lookup by order code / QR ----------
router.get('/lookup/:code', asyncHandler(async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const { rows } = await pool.query(`${ORDER_SELECT} WHERE o.order_code = $1 ${GROUP}`, [code]);
  if (!rows[0]) throw new HttpError(404, `No order found with code ${code}.`);
  res.json(rows[0]);
}));

// ---------- End-of-lunch: unclaimed orders ----------
router.get('/unclaimed', asyncHandler(async (req, res) => {
  const s = await getSettings();
  const { rows } = await pool.query(
    `${ORDER_SELECT}
      WHERE o.is_walk_in = FALSE AND o.status IN ('preparing','ready')
        AND (o.order_date < (now() AT TIME ZONE '${TZ}')::date OR
             (o.order_date = (now() AT TIME ZONE '${TZ}')::date AND s.end_time < (now() AT TIME ZONE '${TZ}')::time))
      ${GROUP}
      ORDER BY o.order_date, s.start_time`
  );
  const { rows: [t] } = await pool.query(
    `SELECT (now() AT TIME ZONE '${TZ}')::time >= $1::time AS after_lunch`, [s.lunch_end_time]
  );
  res.json({ lunch_end_time: s.lunch_end_time, after_lunch: t.after_lunch, orders: rows });
}));

// Mark one order as No-Show inside an existing transaction.
async function markNoShow(db, orderId, staffId, settings) {
  const { rows: [order] } = await db.query(
    `UPDATE orders SET status = 'no_show', no_show_at = now(), handled_by = $2
      WHERE id = $1 AND status IN ('preparing','ready') AND is_walk_in = FALSE
      RETURNING id, order_code, student_id`,
    [orderId, staffId]
  );
  if (!order) return null;

  // Non-perishables back to stock; perishables logged as waste.
  const { rows: items } = await db.query(
    `SELECT oi.menu_item_id, oi.item_name, oi.quantity, m.is_perishable
       FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id
      WHERE oi.order_id = $1`,
    [order.id]
  );
  let restocked = 0, wasted = 0;
  for (const it of items) {
    if (it.is_perishable) {
      await db.query(
        'INSERT INTO waste_log (menu_item_id, item_name, quantity, order_id, logged_by) VALUES ($1,$2,$3,$4,$5)',
        [it.menu_item_id, it.item_name, it.quantity, order.id, staffId]
      );
      wasted += it.quantity;
    } else {
      await db.query('UPDATE menu_items SET stock = stock + $1, updated_at = now() WHERE id = $2', [it.quantity, it.menu_item_id]);
      restocked += it.quantity;
    }
  }

  // Strike +1; suspend after N consecutive no-shows.
  const { rows: [student] } = await db.query(
    `UPDATE users SET consecutive_no_shows = consecutive_no_shows + 1, total_no_shows = total_no_shows + 1
      WHERE id = $1 RETURNING consecutive_no_shows, suspended_until`,
    [order.student_id]
  );
  let suspended = false;
  if (student.consecutive_no_shows >= settings.no_show_limit &&
      !(student.suspended_until && new Date(student.suspended_until) > new Date())) {
    await db.query(
      `UPDATE users SET suspended_until = now() + make_interval(days => $2) WHERE id = $1`,
      [order.student_id, settings.suspension_days]
    );
    suspended = true;
  }
  return { order_code: order.order_code, restocked, wasted, strikes: student.consecutive_no_shows, suspended };
}

router.post('/orders/:id/no-show', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const result = await withTransaction((db) => markNoShow(db, Number(req.params.id), req.user.id, settings));
  if (!result) throw new HttpError(409, 'Only unclaimed "Preparing" or "Ready" pre-orders can be marked No-Show.');
  res.json(result);
}));

router.post('/no-show-all', asyncHandler(async (req, res) => {
  const ids = (Array.isArray(req.body.order_ids) ? req.body.order_ids : []).map(Number).filter(Boolean);
  if (!ids.length) throw new HttpError(400, 'No orders selected.');
  const settings = await getSettings();
  const results = await withTransaction(async (db) => {
    const out = [];
    for (const id of ids) {
      const r = await markNoShow(db, id, req.user.id, settings);
      if (r) out.push(r);
    }
    return out;
  });
  res.json({ count: results.length, results });
}));

// ---------- Walk-in sales ----------
router.get('/menu', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, category, price_cents, stock FROM menu_items WHERE is_active = TRUE ORDER BY category, name`
  );
  res.json(rows);
}));

router.post('/walk-in', asyncHandler(async (req, res) => {
  const method = req.body.payment_method;
  if (!['wallet', 'cash'].includes(method)) throw new HttpError(400, 'Choose wallet or cash.');
  const studentId = req.body.student_id ? Number(req.body.student_id) : null;
  if (method === 'wallet' && !studentId) throw new HttpError(400, 'Select the student to charge their wallet.');

  const qtyById = new Map();
  for (const it of Array.isArray(req.body.items) ? req.body.items : []) {
    const id = Number(it.menu_item_id), q = Number(it.quantity);
    if (!Number.isInteger(id) || !Number.isInteger(q) || q < 1) throw new HttpError(400, 'Invalid item.');
    qtyById.set(id, (qtyById.get(id) || 0) + q);
  }
  if (!qtyById.size) throw new HttpError(400, 'Add at least one item.');

  const result = await withTransaction(async (db) => {
    let student = null;
    if (studentId) {
      const r = await db.query(
        `SELECT id, full_name, balance_cents FROM users WHERE id = $1 AND role = 'student' FOR UPDATE`, [studentId]
      );
      student = r.rows[0];
      if (!student) throw new HttpError(404, 'Student not found.');
    }

    const ids = [...qtyById.keys()].sort((a, b) => a - b);
    const { rows: items } = await db.query(
      `SELECT id, name, price_cents, stock, is_active FROM menu_items WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [ids]
    );
    if (items.length !== ids.length || items.some((i) => !i.is_active)) throw new HttpError(400, 'An item is not available.');
    let total = 0;
    for (const it of items) {
      if (it.stock < qtyById.get(it.id)) throw new HttpError(409, `Only ${it.stock} left of ${it.name}.`);
      total += it.price_cents * qtyById.get(it.id);
    }
    if (method === 'wallet' && student.balance_cents < total) {
      throw new HttpError(402, `Insufficient wallet balance (₱${(student.balance_cents / 100).toFixed(2)}). Pay cash or top up at the school cashier.`);
    }

    for (const it of items) {
      await db.query('UPDATE menu_items SET stock = stock - $1, updated_at = now() WHERE id = $2', [qtyById.get(it.id), it.id]);
    }

    let order;
    for (let attempt = 0; attempt < 5 && !order; attempt++) {
      const r = await db.query(
        `INSERT INTO orders (order_code, student_id, order_date, total_cents, status, payment_method, is_walk_in,
                             placed_at, locked_at, completed_at, handled_by)
         VALUES ($1, $2, (now() AT TIME ZONE '${TZ}')::date, $3, 'completed', $4, TRUE, now(), now(), now(), $5)
         ON CONFLICT (order_code) DO NOTHING RETURNING id, order_code`,
        [generateOrderCode(), studentId, total, method, req.user.id]
      );
      order = r.rows[0];
    }
    for (const it of items) {
      const q = qtyById.get(it.id);
      await db.query(
        `INSERT INTO order_items (order_id, menu_item_id, item_name, unit_price_cents, quantity, line_total_cents)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [order.id, it.id, it.name, it.price_cents, q, it.price_cents * q]
      );
    }

    let balance = student ? student.balance_cents : null;
    if (method === 'wallet') {
      const { rows: [b] } = await db.query(
        'UPDATE users SET balance_cents = balance_cents - $1 WHERE id = $2 RETURNING balance_cents', [total, studentId]
      );
      balance = b.balance_cents;
      await db.query(
        `INSERT INTO wallet_transactions (student_id, type, amount_cents, balance_after_cents, order_id, performed_by, reason)
         VALUES ($1, 'purchase', $2, $3, $4, $5, $6)`,
        [studentId, -total, balance, order.id, req.user.id, `Walk-in purchase ${order.order_code}`]
      );
    }
    return { ok: true, order_code: order.order_code, total_cents: total, payment_method: method, balance_cents: balance };
  });
  res.status(201).json(result);
}));

module.exports = router;
