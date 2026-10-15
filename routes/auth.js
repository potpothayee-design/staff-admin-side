const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const { setSessionCookie, clearSessionCookie, requireRole, verifyLogin } = require('../lib/auth');
const { HttpError, asyncHandler, getSettings, requireFields } = require('../lib/util');

const router = express.Router();
const BACKOFFICE_ROLES = ['staff', 'cashier', 'admin'];
const HOME = { staff: '/staff.html', cashier: '/cashier.html', admin: '/admin.html' };

router.post('/login', asyncHandler(async (req, res) => {
  const user = await verifyLogin(req.body.login_id, req.body.password, BACKOFFICE_ROLES);
  setSessionCookie(res, user);
  res.json({ ok: true, role: user.role, home: HOME[user.role] });
}));

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireRole(...BACKOFFICE_ROLES), asyncHandler(async (req, res) => {
  const s = await getSettings();
  res.json({
    id: req.user.id,
    login_id: req.user.login_id,
    full_name: req.user.full_name,
    role: req.user.role,
    home: HOME[req.user.role],
    student_app_url: process.env.STUDENT_APP_URL || '',
    settings: s,
  });
}));

router.post('/change-password', requireRole(...BACKOFFICE_ROLES), asyncHandler(async (req, res) => {
  requireFields(req.body, ['current_password', 'new_password']);
  if (String(req.body.new_password).length < 8) throw new HttpError(400, 'New password must be at least 8 characters.');
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(String(req.body.current_password), rows[0].password_hash))) {
    throw new HttpError(400, 'Current password is incorrect.');
  }
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
    await bcrypt.hash(String(req.body.new_password), 10), req.user.id,
  ]);
  res.json({ ok: true });
}));

module.exports = router;
