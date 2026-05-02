const express = require('express');
const bcrypt  = require('bcryptjs');
const fs      = require('fs');
const path    = require('path');
const { getDb } = require('../db');

const router = express.Router();

/* ── Active session tracker ─────────────────────────── */
const activeMap = new Map(); // userId -> { username, role, province, lastSeen }

/* ── Province save log ──────────────────────────────── */
const saveLogs = []; // { id, province, username, key, time }
let   saveLogId = 0;

/* ── Auth guard ──────────────────────────────────────── */
router.use((req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'غير مصرح' });
  const u = req.session.user;
  activeMap.set(u.id, {
    username: u.username,
    role:     u.role     || 'admin',
    province: u.province || null,
    lastSeen: Date.now(),
  });
  next();
});

const adminOnly = (req, res, next) => {
  const role = req.session.user.role || 'admin'; // NULL/undefined = old session = admin
  if (role !== 'admin') return res.status(403).json({ error: 'للأدمن فقط' });
  next();
};

/* ── Months ─────────────────────────────────────────── */

router.get('/months', (_req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, data, cfg, saved_at, expenses, attendance FROM months').all();
  const months = {};
  for (const row of rows) {
    months[row.key] = {
      data:       JSON.parse(row.data),
      cfg:        JSON.parse(row.cfg),
      savedAt:    row.saved_at || null,
      expenses:   row.expenses   ? JSON.parse(row.expenses)   : null,
      attendance: row.attendance ? JSON.parse(row.attendance) : null,
    };
  }
  res.json({ months });
});

router.put('/months/:key', (req, res) => {
  const { key } = req.params;
  const user = req.session.user;
  const db   = getDb();

  /* ── Province user: merge-only update ── */
  if (user.role === 'province') {
    const existing = db.prepare('SELECT * FROM months WHERE key = ?').get(key);
    if (!existing) return res.status(403).json({ error: 'الشهر غير موجود، تواصل مع الأدمن لإنشائه أولاً' });

    const existingData = JSON.parse(existing.data);
    const existingAtt  = existing.attendance ? JSON.parse(existing.attendance) : {};
    const prov         = user.province;
    const inData       = req.body.data       || {};
    const inAtt        = req.body.attendance || {};

    // Only update d1 / d2 / paid for engineers in their province
    const provEngIds = new Set((existingData[prov] || []).map(e => e.id));
    if (existingData[prov]) {
      existingData[prov] = existingData[prov].map(e => {
        const newE = (inData[prov] || []).find(ne => ne.id === e.id);
        if (!newE) return e;
        return { ...e, d1: newE.d1 ?? e.d1, d2: newE.d2 ?? e.d2, paid: newE.paid ?? e.paid };
      });
    }

    // Only update attendance for engineers in their province
    for (const [engId, attData] of Object.entries(inAtt)) {
      if (provEngIds.has(engId)) {
        existingAtt[engId] = attData;
      }
    }

    db.prepare('UPDATE months SET data = ?, attendance = ? WHERE key = ?')
      .run(JSON.stringify(existingData), JSON.stringify(existingAtt), key);

    // Log province save for admin notification
    saveLogs.push({ id: ++saveLogId, province: prov, username: user.username, key, time: Date.now() });
    if (saveLogs.length > 100) saveLogs.shift();

    return res.json({ ok: true });
  }

  /* ── Admin: full update ── */
  const { data, cfg, savedAt, expenses, attendance } = req.body;
  if (!data || !cfg) return res.status(400).json({ error: 'بيانات ناقصة' });

  db.prepare(`
    INSERT INTO months (key, data, cfg, saved_at, expenses, attendance) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      data       = excluded.data,
      cfg        = excluded.cfg,
      saved_at   = excluded.saved_at,
      expenses   = excluded.expenses,
      attendance = excluded.attendance
  `).run(key, JSON.stringify(data), JSON.stringify(cfg), savedAt || null,
         expenses   ? JSON.stringify(expenses)   : null,
         attendance ? JSON.stringify(attendance) : null);

  res.json({ ok: true });
});

router.delete('/months/:key', adminOnly, (req, res) => {
  getDb().prepare('DELETE FROM months WHERE key = ?').run(req.params.key);
  res.json({ ok: true });
});

/* Replace ALL months (import → replace mode) — admin only */
router.put('/data', adminOnly, (req, res) => {
  const { months } = req.body;
  if (!months) return res.status(400).json({ error: 'بيانات ناقصة' });

  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO months (key, data, cfg, saved_at, expenses, attendance) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      data       = excluded.data,
      cfg        = excluded.cfg,
      saved_at   = excluded.saved_at,
      expenses   = excluded.expenses,
      attendance = excluded.attendance
  `);

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM months').run();
    for (const [key, m] of Object.entries(months)) {
      insert.run(key, JSON.stringify(m.data), JSON.stringify(m.cfg), m.savedAt || null,
                 m.expenses   ? JSON.stringify(m.expenses)   : null,
                 m.attendance ? JSON.stringify(m.attendance) : null);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  res.json({ ok: true });
});

/* ── Org Chart — admin write ─────────────────────────── */

router.get('/org-chart', (_req, res) => {
  const row = getDb().prepare('SELECT data FROM org_chart WHERE id = 1').get();
  res.json({ data: row ? JSON.parse(row.data) : null });
});

router.put('/org-chart', adminOnly, (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'بيانات ناقصة' });
  getDb().prepare(`
    INSERT INTO org_chart (id, data) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data
  `).run(JSON.stringify(data));
  res.json({ ok: true });
});

/* ── Logo — admin write ──────────────────────────────── */

router.get('/logo', (_req, res) => {
  const row = getDb().prepare("SELECT value FROM app_config WHERE key = 'logo'").get();
  res.json({ logo: row ? row.value : null });
});

router.put('/logo', adminOnly, (req, res) => {
  const { logo } = req.body;
  getDb().prepare(`
    INSERT INTO app_config (key, value) VALUES ('logo', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(logo || null);
  res.json({ ok: true });
});

router.delete('/logo', adminOnly, (_req, res) => {
  getDb().prepare("DELETE FROM app_config WHERE key = 'logo'").run();
  res.json({ ok: true });
});

/* ── User management — admin only ───────────────────── */

router.get('/users', adminOnly, (_req, res) => {
  const users = getDb()
    .prepare("SELECT id, username, role, province FROM users WHERE role = 'province' ORDER BY province")
    .all();
  res.json({ users });
});

router.put('/users/:id/password', adminOnly, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  const hash = bcrypt.hashSync(password, 10);
  const result = getDb()
    .prepare("UPDATE users SET password = ?, must_change_password = 0 WHERE id = ? AND role = 'province'")
    .run(hash, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json({ ok: true });
});

router.post('/users', adminOnly, (req, res) => {
  const { username, password, province } = req.body;
  if (!username || !username.trim()) return res.status(400).json({ error: 'أدخل اسم المستخدم' });
  if (!password || password.length < 6)  return res.status(400).json({ error: 'كلمة المرور 6 أحرف على الأقل' });
  if (!province || !province.trim())      return res.status(400).json({ error: 'اختر المحافظة' });
  const db = getDb();
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (exists) return res.status(409).json({ error: 'اسم المستخدم موجود مسبقاً' });
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    "INSERT INTO users (username, password, role, province, must_change_password) VALUES (?, ?, 'province', ?, 1)"
  ).run(username.trim(), hash, province.trim());
  res.json({ ok: true, id: result.lastInsertRowid, username: username.trim(), province: province.trim() });
});

router.delete('/users/:id', adminOnly, (req, res) => {
  const result = getDb()
    .prepare("DELETE FROM users WHERE id = ? AND role = 'province'")
    .run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
  res.json({ ok: true });
});

/* ── Active users ────────────────────────────────────── */

router.get('/active-users', adminOnly, (_req, res) => {
  const THRESHOLD = 5 * 60 * 1000; // 5 minutes
  const now = Date.now();
  const active = [];
  for (const [id, s] of activeMap.entries()) {
    if (now - s.lastSeen < THRESHOLD) {
      active.push({ id, username: s.username, role: s.role, province: s.province, lastSeen: s.lastSeen });
    }
  }
  res.json({ users: active });
});

/* ── Province save logs ──────────────────────────────── */

router.get('/save-logs', adminOnly, (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const recent = saveLogs.filter(l => l.id > since).slice(-20);
  res.json({ logs: recent, lastId: saveLogId });
});

/* ── Server backups ──────────────────────────────────── */

const BACKUP_DIR = process.env.DB_PATH
  ? path.join(path.dirname(process.env.DB_PATH), 'backups')
  : path.join(__dirname, '..', 'backups');

router.get('/backups', adminOnly, (_req, res) => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return res.json({ backups: [] });
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: stat.size, time: stat.mtimeMs };
      })
      .sort((a, b) => b.time - a.time)
      .slice(0, 10);
    res.json({ backups: files });
  } catch { res.json({ backups: [] }); }
});

router.get('/backups/:file', adminOnly, (req, res) => {
  const file = path.basename(req.params.file); // prevent path traversal
  const full = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'ملف غير موجود' });
  res.download(full, file);
});

module.exports = router;
module.exports.BACKUP_DIR = BACKUP_DIR;
