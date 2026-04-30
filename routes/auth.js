const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db');

const router = express.Router();

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

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'أدخل اسم المستخدم وكلمة المرور' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }

  req.session.user = { id: user.id, username: user.username, role: user.role || 'admin', province: user.province || null };
  res.json({ username: user.username, role: user.role || 'admin', province: user.province || null });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.post('/change-password', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'غير مصرح' });
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);

  if (!bcrypt.compareSync(oldPassword, user.password)) {
    return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, user.id);
  res.json({ ok: true });
});

module.exports = router;
