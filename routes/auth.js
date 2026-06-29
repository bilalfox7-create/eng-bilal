const express = require('express');
const bcrypt = require('bcryptjs');
const { get, run } = require('../db');

const router = express.Router();

/* ── Simple in-memory rate limiter (10 attempts / 15 min per IP) ── */
const loginAttempts = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const WINDOW = 15 * 60 * 1000; // 15 minutes
  const MAX    = 10;
  let entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW };
    loginAttempts.set(ip, entry);
  }
  if (entry.count >= MAX) return false;
  entry.count++;
  return true;
}
function resetRateLimit(ip) {
  loginAttempts.delete(ip);
}
// Clean up old entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loginAttempts.entries()) {
    if (now > e.resetAt) loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000);

router.get('/me', (req, res) => {
  if (req.session.user) {
    res.json({
      username: req.session.user.username,
      role:     req.session.user.role     || 'admin',
      province: req.session.user.province || null,
    });
  } else {
    res.json({});
  }
});

router.post('/login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'عدد محاولات تسجيل الدخول تجاوز الحد — انتظر 15 دقيقة' });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'أدخل اسم المستخدم وكلمة المرور' });
  }

  const user = await get('SELECT * FROM users WHERE username = ?', [username.trim()]);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  if (user.active === 0) {
    return res.status(403).json({ error: 'هذا الحساب موقوف — برجاء مراجعة الإدارة' });
  }

  resetRateLimit(ip);
  req.session.user = { id: user.id, username: user.username, role: user.role || 'admin', province: user.province || null };
  res.json({
    username: user.username,
    role:     user.role || 'admin',
    province: user.province || null,
    mustChangePwd: !!user.must_change_password,
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.post('/change-password', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'غير مصرح' });
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل' });
  }

  const user = await get('SELECT * FROM users WHERE id = ?', [req.session.user.id]);

  if (!bcrypt.compareSync(oldPassword, user.password)) {
    return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  await run('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?', [hash, user.id]);
  res.json({ ok: true });
});

module.exports = router;
